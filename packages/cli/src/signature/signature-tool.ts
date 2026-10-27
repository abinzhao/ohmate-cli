/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import path from 'path';
import crypto from 'crypto';
import os from 'os';
import fs from 'fs/promises';

import { runCommand } from '../utils/cmd';
import { ToolProvider } from '../toolchain';
import { logger } from '../../mcp/src-server/lsp/logger';
import { Project } from '../utils/project';

/** 签名工具子命令 */
const SIGN_TOOL_CMD = {
    GENERATE_KEYPAIR: 'generate-keypair',
    GENERATE_CSR: 'generate-csr',
} as const;

/** 密钥算法（仅P12生成） */
const VALID_KEY_ALG = ['ECC', 'RSA'] as const;
/** CSR支持签名算法 */
const VALID_SIGN_ALG = ['SHA256withECDSA', 'SHA384withECDSA', 'SHA256withRSA', 'SHA384withRSA'] as const;

/** 密钥尺寸映射 */
const VALID_KEY_SIZE_MAP: Record<(typeof VALID_KEY_ALG)[number], string[]> = {
    ECC: ['NIST-P-256', 'NIST-P-384'],
    RSA: ['2048', '3072', '4096'],
};

/** 随机密码字节长度，提升安全强度 */
const DEFAULT_PWD_BYTE_LEN = 8;
/** 文件名称片段最大长度，防止超长路径报错 */
const MAX_FILE_NAME_PART_LEN = 64;

/**
 * 全平台通用非法字符正则表达式
 * 过滤 Windows/macOS/Linux 系统中不允许出现在文件名中的字符
 * - \ : * ? " < > | = -
 */
const ILLEGAL_FILE_NAME_CHARS_REGEX = /[\\/:*?"<>|=-]/g;

/** 默认全局配置 */
export const DEFAULT_CFG = {
    productName: 'default',
    keyAlias: 'debugKey',
    keyAlg: 'ECC',
    keySize: 'NIST-P-256',
    csrSubject: 'CN=DebugKey',
    signAlg: 'SHA256withECDSA',
} as const;

/** 支持的签名文件后缀 */
export type SignFileSuffix = 'csr' | 'p12' | 'p7b' | 'cer';

/** 子进程执行返回结构 */
export interface RunCommandResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

/** 密钥基础通用字段 */
interface KeyPairBase {
    keyAlias: string;
    keyPwd: string;
    keystoreFile: string;
    keystorePwd: string;
    pwdInputMode?: string;
}

/** P12生成入参 */
export interface P12KeyPairOpts extends KeyPairBase {
    keyAlg: (typeof VALID_KEY_ALG)[number];
    keySize: string;
}

/** CSR生成入参 */
export interface CSRKeyPairOpts extends KeyPairBase {
    subject: string;
    outFile?: string;
    signAlg: (typeof VALID_SIGN_ALG)[number];
}

/** 一键生成返回结果 */
export interface GenerateP12AndCSRResult {
    /** p12密钥库绝对路径 */
    p12FilePath: string;
    /** csr证书请求绝对路径 */
    csrFilePath: string;
    /** 明文密钥【高度敏感，禁止打印/持久化日志】 */
    keyPwd: string;
    /** 密钥别名 */
    keyAlias: string;
}

/**
 * @internal 校验P12参数合法性
 * @throws 参数非法异常
 */
function validateP12Opts(opts: P12KeyPairOpts): void {
    if (!opts.keyAlias.trim()) {
        throw new Error('keyAlias cannot be empty');
    }
    if (!opts.keystoreFile.trim()) {
        throw new Error('keystoreFile cannot be empty');
    }
    if (opts.keyAlias.length > MAX_FILE_NAME_PART_LEN) {
        throw new Error(`The length of keyAlias cannot exceed ${MAX_FILE_NAME_PART_LEN}`);
    }
    if (!VALID_KEY_ALG.includes(opts.keyAlg)) {
        throw new Error(`Invalid key algorithm ${opts.keyAlg}, available: ${VALID_KEY_ALG.join(' / ')}`);
    }
    const allowSizes = VALID_KEY_SIZE_MAP[opts.keyAlg];
    if (!allowSizes.includes(opts.keySize)) {
        throw new Error(`Key algorithm ${opts.keyAlg} does not support size ${opts.keySize}, available: ${allowSizes.join(', ')}`);
    }
}

/**
 * @internal 校验CSR参数合法性
 * @throws 参数非法异常
 */
function validateCsrOpts(opts: CSRKeyPairOpts): void {
    if (!opts.keyAlias.trim()) {
        throw new Error('keyAlias cannot be empty');
    }
    if (!opts.keystoreFile.trim()) {
        throw new Error('keystoreFile cannot be empty');
    }
    if (!opts.subject.trim()) {
        throw new Error('subject cannot be empty');
    }

    if (!VALID_SIGN_ALG.includes(opts.signAlg)) {
        throw new Error(`Invalid sign algorithm ${opts.signAlg}, available: ${VALID_SIGN_ALG.join(' / ')}`);
    }
}

/**
 * @internal 根据原始路径生成项目哈希
 */
function getProjectRawHash(rawProjectPath: string): string {
    return crypto.createHash('sha256')
        .update(rawProjectPath, 'utf8')
        .digest()
        .toString('base64url')
        .replaceAll(/[-_=]/g, '');
}

/**
 * @internal 校验产品名，过滤非法字符并截断长度
 * @param rawName 原始输入名称
 * @returns 安全文件名片段
 */
function sanitizeName(rawName?: string): string {
    const trimmed = rawName?.trim() ?? '';
    if (!trimmed) {
        return DEFAULT_CFG.productName;
    }
    // 全平台通用非法字符过滤
    const safeStr = trimmed.replace(ILLEGAL_FILE_NAME_CHARS_REGEX, '_').replace(/\.+/g, '_');
    // 截断超长
    const shortStr = safeStr.slice(0, MAX_FILE_NAME_PART_LEN);
    return shortStr || DEFAULT_CFG.productName;
}

/**
 * @internal 获取签名工具执行环境：bundled java + hap-sign-tool.jar 路径
 * 用 ToolProvider 解析 DevEco Studio 自带 JBR 的 java，避免依赖系统 PATH 上的 java。
 * @throws JBR 缺失、SDK 签名工具缺失
 */
async function getSignToolExec(): Promise<{ javaPath: string; jarPath: string }> {
    const toolProvider = await ToolProvider.new();
    toolProvider.assertJava();
    const javaPath = toolProvider.javaPath;
    const sdkPath = toolProvider.sdkPath;
    logger.info(`读取SDK根目录：${sdkPath}`);

    const jarPath = path.join(sdkPath, 'default', 'openharmony', 'toolchains', 'lib', 'hap-sign-tool.jar');
    try {
        await fs.access(jarPath);
    } catch (_err: unknown) {
        throw new Error(`Sign tool jar not found: ${jarPath}`, { cause: _err });
    }
    return { javaPath, jarPath };
}

/**
 * @internal 组装P12生成命令，日志脱敏密码
 */
async function buildGenKeypairArgs(opts: P12KeyPairOpts): Promise<string[]> {
    const { javaPath, jarPath } = await getSignToolExec();
    const args: string[] = [
        '-jar', jarPath,
        SIGN_TOOL_CMD.GENERATE_KEYPAIR,
        '-keyAlias', opts.keyAlias,
        '-keyAlg', opts.keyAlg,
        '-keySize', opts.keySize,
        '-keystoreFile', opts.keystoreFile,
        '-keystorePwd', opts.keystorePwd,
    ];

    if (opts.keyPwd) {
        args.push('-keyPwd', opts.keyPwd);
    }
    if (opts.pwdInputMode) {
        args.push('-pwdInputMode', opts.pwdInputMode);
    }

    // 日志脱敏，防止密钥泄露
    const logSafeArgs = args.map((item, i) =>
        i > 0 && ['-keyPwd', '-keystorePwd'].includes(args[i - 1]) ? '******' : item
    );
    logger.debug('generate-keypair 命令（脱敏）：', logSafeArgs.join(' '));
    return [javaPath, ...args];
}

/**
 * @internal 组装CSR生成命令，日志脱敏密码
 */
async function buildGenCsrArgs(opts: CSRKeyPairOpts): Promise<string[]> {
    const { javaPath, jarPath } = await getSignToolExec();
    const args: string[] = [
        '-jar', jarPath,
        SIGN_TOOL_CMD.GENERATE_CSR,
        '-keyAlias', opts.keyAlias,
        '-subject', opts.subject,
        '-signAlg', opts.signAlg,
        '-keystoreFile', opts.keystoreFile,
        '-keystorePwd', opts.keystorePwd,
    ];

    if (opts.outFile) {
        args.push('-outFile', opts.outFile);
    }
    if (opts.keyPwd) {
        args.push('-keyPwd', opts.keyPwd);
    }
    if (opts.pwdInputMode) {
        args.push('-pwdInputMode', opts.pwdInputMode);
    }

    const logSafeArgs = args.map((item, i) =>
        i > 0 && ['-keyPwd', '-keystorePwd'].includes(args[i - 1]) ? '******' : item
    );
    logger.debug('generate-csr 命令（脱敏）：', logSafeArgs.join(' '));
    return [javaPath, ...args];
}


/**
 * @internal 执行P12生成
 * @throws 参数非法、工具执行失败
 */
async function generateP12Store(opts: P12KeyPairOpts): Promise<RunCommandResult> {
    logger.info('开始生成 P12 密钥库');
    validateP12Opts(opts);

    const fullArgs = await buildGenKeypairArgs(opts);
    const execResult = await runCommand(fullArgs[0], fullArgs.slice(1));

    if (execResult.exitCode !== 0) {
        const errMsg = execResult.stderr || execResult.stdout || 'Unknown tool error';
        throw new Error(`An error occurred while generating the private key P12, exit code${execResult.exitCode}：${errMsg}`);
    }
    logger.info('生成P12命令执行完成');
    return execResult;
}

/**
 * @internal 执行CSR生成，前置校验参数
 * @throws 参数非法、工具执行失败
 */
async function generateCsrFile(opts: CSRKeyPairOpts): Promise<RunCommandResult> {
    logger.info('开始生成 CSR 证书请求');
    validateCsrOpts(opts);

    const fullArgs = await buildGenCsrArgs(opts);
    const execResult = await runCommand(fullArgs[0], fullArgs.slice(1));

    if (execResult.exitCode !== 0) {
        const errMsg = execResult.stderr || execResult.stdout || 'Unknown tool error';
        throw new Error(`An error occurred while generating the CSR, exit code${execResult.exitCode}：${errMsg}`);
    }
    logger.info('生成CSR命令执行完成');
    return execResult;
}

/**
 * 生成安全随机密码，仅字母数字
 * @param byteLen 字节长度，默认16
 */
export function generateRandomPwd(byteLen: number = DEFAULT_PWD_BYTE_LEN): string {
    return crypto.randomBytes(byteLen)
        .toString('base64url')
        .replaceAll(/[-_=]/g, '');
}

/**
 * 获取并自动创建签名配置目录 .ohos/config
 * Unix 目录权限 0o700 仅自身可读，Windows自动忽略mode
 * @throws 用户家目录不可访问、目录创建失败
 */
export async function getUserOhosConfigDir(): Promise<string> {
    const homeDir = os.homedir();
    try {
        await fs.access(homeDir);
    } catch (_err: unknown) {
        throw new Error(`Invalid user path;`, { cause: _err });
    }

    const configDir = path.join(homeDir, '.ohos', 'config');
    try {
        await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
    } catch (_err: unknown) {
        throw new Error(`Failed to create directory ${configDir}`, { cause: _err });
    }
    logger.info(`签名配置目录就绪：${configDir}`);
    return configDir;
}

/**
 * 拼接签名文件完整路径
 * 内部对 productName 做 sanitize（非法字符过滤+截断），保证删除与生成使用同一路径。
 * @param productName 产品名称
 * @param projectRoot 项目根目录绝对路径
 * @param suffix 文件后缀
 * @param type 签名类型 'debug' | 'release'，release 时路径含 _release 段以区分
 * @returns 完整文件路径
 */
export async function getAutoSignFilePath(
    productName: string,
    projectRoot: string,
    suffix: SignFileSuffix,
    type?: string
): Promise<string> {
    const safeProduct = sanitizeName(productName);
    const baseName = path.basename(projectRoot);
    const hash = getProjectRawHash(projectRoot);
    const typeSegment = type === 'release' ? '_release' : '';
    const fileName = `${safeProduct}_${baseName}_${hash}${typeSegment}=.${suffix}`;
    const configDir = await getUserOhosConfigDir();
    return path.join(configDir, fileName);
}

/**
 * @internal 校验项目根目录合法性
 */
function getValidProjectRoot(workDir: string): string {
    let projectRoot: string;
    try {
        projectRoot = Project.discover(workDir).rootDir;
    } catch (_err: unknown) {
        throw new Error(`Current directory ${workDir} is not a valid project root`, { cause: _err });
    }
    return projectRoot;
}

/**
 * @internal 校验项目目录读写权限
 */
async function checkProjectDirAccess(projectRoot: string): Promise<void> {
    try {
        await fs.access(projectRoot);
    } catch (_err: unknown) {
        throw new Error(`Project directory ${projectRoot} is not accessible, missing read/write permissions`, { cause: _err });
    }
}

/**
 * @internal 校验P12文件是否生成成功
 */
async function assertP12FileExists(p12FilePath: string): Promise<void> {
    try {
        await fs.access(p12FilePath);
    } catch (_err: unknown) {
        throw new Error(`P12 file ${p12FilePath} does not exist, terminating CSR generation.`, { cause: _err });
    }
}

/**
 * 一键串行生成 P12 + CSR
 * 强依赖：P12异常 / P12文件缺失 直接终止，不执行CSR
 * 复用公共路径工具 getAutoSignFilePath，消除重复哈希拼接逻辑
 * @param productName 产品名
 * @param p12Opts P12密钥库参数
 * @param csrOpts CSR证书请求参数
 * @param type 签名类型 'debug' | 'release'，影响文件路径和默认 keyAlias/subject
 */
export async function generateP12AndCSR(
    productName?: string,
    p12Opts?: P12KeyPairOpts,
    csrOpts?: CSRKeyPairOpts,
    type?: string
): Promise<GenerateP12AndCSRResult> {
    const workDir = process.cwd();
    const projectRoot = getValidProjectRoot(workDir);
    await checkProjectDirAccess(projectRoot);
    logger.info(`识别项目根目录：${projectRoot}`);

    const runtimePwd = generateRandomPwd();
    const isRelease = type === 'release';
    const defaultKeyAlias = isRelease ? 'releaseKey' : DEFAULT_CFG.keyAlias;
    const defaultCsrSubject = isRelease ? 'CN=ReleaseKey' : DEFAULT_CFG.csrSubject;

    // p12/csr 共用同一基名（getAutoSignFilePath() + 后缀）
    // 旧材料清理由 deleteLocalSignFiles 在生成前统一完成，此处只负责生成
    const p12FilePath = await getAutoSignFilePath(productName ?? '', projectRoot, 'p12', type);
    const csrFilePath = await getAutoSignFilePath(
      productName ?? '',
      projectRoot,
      'csr',
      type
    );

    console.log('Start generating p12');

    await generateP12Store({
        keyAlias: p12Opts?.keyAlias ?? defaultKeyAlias,
        keyPwd: runtimePwd,
        keyAlg: p12Opts?.keyAlg ?? DEFAULT_CFG.keyAlg,
        keySize: p12Opts?.keySize ?? DEFAULT_CFG.keySize,
        keystoreFile: p12FilePath,
        keystorePwd: runtimePwd,
    });

    await assertP12FileExists(p12FilePath);
    console.log('Start generating csr');
    await generateCsrFile({
        subject: csrOpts?.subject ?? defaultCsrSubject,
        outFile: csrFilePath,
        keyAlias: p12Opts?.keyAlias ?? defaultKeyAlias,
        keyPwd: runtimePwd,
        signAlg: csrOpts?.signAlg ?? DEFAULT_CFG.signAlg,
        keystoreFile: p12FilePath,
        keystorePwd: runtimePwd,
    });

    return {
        p12FilePath,
        csrFilePath,
        keyPwd: runtimePwd,
        keyAlias: p12Opts?.keyAlias ?? defaultKeyAlias,
    };
}