/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import crypto from 'crypto';
import fs from 'fs';
import * as path from 'path';
import json5 from 'json5';
import { execa } from 'execa';
import { Project } from '../utils/project.js';
import { debugLog } from '../utils/logger.js';
import { ToolProvider } from '../toolchain/index.js';
import { getAutoSignFilePath } from './signature-tool.js';
import { KeyManager } from './key-manager.js';
import { getAutoSignProjectReqPermissions } from './acl-permission-manager.js';

// ═══════════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════════

/** shouldRegenerate() 入参。CLI 命令层传入 4 项（force / teamId / productName? / type?） */
export interface ReGenerateSignParams {
  force: boolean;
  teamId: string;
  /** CLI --product（可选，未指定时默认 "default"） */
  productName?: string;
  /** CLI --type（可选，'debug' | 'release'，影响签名材料文件路径） */
  type?: string;
}

/** shouldRegenerate() 返回值。shouldRegenerate=false → 材料有效，跳过签名流程。 */
export interface ReGenerateSignResult {
  shouldRegenerate: boolean;
  reason: string;
  checkDetails: ReGenerateCheckDetails;
}

/** 11 条件（C0–C10）逐项明细（短路时未到达项为 false） */
export interface ReGenerateCheckDetails {
  force: boolean;
  allFilesExist: boolean;
  missingFiles: string[];
  profileContentNotEmpty: boolean;
  profileNotExpired: boolean;
  bundleNameMatched: boolean;
  teamIdMatched: boolean;
  allDevicesInProfile: boolean;
  missingDeviceUdids: string[];
  aclMatched: boolean;
  cerMatched: boolean;
  cerNotExpired: boolean;
  storePasswordValid: boolean;
}

/** 四种签名材料文件路径 */
interface AutoSignMaterialPaths {
  storeFile: string;
  csrFile: string;
  cerFile: string;
  profileFile: string;
}

/** .p7b profile 解析结果。null 字段表示无法解析 → 对应条件判定"需要再生"。 */
interface ProfileParsedInfo {
  rawContent: string;
  bundleNameInProfile: string | null;
  expiryDate: Date | null;
  cerFingerprintInProfile: string | null;
  deviceUdidsInProfile: string[];
  aclPermissionsInProfile: string[];
  teamIdInProfile: string | null;
}

interface FileExistenceResult {
  allExist: boolean;
  missing: string[];
}

interface DeviceCoverageResult {
  allPresent: boolean;
  missing: string[];
}

// ═══════════════════════════════════════════════════════════════════
// HapSignTool — PKCS12 密码校验(node-forge) + .cer 证书链解析(Node crypto)
// ═══════════════════════════════════════════════════════════════════

class HapSignTool {
  /** 验证 .p12 密钥库密码（node-forge 解析 PKCS12，MAC 校验失败即密码错误） */
  async verifyStorePassword(storeFile: string, password: string): Promise<boolean> {
    try {
      const forge = (await import('node-forge')).default;
      const buf = fs.readFileSync(storeFile);
      const asn1 = forge.asn1.fromDer(buf.toString('binary'));
      forge.pkcs12.pkcs12FromAsn1(asn1, password);
      return true;
    } catch {
      return false;
    }
  }

  /** 从本地 .cer 提取全部证书指纹（SHA-256，大写冒号格式）。
   *  .cer 通常是证书链（多张 PEM），逐一解析；非 PEM（单张 DER）按单证书解析。 */
  getLocalCerFingerprints(cerFile: string): string[] {
    const content = fs.readFileSync(cerFile, 'utf-8');
    const pems = content.match(
      /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g
    );
    if (pems && pems.length > 0) {
      return pems.map((pem) =>
        this.formatFp(new crypto.X509Certificate(pem).fingerprint256)
      );
    }
    try {
      return [
        this.formatFp(
          new crypto.X509Certificate(fs.readFileSync(cerFile)).fingerprint256
        ),
      ];
    } catch {
      return [];
    }
  }

  /** 从本地 .cer 链中取与 profile 开发证书指纹匹配的那张的过期时间；无匹配返回 null */
  getLocalCerExpiry(
    cerFile: string,
    profileFp: string | null | undefined
  ): Date | null {
    if (!profileFp) {
      return null;
    }
    const content = fs.readFileSync(cerFile, 'utf-8');
    const pems =
      content.match(
        /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g
      ) ?? [];
    for (const pem of pems) {
      try {
        const cert = new crypto.X509Certificate(pem);
        if (this.formatFp(cert.fingerprint256) === profileFp) {
          const d = new Date(cert.validTo);
          return isNaN(d.getTime()) ? null : d;
        }
      } catch {
        // skip unparseable PEM
      }
    }
    return null;
  }

  /** 指纹格式化：去冒号 → 两位一组冒号重连（对齐 profile 侧 computePemFingerprint） */
  private formatFp(fp: string): string {
    const raw = fp.replace(/:/g, '');
    return raw.match(/.{2}/g)?.join(':') ?? raw;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Profile 解析 — .p7b 为 DER 二进制 PKCS7，内嵌 JSON（对齐 Java AutoSigningHandleService）
// ═══════════════════════════════════════════════════════════════════

/** 解析 .p7b profile 文件，从内嵌 JSON 提取结构化信息 */
function parseProfileContent(
  profileFile: string,
  type?: string
): ProfileParsedInfo {
  const rawContent = fs.readFileSync(profileFile, 'utf-8');
  const jsonStr = extractJsonObject(rawContent);
  let json: Record<string, unknown> | null = null;
  if (jsonStr) {
    try {
      json = JSON.parse(jsonStr) as Record<string, unknown>;
    } catch {
      json = null;
    }
  }
  const bundle = (json?.['bundle-info'] ?? {}) as Record<string, unknown>;
  const certField =
    type === 'release' ? 'distribution-certificate' : 'development-certificate';
  return {
    rawContent,
    bundleNameInProfile: asString(bundle['bundle-name']),
    expiryDate: parseUnixDate(
      (json?.validity as Record<string, unknown> | undefined)?.['not-after']
    ),
    cerFingerprintInProfile: computePemFingerprint(asString(bundle[certField])),
    deviceUdidsInProfile: normalizeUdids(
      (json?.['debug-info'] as Record<string, unknown> | undefined)?.[
        'device-ids'
      ]
    ),
    aclPermissionsInProfile: extractAcls(
      (json?.acls as Record<string, unknown> | undefined)?.['allowed-acls']
    ),
    teamIdInProfile: asString(bundle['developer-id']),
  };
}

/** 字符串感知的大括号深度匹配，从内容中切出首个完整 JSON 对象文本 */
function extractJsonObject(content: string): string | null {
  const start = content.indexOf('{');
  if (start < 0) {
    return null;
  }
  let depth = 0;
  let end = -1;
  let inStr = false;
  let esc = false;
  for (let i = start; i < content.length; i++) {
    const ch = content[i];
    if (inStr) {
      if (esc) {
        esc = false;
      } else if (ch === '\\') {
        esc = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  return end < 0 ? null : content.slice(start, end + 1);
}

/** validity.not-after（Unix 秒）→ Date；非有限数/解析失败返回 null */
function parseUnixDate(value: unknown): Date | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  const d = new Date(value * 1000);
  return isNaN(d.getTime()) ? null : d;
}

/** 从 PEM 文本计算证书指纹（SHA-256，大写冒号格式，对齐 HapSignTool.formatFp） */
function computePemFingerprint(pem: string | null): string | null {
  if (!pem) {
    return null;
  }
  try {
    const cert = new crypto.X509Certificate(pem);
    const raw = cert.fingerprint256.replace(/:/g, '');
    return raw.match(/.{2}/g)?.join(':') ?? raw;
  } catch {
    return null;
  }
}

/** device-ids 数组 → 去重大写化 */
function normalizeUdids(arr: unknown): string[] {
  if (!Array.isArray(arr)) {
    return [];
  }
  const out: string[] = [];
  for (const s of arr) {
    if (typeof s === 'string') {
      const u = s.toUpperCase();
      if (!out.includes(u)) {
        out.push(u);
      }
    }
  }
  return out;
}

/**
 * acls.allowed-acls → 权限名数组。
 * 兼容两种元素结构：纯字符串 "ohos.permission.X" 或对象 { name: "ohos.permission.X" }。
 */
function extractAcls(allowed: unknown): string[] {
  if (!Array.isArray(allowed)) {
    return [];
  }
  const out: string[] = [];
  for (const item of allowed) {
    if (typeof item === 'string') {
      out.push(item);
    } else if (
      item &&
      typeof item === 'object' &&
      typeof (item as Record<string, unknown>).name === 'string'
    ) {
      out.push((item as Record<string, string>).name);
    }
  }
  return [...new Set(out)].sort();
}

/** 安全取字符串字段，非字符串返回 null */
function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

// ═══════════════════════════════════════════════════════════════════
// ReGenerateSign 主类
// ═══════════════════════════════════════════════════════════════════

/** 检查上下文 — shouldRegenerate 内部传递的数据集合，避免每个检查方法重复声明形参 */
interface CheckContext {
  force: boolean;
  teamId: string;
  productName: string;
  projectPath: string;
  type?: string;
  materialPaths: AutoSignMaterialPaths;
  bundleName: string;
  deviceUdids: string[];
  storePassword: string | undefined;
  localAclPermissions: string[];
  hapSignTool: HapSignTool;
  profileInfo: ProfileParsedInfo | null;
}

/**
 * 11 条件（C0–C10）AND 短路求值，任意一条不满足即返回 shouldRegenerate=true。
 *
 * 每个检查拆为独立私有静态方法，通过 `??` 链串联：
 *   - null → 条件通过，继续下一个
 *   - ReGenerateSignResult → 条件不满足，短路返回
 *
 * @param params  CLI 传入的 3 项（force / teamId / productName?）
 * @param toolProvider 由 cli.ts 层面传入的已创建 ToolProvider 实例
 */
export class ReGenerateSign {
  static async shouldRegenerate(
    params: ReGenerateSignParams,
    toolProvider: ToolProvider
  ): Promise<ReGenerateSignResult> {
    const ctx = await ReGenerateSign.#prepareContext(params, toolProvider);

    return (
      ReGenerateSign.#checkForce(ctx) ??
      ReGenerateSign.#checkFilesExist(ctx) ??
      ReGenerateSign.#checkProfileNotEmpty(ctx) ??
      ReGenerateSign.#checkProfileNotExpired(ctx) ??
      ReGenerateSign.#checkBundleNameMatch(ctx) ??
      ReGenerateSign.#checkTeamIdMatch(ctx) ??
      (ctx.type === 'release'
        ? null
        : ReGenerateSign.#checkDeviceCoverage(ctx)) ??
      ReGenerateSign.#checkAclMatch(ctx) ??
      ReGenerateSign.#checkCerMatch(ctx) ??
      ReGenerateSign.#checkCerNotExpired(ctx) ??
      (await ReGenerateSign.#checkStorePassword(ctx)) ??
      ReGenerateSign.#allPassed()
    );
  }

  /** 收集所有检查所需的上下文数据 */
  static async #prepareContext(
    params: ReGenerateSignParams,
    toolProvider: ToolProvider
  ): Promise<CheckContext> {
    const force = params.force;
    const teamId = params.teamId;
    const productName = params.productName ?? 'default';
    const type = params.type;
    const project = Project.discover(process.cwd());
    const projectPath = project.rootDir;

    const [materialPaths, deviceUdids] = await Promise.all([
      buildMaterialPathsAsync(productName, projectPath, type),
      type === 'release'
        ? Promise.resolve([])
        : fetchDeviceUdids(toolProvider.hdcPath),
    ]);

    // 仅在文件完整时解析 profile，否则留 null（C1 会短路返回）
    let profileInfo: ProfileParsedInfo | null = null;
    if (checkAllFilesExist(materialPaths).allExist) {
      try {
        profileInfo = parseProfileContent(materialPaths.profileFile, type);
      } catch {
        /* 文件损坏等场景，后续检查会处理 */
      }
    }

    return {
      force,
      teamId,
      productName,
      projectPath,
      type,
      materialPaths,
      bundleName: project.getBundleName(productName),
      deviceUdids,
      storePassword: await readStorePassword(
        projectPath,
        productName,
        materialPaths.storeFile,
        type
      ),
      localAclPermissions: [
        ...getAutoSignProjectReqPermissions(project, toolProvider),
      ].sort(),
      hapSignTool: new HapSignTool(),
      profileInfo,
    };
  }

  /** C0: --force 短路 */
  static #checkForce(ctx: CheckContext): ReGenerateSignResult | null {
    if (!ctx.force) {
      return null;
    }
    debugLog('[reGenerateSign] --force flag set, skipping all checks');
    return {
      shouldRegenerate: true,
      reason: '--force flag set',
      checkDetails: buildCheckDetails({ force: true }),
    };
  }

  /** C1: 四种材料文件完整性 */
  static #checkFilesExist(ctx: CheckContext): ReGenerateSignResult | null {
    const fileCheck = checkAllFilesExist(ctx.materialPaths);
    if (fileCheck.allExist) {
      return null;
    }
    debugLog(`[reGenerateSign] missing files: ${fileCheck.missing.join(',')}`);
    return {
      shouldRegenerate: true,
      reason: `Missing files: ${fileCheck.missing.join(', ')}`,
      checkDetails: buildCheckDetails({
        allFilesExist: false,
        missingFiles: fileCheck.missing,
      }),
    };
  }

  /** C2: Profile 内容非空 */
  static #checkProfileNotEmpty(ctx: CheckContext): ReGenerateSignResult | null {
    const raw = ctx.profileInfo?.rawContent ?? '';
    if (raw.trim().length > 0) {
      return null;
    }
    debugLog('[reGenerateSign] profile content is empty');
    return {
      shouldRegenerate: true,
      reason: 'Profile file content is empty',
      checkDetails: buildCheckDetails({
        allFilesExist: true,
        profileContentNotEmpty: false,
      }),
    };
  }

  /** C3: Profile 未过期 */
  static #checkProfileNotExpired(
    ctx: CheckContext
  ): ReGenerateSignResult | null {
    const expiry = ctx.profileInfo?.expiryDate;
    if (!expiry || expiry >= new Date()) {
      return null;
    }
    debugLog(`[reGenerateSign] profile expired at ${expiry.toISOString()}`);
    return {
      shouldRegenerate: true,
      reason: `Profile expired at ${expiry.toISOString()}`,
      checkDetails: buildCheckDetails({
        allFilesExist: true,
        profileContentNotEmpty: true,
        profileNotExpired: false,
      }),
    };
  }

  /** C4: bundleName 匹配 */
  static #checkBundleNameMatch(ctx: CheckContext): ReGenerateSignResult | null {
    const profileBundle = ctx.profileInfo?.bundleNameInProfile;
    if (profileBundle && profileBundle === ctx.bundleName) {
      return null;
    }
    debugLog(
      `[reGenerateSign] bundleName mismatch — current=${ctx.bundleName}, profile=${profileBundle}`
    );
    return {
      shouldRegenerate: true,
      reason: `bundleName mismatch: current=${ctx.bundleName}, in profile=${profileBundle}`,
      checkDetails: buildCheckDetails({
        allFilesExist: true,
        profileContentNotEmpty: true,
        profileNotExpired: true,
        bundleNameMatched: false,
      }),
    };
  }

  /** C5: teamId 匹配 */
  static #checkTeamIdMatch(ctx: CheckContext): ReGenerateSignResult | null {
    const profileTeamId = ctx.profileInfo?.teamIdInProfile;
    if (profileTeamId && profileTeamId === ctx.teamId) {
      return null;
    }
    debugLog(
      `[reGenerateSign] teamId mismatch — current=${ctx.teamId}, profile=${profileTeamId}`
    );
    return {
      shouldRegenerate: true,
      reason: `teamId mismatch: current=${ctx.teamId}, in profile=${profileTeamId}`,
      checkDetails: buildCheckDetails({
        allFilesExist: true,
        profileContentNotEmpty: true,
        profileNotExpired: true,
        bundleNameMatched: true,
        teamIdMatched: false,
      }),
    };
  }

  /** C6: 所有已连接设备 UDID 在 profile 中 */
  static #checkDeviceCoverage(ctx: CheckContext): ReGenerateSignResult | null {
    const deviceCheck = profileContainsAllDevices(
      ctx.profileInfo?.deviceUdidsInProfile ?? [],
      ctx.deviceUdids
    );
    if (deviceCheck.allPresent) {
      return null;
    }
    debugLog(
      `[reGenerateSign] missing device UDIDs: ${deviceCheck.missing.join(',')}`
    );
    return {
      shouldRegenerate: true,
      reason: `Device UDID(s) not in profile: ${deviceCheck.missing.join(', ')}`,
      checkDetails: buildCheckDetails({
        allFilesExist: true,
        profileContentNotEmpty: true,
        profileNotExpired: true,
        bundleNameMatched: true,
        teamIdMatched: true,
        allDevicesInProfile: false,
        missingDeviceUdids: deviceCheck.missing,
      }),
    };
  }

  /** C7: ACL 权限匹配 */
  static #checkAclMatch(ctx: CheckContext): ReGenerateSignResult | null {
    if (
      areAclPermissionsMatched(
        ctx.localAclPermissions,
        ctx.profileInfo?.aclPermissionsInProfile ?? []
      )
    ) {
      return null;
    }
    debugLog('[reGenerateSign] ACL permissions mismatch');
    return {
      shouldRegenerate: true,
      reason: 'ACL permissions mismatch between project and profile',
      checkDetails: buildCheckDetails({
        allFilesExist: true,
        profileContentNotEmpty: true,
        profileNotExpired: true,
        bundleNameMatched: true,
        teamIdMatched: true,
        allDevicesInProfile: true,
        aclMatched: false,
      }),
    };
  }

  /** C8: profile 内证书与本地 .cer 匹配（.cer 为证书链，开发证书须在链中） */
  static #checkCerMatch(ctx: CheckContext): ReGenerateSignResult | null {
    const localFps = ctx.hapSignTool.getLocalCerFingerprints(
      ctx.materialPaths.cerFile
    );
    const profileFp = ctx.profileInfo?.cerFingerprintInProfile;
    if (profileFp && localFps.includes(profileFp)) {
      return null;
    }
    debugLog('[reGenerateSign] certificate mismatch');
    return {
      shouldRegenerate: true,
      reason: 'Certificate mismatch between profile and local .cer file',
      checkDetails: buildCheckDetails({
        allFilesExist: true,
        profileContentNotEmpty: true,
        profileNotExpired: true,
        bundleNameMatched: true,
        teamIdMatched: true,
        allDevicesInProfile: true,
        aclMatched: true,
        cerMatched: false,
      }),
    };
  }

  /** C9: 本地 .cer 中开发证书（叶子）未过期 */
  static #checkCerNotExpired(ctx: CheckContext): ReGenerateSignResult | null {
    const profileFp = ctx.profileInfo?.cerFingerprintInProfile;
    const cerExpiry = ctx.hapSignTool.getLocalCerExpiry(
      ctx.materialPaths.cerFile,
      profileFp
    );
    if (!cerExpiry || cerExpiry >= new Date()) {
      return null;
    }
    debugLog(
      `[reGenerateSign] local certificate expired at ${cerExpiry.toISOString()}`
    );
    return {
      shouldRegenerate: true,
      reason: `Local certificate expired at ${cerExpiry.toISOString()}`,
      checkDetails: buildCheckDetails({
        allFilesExist: true,
        profileContentNotEmpty: true,
        profileNotExpired: true,
        bundleNameMatched: true,
        teamIdMatched: true,
        allDevicesInProfile: true,
        aclMatched: true,
        cerMatched: true,
        cerNotExpired: false,
      }),
    };
  }

  /** C10: Keystore 密码有效性 */
  static async #checkStorePassword(
    ctx: CheckContext
  ): Promise<ReGenerateSignResult | null> {
    if (!ctx.storePassword) {
      debugLog('[reGenerateSign] no stored keystore password');
      return {
        shouldRegenerate: true,
        reason: 'No stored keystore password available for verification',
        checkDetails: buildCheckDetails({
          allFilesExist: true,
          profileContentNotEmpty: true,
          profileNotExpired: true,
          bundleNameMatched: true,
          teamIdMatched: true,
          allDevicesInProfile: true,
          aclMatched: true,
          cerMatched: true,
          cerNotExpired: true,
          storePasswordValid: false,
        }),
      };
    }
    const pwdValid = await ctx.hapSignTool.verifyStorePassword(
      ctx.materialPaths.storeFile,
      ctx.storePassword
    );
    if (pwdValid) {
      return null;
    }
    debugLog('[reGenerateSign] keystore password verification failed');
    return {
      shouldRegenerate: true,
      reason:
        'Keystore password verification failed (storeFile may be corrupted or password changed)',
      checkDetails: buildCheckDetails({
        allFilesExist: true,
        profileContentNotEmpty: true,
        profileNotExpired: true,
        bundleNameMatched: true,
        teamIdMatched: true,
        allDevicesInProfile: true,
        aclMatched: true,
        cerMatched: true,
        cerNotExpired: true,
        storePasswordValid: false,
      }),
    };
  }

  /** 全部通过 → 不重新生成 */
  static #allPassed(): ReGenerateSignResult {
    debugLog('[reGenerateSign] all checks passed — skip regeneration');
    return {
      shouldRegenerate: false,
      reason: '',
      checkDetails: buildCheckDetails({
        allFilesExist: true,
        profileContentNotEmpty: true,
        profileNotExpired: true,
        bundleNameMatched: true,
        teamIdMatched: true,
        allDevicesInProfile: true,
        aclMatched: true,
        cerMatched: true,
        cerNotExpired: true,
        storePasswordValid: true,
      }),
    };
  }
}

// ═══════════════════════════════════════════════════════════════════
// 内部辅助函数
// ═══════════════════════════════════════════════════════════════════

/** 通过 signature-tool.ts 的 getAutoSignFilePath 构建四种材料文件路径 */
async function buildMaterialPathsAsync(
  productName: string,
  projectRoot: string,
  type?: string
): Promise<AutoSignMaterialPaths> {
  const [storeFile, csrFile, cerFile, profileFile] = await Promise.all([
    getAutoSignFilePath(productName, projectRoot, 'p12', type),
    getAutoSignFilePath(productName, projectRoot, 'csr', type),
    getAutoSignFilePath(productName, projectRoot, 'cer', type),
    getAutoSignFilePath(productName, projectRoot, 'p7b', type),
  ]);
  return { storeFile, csrFile, cerFile, profileFile };
}

/** 从 build-profile.json5 的 signingConfigs 读取 storePassword（密文）并解密为明文 */
async function readStorePassword(
  projectRoot: string,
  productName: string,
  storeFile: string,
  type?: string
): Promise<string | undefined> {
  const profilePath = path.join(projectRoot, 'build-profile.json5');
  if (!fs.existsSync(profilePath)) {
    return undefined;
  }

  let profile: {
    app?: {
      signingConfigs?: Array<{
        name: string;
        material?: { storePassword?: string };
      }>;
    };
  };
  try {
    profile = json5.parse(fs.readFileSync(profilePath, 'utf-8'));
  } catch {
    return undefined;
  }

  const configName =
    type === 'release' ? `${productName}_release` : productName;
  const configs = profile?.app?.signingConfigs ?? [];
  const matched = configs.find((c) => c.name === configName);
  const encrypted = matched?.material?.storePassword;
  if (!encrypted) {
    return undefined;
  }
  try {
    return await KeyManager.decryptPassword(encrypted, storeFile);
  } catch {
    return undefined;
  }
}

/** 通过 hdc 获取所有已连接设备的 UDID 列表 */
async function fetchDeviceUdids(hdcPath: string): Promise<string[]> {
  debugLog(`Executing: ${hdcPath} list targets`);
  const { stdout: targetsOut } = await execa(hdcPath, ['list', 'targets'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const serials: string[] = [];
  for (const line of targetsOut.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('[Empty]')) {
      continue;
    }
    const parts = trimmed.split(/\s+/);
    const serial = parts[0];
    const status = parts.length >= 2 ? parts[1] : 'device';
    if (
      serial &&
      !serial.startsWith('[Empty]') &&
      status.toLowerCase() !== 'unauthorized'
    ) {
      serials.push(serial);
    }
  }

  const udids: string[] = [];
  for (const serial of serials) {
    try {
      debugLog(`Executing: ${hdcPath} -t ${serial} shell bm get -u`);
      const { stdout } = await execa(
        hdcPath,
        ['-t', serial, 'shell', 'bm', 'get', '-u'],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );
      const udid = extractUdidFromBmOutput(stdout);
      if (udid) {
        udids.push(udid);
      }
    } catch {
      debugLog(`[reGenerateSign] Failed to get UDID for ${serial}, skipping`);
    }
  }
  return udids;
}

/** 从 `hdc shell bm get -u` 的 stdout 中提取 UDID */
function extractUdidFromBmOutput(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }
  const lines = trimmed.split('\n');
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].includes('udid of current device is')) {
      const nextLine = lines[i + 1].trim();
      const match = nextLine.match(/^[A-Fa-f0-9]{64}$/);
      if (match) {
        return match[0].toUpperCase();
      }
    }
  }
  const match = trimmed.match(/[A-Fa-f0-9]{64}/);
  return match ? match[0].toUpperCase() : null;
}

/** 检查 .p12 / .csr / .cer / .p7b 四个文件是否全部存在 */
function checkAllFilesExist(paths: AutoSignMaterialPaths): FileExistenceResult {
  const entries = [
    paths.storeFile,
    paths.csrFile,
    paths.cerFile,
    paths.profileFile,
  ] as const;

  const missing: string[] = [];
  for (const filePath of entries) {
    if (!fs.existsSync(filePath)) {
      missing.push(filePath);
    }
  }
  return { allExist: missing.length === 0, missing };
}

/** 逐一检查 deviceUdids 是否都在 udidsInProfile 中 */
function profileContainsAllDevices(
  udidsInProfile: string[],
  deviceUdids: string[]
): DeviceCoverageResult {
  const missing: string[] = [];
  for (const udid of deviceUdids) {
    if (!udidsInProfile.includes(udid)) {
      missing.push(udid);
    }
  }
  return { allPresent: missing.length === 0, missing };
}

/** 排序后逐项比对两个 ACL 列表 */
function areAclPermissionsMatched(
  localAcl: string[],
  profileAcl: string[]
): boolean {
  const sortedLocal = [...localAcl].sort();
  const sortedProfile = [...profileAcl].sort();
  if (sortedLocal.length !== sortedProfile.length) {
    return false;
  }
  return sortedLocal.every((perm, i) => perm === sortedProfile[i]);
}

/**
 * 构建 checkDetails。
 * 短路返回点只传已通过的条件，后续未到达的字段由 defaults 填充为 false。
 */
function buildCheckDetails(
  overrides: Partial<ReGenerateCheckDetails> & { force?: boolean }
): ReGenerateCheckDetails {
  const defaults: ReGenerateCheckDetails = {
    force: false,
    allFilesExist: false,
    missingFiles: [],
    profileContentNotEmpty: false,
    profileNotExpired: false,
    bundleNameMatched: false,
    teamIdMatched: false,
    allDevicesInProfile: false,
    missingDeviceUdids: [],
    aclMatched: false,
    cerMatched: false,
    cerNotExpired: false,
    storePasswordValid: false,
  };

  if (overrides.force) {
    return { ...defaults, force: true };
  }

  return { ...defaults, ...overrides, force: false };
}
