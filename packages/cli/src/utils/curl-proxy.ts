/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/*
 * Windows企业内网代理通常要求NTLM集成认证。
 * Node.js的axios只支持Basic认证，且不能携带当前Windows登录用户身份，
 * 直连代理时返回407("Invalid proxy authorization")。
 *
 * 本模块提供curl.exe兜底：curl支持--proxy-ntlm，可自动使用
 * 当前Windows登录用户身份进行NTLM身份集成认证(SSO)，无需配置用户名密码，
 * 与浏览器/IDE等走系统代理的软件行为一致。
 *
 * 仅在http-client收到407时调用，不影响正常路径
 */

export interface CurlRequestOptions {
  url: string;
  method?: 'GET' | 'POST' | 'DELETE';
  data?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** true时返回二进制body，用于文件下载等场景 */
  binary?: boolean;
}

export interface CurlResponse {
  statusCode: number;
  statusText: string;
  body: string;
  headers: Record<string, string>;
  /** binary=true 时原始二进制Buffer */
  bodyBuffer?: Buffer;
}

const CURL_TIMEOUT_MS = 60000;

/*
 * 读取Windows系统代理地址（注册表ProxyServer）。
 * 使用系统自带reg.exe query (spawn 不经shell，规避参数转义问题)。
 * 读取失败或未配置时返回null
 */
async function readSystemProxy(): Promise<string | null> {
  if (process.platform !== 'win32') {
    return null;
  }
  const key =
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
  const proxy = await regQueryValue(key, 'ProxyServer');
  if (!proxy) {
    return null;
  }
  const enabled = await regQueryValue(key, 'ProxyEnable');
  if (enabled !== '1' && enabled !== '0x1') {
    return null;
  }
  return proxy.trim();
}

/** 用reg.exe query 读取指定注册表值，失败返回null */
function regQueryValue(key: string, valueName: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn('reg.exe', ['query', key, '/v', valueName], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      // 匹配 REG_SZ / REG_DWORD 等任意类型，取类型后的值
      const match = /REG_\w+\s+(\S+)/.exec(stdout);
      resolve(match ? match[1] : null);
    });
  });
}

/** 解析 HTTP_PROXY/HTTPS_PROXY 环境变量中的代理地址（去掉可能的协议前缀） */
function resolveEnvProxy(): string | null {
  const raw = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? '';
  if (!raw) {
    return null;
  }
  try {
    const u = new URL(raw);
    return u.host; // host包含hostname[:port]
  } catch {
    return raw;
  }
}

/** 定位windows系统自带curl.exe（System32 优先） */
function resolveCurlExecutable(): string {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  return `${systemRoot}\\System32\\curl.exe`;
}

/** 从 curl -i原始响应头文本解析状态行与响应头 */
function parseCurlHeaders(raw: string): {
  statusCode: number;
  statusText: string;
  headers: Record<string, string>;
} {
  const headers: Record<string, string> = {};
  let statusCode = 0;
  let statusText = '';

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const statusMatch = /^HTTP\/\d(?:\.\d)?\s+(\d{3})\s*(.*)$/.exec(trimmed);
    if (statusMatch) {
      statusCode = parseInt(statusMatch[1], 10);
      statusText = statusMatch[2] ?? '';
      continue;
    }
    const headerMatch = /^([^:]+):\s*(.*)$/.exec(trimmed);
    if (headerMatch) {
      headers[headerMatch[1].toLowerCase()] = headerMatch[2];
    }
  }

  return { statusCode, statusText, headers };
}

/** 构建curl命令参数，代理地址由调用方传入（环境变量或系统代理已解析） */
function buildCurlArgs(
  options: CurlRequestOptions,
  proxyHost: string,
  headerFile: string | undefined,
  bodyFile: string | undefined
): string[] {
  const args: string[] = [
    '--silent',
    '--show-error',
    '--location',
    '--ssl-no-revoke',
    '--insecure',
    // 显式走代理；--proxy-ntlm 仅对代理做NTLM集成认证（SSO）
    // 自动携带当前Windows登录用户身份，无需用户名密码
    // 注意：不能用 --ntlm（会对目标服务器也尝试NTLM,导致POST body
    // 在认证重放时丢失、content-Length变0，服务器返回400）
    '-x',
    `http://${proxyHost}`,
    '--proxy-ntlm',
    '--proxy-user',
    ':',
    '--max-time',
    String(
      Math.max(1, Math.floor((options.timeoutMs ?? CURL_TIMEOUT_MS) / 1000))
    ),
  ];

  if (options.method && options.method !== 'GET') {
    args.push('-X', options.method);
  }
  if (options.data !== undefined) {
    // 用 --data-binary 而非 --data: 后者在NTLM 代理隧道下可能
    // 因自动表单编码/Content-Type变更导致请求超时（实测）。
    args.push('--data-binary', options.data);
  }
  args.push(...buildHeaderArgs(options.headers, options.data !== undefined));
  // 二进制模式: 响应头与响应体分别写入临时文件，避免stdout拆分二进制
  if (bodyFile) {
    args.push('--dump-header', headerFile!);
    args.push('--output', bodyFile);
  } else {
    args.push('--include');
  }
  args.push(options.url);
  return args;
}

function buildHeaderArgs(
  headers: Record<string, string> | undefined,
  hasBody: boolean
): string[] {
  const MANAGED_HEADERS = new Set([
    'content-length',
    'host',
    'connection',
    'proxy-authorization',
    'proxy-connection',
    'accept-encoding',
  ]);
  const args: string[] = [];
  let hasContentType = false;
  for (const [name, value] of Object.entries(headers ?? {})) {
    const lower = name.toLowerCase();
    if (lower === 'content-type') {
      hasContentType = true;
    }
    if (!MANAGED_HEADERS.has(lower)) {
      args.push('-H', `${name}: ${value}`);
    }
  }
  if (hasBody && !hasContentType) {
    args.push('-H', 'Content-Type: application/json');
  }
  return args;
}

/** 从curl输出解析响应（文本模式从stdout拆分，二进制模式从临时文件读取） */
function parseCurlOutput(
  stdout: string,
  headerFile: string | undefined,
  bodyFile: string | undefined
): CurlResponse | null {
  if (bodyFile) {
    // 二进制模式：body写入bodyFile，header写入headerFile
    const headersRaw = fs.readFileSync(headerFile!, 'utf8');
    const bodyBuffer = fs.readFileSync(bodyFile);
    const parsed = parseCurlHeaders(headersRaw);
    return {
      statusCode: parsed.statusCode,
      statusText: parsed.statusText,
      body: bodyBuffer.toString('base64'),
      headers: parsed.headers,
      bodyBuffer,
    };
  }
  // 文本模式：-i输出。走CONNECT隧道（HTTPS目标）时输出含一个前置的
  // "HTTP/1.1 200 Connection established"，取最后一个HTTP响应块，
  // 以其后的第一个空行作为头/正文边界（避免正文中的空行被误判为边界）
  const lastHttp = stdout.lastIndexOf('HTTP/');
  if (lastHttp === -1) {
    return null;
  }
  const remaining = stdout.slice(lastHttp);
  const headerEnd = remaining.indexOf('\r\n\r\n');
  if (headerEnd === -1) {
    return null;
  }
  const headerBlock = remaining.slice(0, headerEnd);
  const body = remaining.slice(headerEnd + 4);
  const parsed = parseCurlHeaders(headerBlock);
  return {
    statusCode: parsed.statusCode,
    statusText: parsed.statusText,
    body,
    headers: parsed.headers,
  };
}

/**
 * 使用curl.exe通过代理发起请求（仅限Windows + 407兜底场景）
 * 代理优先级：HTTP(S)_PROXY环境变量 > Windows系统代理(注册表)
 * @returns 解析后的响应；执行失败或不可用时返回null
 */
export async function curlRequest(
  options: CurlRequestOptions
): Promise<CurlResponse | null> {
  // 仅Windows可用（curl.exe + SSPI SSO 依赖Windows）
  if (process.platform !== 'win32') {
    return null;
  }
  // 解析代理：环境变量优先，其次系统代理
  const proxyHost = resolveEnvProxy() ?? (await readSystemProxy());
  if (!proxyHost) {
    // 无代理 → 兜底无意义，回退原错误
    return null;
  }

  // 每次请求分配独立临时目录，避免并发下载共用文件
  let tmpDir: string | undefined;
  if (options.binary) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'curl-'));
  }
  const headerFile = tmpDir ? path.join(tmpDir, 'header.tmp') : undefined;
  const bodyFile = tmpDir ? path.join(tmpDir, 'body.tmp') : undefined;

  try {
    const args = buildCurlArgs(options, proxyHost, headerFile, bodyFile);
    const result = await runCurl(args, options.timeoutMs);
    if (!result || result.code !== 0) {
      return null;
    }
    return parseCurlOutput(result.stdout, headerFile, bodyFile);
  } catch {
    return null;
  } finally {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}

/**
 * 运行curl子进程，返回退出码与stdout（含超时控制）。
 */
function runCurl(
  args: string[],
  timeoutMs?: number
): Promise<{ code: number; stdout: string } | null> {
  const curl = resolveCurlExecutable();
  return new Promise((resolve) => {
    const child = spawn(curl, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let settled = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        // 不立即 resolve，等 close 事件确保子进程退出后再 resolve
      }
    }, timeoutMs ?? CURL_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on('error', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        resolve(null);
      }
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (settled) {
        // 超时被 kill 后子进程退出
        resolve(null);
        return;
      }
      settled = true;
      resolve({ code: code ?? -1, stdout });
    });
  });
}
