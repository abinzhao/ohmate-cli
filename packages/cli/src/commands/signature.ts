/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command } from 'commander';
import { green, red, yellow } from 'colorette';
import fs from 'node:fs';
import path from 'node:path';
import json5 from 'json5';
import type { AuthInfo, GenerateCertificateResult } from '../signature';
import { DEFAULT_CFG } from '../signature/signature-tool.js';
import { KeyManager } from '../signature/key-manager.js';
import { ToolProvider } from '../toolchain';
import { Project } from '../utils/project.js';
import { projectSkillChecker } from '../skills/index.js';
import { AutoSignOptions } from '../signature/types.js';
import { getAutoSignProjectReqPermissions } from '../signature/acl-permission-manager.js';
import { registerDevice } from '../signature/device-manager.js';
import { resolveSignatureFilePaths } from '../signature/local-material.js';
import { aclPermissionsUsingWarn } from '../signature/acl-permission-warn.js';
import { EnvChecker } from '../signature/env-checker.js';
import { loginService } from '../auth';
import {
  telemetry,
  EventType,
  toTraceErrorCode,
  type CommandExecuted,
  type TrackMeasurement,
} from '../trace/index.js';

interface SignatureGenerateOptions {
  force?: boolean;
  teamId?: string;
  product?: string;
  type?: string;
}

interface SigningConfigMaterial {
  certpath: string;
  keyAlias: string;
  keyPassword: string;
  profile: string;
  signAlg: string;
  storeFile: string;
  storePassword: string;
}

interface SigningConfig {
  name: string;
  type: string;
  material: SigningConfigMaterial;
}

const MAX_PROFILE_SIZE = 5 * 1024 * 1024;

function readOrCreateProfile(profilePath: string): {
  app?: {
    signingConfigs?: SigningConfig[];
    products?: Array<{ name: string; signingConfig?: string }>;
  };
} {
  try {
    const stat = fs.statSync(profilePath);
    if (stat.size > MAX_PROFILE_SIZE) {
      throw new Error(
        `Profile file too large: ${stat.size} bytes (max ${MAX_PROFILE_SIZE} bytes): ${profilePath}`
      );
    }
    const content = fs.readFileSync(profilePath, 'utf-8');
    return json5.parse(content);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { app: { signingConfigs: [], products: [] } };
    }
    throw new Error(`Failed to read profile: ${profilePath}`, { cause: error });
  }
}

function ensureProfileStructure(profile: {
  app?: {
    signingConfigs?: SigningConfig[];
    products?: Array<{ name: string; signingConfig?: string }>;
  };
}): void {
  if (!profile.app) {
    profile.app = { signingConfigs: [], products: [] };
  }
  if (!profile.app.signingConfigs) {
    profile.app.signingConfigs = [];
  }
  if (!profile.app.products) {
    profile.app.products = [];
  }
}

async function encryptSigningPasswords(
  result: GenerateCertificateResult
): Promise<{ keyPassword: string; storePassword: string }> {
  if (result.keyPwd === result.storePassword) {
    const encrypted = await KeyManager.encryptedPassword(
      result.keyPwd,
      result.p12FilePath
    );
    return { keyPassword: encrypted, storePassword: encrypted };
  }

  const encryptedKeyPassword = await KeyManager.encryptedPassword(
    result.keyPwd,
    result.p12FilePath
  );
  const encryptedStorePassword = await KeyManager.encryptedPassword(
    result.storePassword,
    result.p12FilePath
  );

  return {
    keyPassword: encryptedKeyPassword,
    storePassword: encryptedStorePassword,
  };
}

async function writeSigningConfigToProject(
  projectRoot: string,
  result: GenerateCertificateResult,
  productName: string,
  type?: string
): Promise<void> {
  const profilePath = path.join(projectRoot, 'build-profile.json5');
  const profile = readOrCreateProfile(profilePath);
  ensureProfileStructure(profile);

  const configName =
    type === 'release'
      ? `${productName ?? 'default'}_release`
      : (productName ?? 'default');
  const { keyPassword, storePassword } = await encryptSigningPasswords(result);

  const signingConfig: SigningConfig = {
    name: configName,
    type: 'HarmonyOS',
    material: {
      certpath: result.cerFilePath,
      keyAlias: result.keyAlias,
      keyPassword,
      profile: result.profileFilePath,
      signAlg: DEFAULT_CFG.signAlg,
      storeFile: result.p12FilePath,
      storePassword,
    },
  };

  const existingIndex = profile.app?.signingConfigs?.findIndex(
    (config) => config.name === configName
  );

  if (existingIndex !== undefined && existingIndex >= 0) {
    profile.app!.signingConfigs![existingIndex] = signingConfig;
  } else {
    profile.app!.signingConfigs!.push(signingConfig);
  }

  const productIndex = profile.app?.products?.findIndex(
    (product) => product.name === productName
  );

  if (productIndex !== undefined && productIndex >= 0) {
    profile.app!.products![productIndex].signingConfig = configName;
  } else {
    profile.app!.products!.push({
      name: productName,
      signingConfig: configName,
    });
  }

  fs.writeFileSync(profilePath, json5.stringify(profile, null, 2), 'utf-8');
}

async function getAuthInfo(
  options: SignatureGenerateOptions
): Promise<AuthInfo> {
  const userInfo = await loginService.getUserInfo();
  const token = await loginService.refreshToken();
  if (!userInfo || !token) {
    throw new Error(
      'Failed to obtain login credentials. Run `devecocli auth login` again.'
    );
  }
  return {
    uid: userInfo.userId ?? '',
    teamId: options.teamId ?? userInfo.userId ?? '',
    accessToken: token.accessToken ?? '',
  };
}

const VALID_SIGN_TYPES = ['debug', 'release'];

async function handleSignatureCommand(
  options: SignatureGenerateOptions
): Promise<void> {
  const productName = options.product || 'default';

  if (options.type && !VALID_SIGN_TYPES.includes(options.type)) {
    throw new Error(
      `Invalid signing type '${options.type}'. Valid types: ${VALID_SIGN_TYPES.join(', ')}`
    );
  }

  /** 环境预检（检测失败时抛出错误，由上层进行打点后统一处理） */
  const checker = new EnvChecker();
  await checker.preflight({
    productName,
    teamId: options.teamId,
    type: options.type,
  });
  await projectSkillChecker.warnInvalidBundledLinks(Project.discover(process.cwd()).rootDir);
  console.log('Executing signature generate command');

  /** 判断是否重新生成签名材料（PKCS12 校验按需加载 node-forge） */
  const authInfo = await getAuthInfo(options);
  const toolProvider = await ToolProvider.new();
  const { ReGenerateSign } = await import('../signature/index.js');
  const { shouldRegenerate: needRegen } = await ReGenerateSign.shouldRegenerate(
    {
      force: options.force ?? false,
      teamId: authInfo.teamId,
      productName: options.product,
      type: options.type,
    },
    toolProvider
  );
  if (!needRegen) {
    console.log(green('Signature generation completed successfully.'));
    return;
  }

  const success = await generateAndWriteSigningConfig(
    options,
    authInfo,
    toolProvider
  );
  if (!success) {
    process.exitCode = 1;
  }
}

async function generateAndWriteSigningConfig(
  options: SignatureGenerateOptions,
  authInfo: AuthInfo,
  toolProvider: ToolProvider
): Promise<boolean> {
  if (options.type === 'release' && (await skipIfReleaseCertExists(options))) {
    return false;
  }
  const { generateCertificate } = await import('../signature/index.js');
  const { generateProfileFile } = await import('../signature/generate-profile.js');
  const result = await generateCertificate(
    authInfo,
    options.product,
    options.type
  );

  const autoSignOptions = getAutoSignOptions(
    options,
    authInfo,
    result,
    toolProvider
  );
  if (options.type !== 'release') {
    autoSignOptions.allDeviceIds = await registerDevice(
      authInfo,
      toolProvider.hdcPath
    );
  }

  try {
    await generateProfileFile(authInfo, autoSignOptions);
  } catch (e) {
    if (options.type === 'release') {
      return handleReleaseProfileFailure(options, result);
    }
    throw e;
  }

  const projectRoot = Project.discover(process.cwd()).rootDir;
  await writeSigningConfigToProject(
    projectRoot,
    result,
    options.product ?? 'default',
    options.type
  );
  console.log(
    green(
      `Signing config written to ${path.join(projectRoot, 'build-profile.json5')}`
    )
  );
  console.log(green('Signature generation completed successfully.'));
  return true;
}

async function handleReleaseProfileFailure(
  options: SignatureGenerateOptions,
  result: GenerateCertificateResult
): Promise<boolean> {
  const productName = options.product || 'default';
  const projectRoot = Project.discover(process.cwd()).rootDir;
  await writeSigningConfigToProject(
    projectRoot,
    result,
    productName,
    options.type
  );
  console.warn(
    yellow(
      `\nRelease certificate materials generated successfully, but the release Profile (.p7b) cannot be auto-generated.\n` +
        `Signing config (with encrypted p12 password) has been written to build-profile.json5.\n` +
        'Please go to AGC (https://developer.huawei.com/consumer/cn/doc/doccenter-deveco-studio/ide-publish-app#section1079214271414) to manually apply for a release Profile:\n' +
        '  1. Use the generated .csr file to apply for a release certificate\n' +
        '  2. Apply for and download the release Profile (.p7b)\n' +
        `  3. Set the profile path in the '${productName}_release' signing config in build-profile.json5\n` +
        `  4. Build with: devecocli build --assemble-type assembleHap --build-mode release --signing-config ${productName}_release\n` +
        `\nGenerated files:\n` +
        `  p12: ${result.p12FilePath}\n` +
        `  csr: ${result.csrFilePath}\n` +
        `  cer: ${result.cerFilePath}\n` +
        `\nSigning config '${productName}_release' written to ${path.join(projectRoot, 'build-profile.json5')}\n`
    )
  );
  return false;
}

async function skipIfReleaseCertExists(
  options: SignatureGenerateOptions
): Promise<boolean> {
  const projectRoot = Project.discover(process.cwd()).rootDir;
  const productName = options.product || 'default';
  const paths = await resolveSignatureFilePaths(
    productName,
    projectRoot,
    options.type
  );
  const certExists =
    fs.existsSync(paths.p12Path) &&
    fs.existsSync(paths.csrPath) &&
    fs.existsSync(paths.certPath);
  const profileExists = fs.existsSync(paths.profilePath);
  if (!certExists || profileExists) {
    return false;
  }
  console.warn(
    yellow(
      `\nRelease certificate materials already exist. Profile (.p7b) is still missing.\n` +
        'Please go to AGC (https://developer.huawei.com/consumer/cn/doc/doccenter-deveco-studio/ide-publish-app#section1079214271414) to manually apply for a release Profile:\n' +
        '  1. Use the generated .csr file to apply for a release certificate\n' +
        '  2. Apply for and download the release Profile (.p7b)\n' +
        `  3. Set the profile path in the '${productName}_release' signing config in build-profile.json5\n` +
        `  4. Build with: devecocli build --assemble-type assembleHap --build-mode release --signing-config ${productName}_release\n` +
        `\nExisting files:\n  p12: ${paths.p12Path}\n  csr: ${paths.csrPath}\n  cer: ${paths.certPath}\n`
    )
  );
  return true;
}

function getAutoSignOptions(
  options: SignatureGenerateOptions,
  authInfo: AuthInfo,
  certRes: GenerateCertificateResult,
  toolProvider: ToolProvider
): AutoSignOptions {
  const currentDir = process.cwd();
  const project = Project.discover(currentDir);
  const aclPermissionsSet = getAutoSignProjectReqPermissions(
    project,
    toolProvider
  );
  aclPermissionsUsingWarn(aclPermissionsSet, project);

  return {
    productName: options.product || 'default',
    bundleName: project.getBundleName(options.product || 'default'),
    projectPath: project.rootDir,
    teamId: authInfo.teamId,
    force: options.force || false,
    aclPermissionList: [...aclPermissionsSet],
    certIds: [certRes.certId],
    keyAlias: certRes.keyAlias,
    keyPwd: certRes.keyPwd,
    type: options.type || 'debug',
  };
}

const signatureCommand = new Command('signature').description(
  'Generate application signature.'
);

signatureCommand
  .command('generate')
  .description(
    'Automatically generate signing materials and write them to the project configuration.'
  )
  .option('--force', 'Force overwrite existing local signing materials.')
  .option('--team-id <team-id>', 'Specify the team ID to use.')
  .option(
    '--product <product>',
    'Specify the product. The default value is default.'
  )
  .option('--type <type>', 'Signing type: debug or release (default: debug)')
  .action(async (options: SignatureGenerateOptions) => {
    const event: CommandExecuted = {
      event: EventType.CommandExecuted,
      args: [
        'signature',
        'generate',
        ...(options.force ? ['--force'] : []),
        ...(options.teamId ? ['--team-id'] : []),
        ...(options.product ? ['--product'] : []),
        ...(options.type ? ['--type'] : []),
      ],
    };
    const start = Date.now();
    let success = true;
    let errorCode: string | null = null;
    try {
      await handleSignatureCommand(options);
    } catch (error) {
      success = false;
      errorCode = toTraceErrorCode(error);
      console.error(red((error as Error).message));
      process.exitCode = 1;
    } finally {
      const measurement: TrackMeasurement = {
        duration_ms: Date.now() - start,
        success,
        error_code: errorCode,
      };
      await telemetry.track(event, measurement);
    }
  });

export default signatureCommand;
