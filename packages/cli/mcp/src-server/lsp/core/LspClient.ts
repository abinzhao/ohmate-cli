/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { spawn, ChildProcess } from 'child_process';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { logger } from '../logger.js';
import { buildAceServerArgs, resolveNodePath } from '../utils.js';

/**
 * 客户端配置接口
 */
export interface LspClientConfig {
    serverPath: string; // LSP server (js file) path
    logPath: string; // Log directory
    indexingDataLocation: string; // Indexing data directory
    cwd?: string; // Working directory
    projectPath?: string; // 工程根路径（socket 模式下用于端口文件路径和 --projectPath 参数）
    useSocket?: boolean; // true=socket 传输，false/undefined=stdio（默认）
    nodePath?: string; // 启动期固定 node 可执行文件路径（工具链 bundled node）；未设置则回退 process.execPath
}

/**
 * LSP 消息处理客户端
 * 负责进程管理、流解析 (Content-Length) 和消息收发
 */
const MAX_CONTENT_LENGTH = 50 * 1024 * 1024;

/** 等待子进程 stdout 输出端口信息的超时（ms）。 */
const SOCKET_PORT_TIMEOUT_MS = 60 * 1000;
/** TCP 连接超时（ms）。 */
const SOCKET_CONNECT_TIMEOUT_MS = 10 * 1000;
/** 等待端口期间累积 stdout 的上限（字节）；超出只保留尾部。 */
const MAX_PORT_SCAN_BYTES = 64 * 1024;

/** 规范化 server 路径（与 IDE 写端口文件时的算法一致）：resolve → '/' 分隔 → 去尾部斜杠 → win32 转小写。 */
function normalizeServerPath(serverPath: string): string {
    let p = path.resolve(serverPath).replace(/\\/g, '/');
    if (p.length > 1 && p.endsWith('/')) {
        p = p.slice(0, -1);
    }
    return process.platform === 'win32' ? p.toLowerCase() : p;
}

/** server 路径 hash：sha1(规范化路径) 前 12 位十六进制。 */
function getServerPathHash(serverPath: string): string {
    return crypto.createHash('sha1').update(normalizeServerPath(serverPath)).digest('hex').slice(0, 12);
}

/** 从 server 入口 js 路径截取 out 目录层级（standardIndex/index.js 的上一级；无 out 段时取文件所在目录）。 */
function getServerOutDir(serverPath: string): string {
    const resolved = path.resolve(serverPath);
    const parts = resolved.split(path.sep);
    const outIdx = parts.lastIndexOf('out');
    if (outIdx > 0) {
        return parts.slice(0, outIdx + 1).join(path.sep);
    }
    return path.dirname(resolved);
}

export class LspClient extends EventEmitter {
    private process: ChildProcess | null = null;
    private buffer: Buffer = Buffer.alloc(0);
    private isClosing: boolean = false;
    private socket: net.Socket | null = null;
    private _ownsProcess: boolean = false;

    constructor(private config: LspClientConfig) {
        super();
    }

    /** ace-server 子进程 pid；未启动时为 null。 */
    public get pid(): number | null {
        return this.process?.pid ?? null;
    }

    /** 是否由本实例拉起进程（true=自己 spawn 的；false=连到已有 socket 服务）。 */
    public get ownsProcess(): boolean {
        return this._ownsProcess;
    }

    /** 是否处于 socket 传输模式。stop 时据此跳过 shutdown/exit/kill，依赖 server 自主关闭。 */
    public get isSocketMode(): boolean {
        return this.socket !== null;
    }

    /** 确保 log/index 目录存在，返回 lspLog 子目录路径。 */
    private ensureDirectories(): string {
        const lspLogPath = path.join(this.config.logPath, 'lspLog');
        if (!fs.existsSync(lspLogPath)) {
            fs.mkdirSync(lspLogPath, { recursive: true });
        }
        if (!fs.existsSync(this.config.indexingDataLocation)) {
            fs.mkdirSync(this.config.indexingDataLocation, { recursive: true });
        }
        return lspLogPath;
    }

    /**
     * 启动 LSP 进程：根据 useSocket 选择 stdio 或 socket 传输。
     */
    public async start(serverMaxSize: number): Promise<void> {
        if (this.config.useSocket && this.config.projectPath) {
            await this.startSocket(serverMaxSize);
        } else {
            await this.startStdio(serverMaxSize);
        }
    }

    /**
     * stdio 模式启动 LSP 进程 (对应 Java StreamMessageConsumer.start)
     */
    private async startStdio(serverMaxSize: number): Promise<void> {
        this._ownsProcess = true;
        const lspLogPath = this.ensureDirectories();
        logger.debug(`[LspClient] serverMaxSize=${serverMaxSize}MB`);
        const args = buildAceServerArgs({
            serverPath: this.config.serverPath,
            lspLogPath,
            serverMaxSize,
        });

        const nodePath = resolveNodePath(this.config.nodePath);
        logger.debug(`[LspClient] Starting process: node ${args.join(' ')}`);
        logger.debug(`[LspClient] nodePath: ${nodePath}`);
        this.process = spawn(nodePath, args, {
            cwd: this.config.cwd || process.cwd(),
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });
        this.bindProcessEvents(true, true);
        await new Promise((resolve) => setTimeout(resolve, 500));
        logger.info('[LspClient] start lsp process success');
    }

    /**
     * socket 模式启动 LSP：先查 lsp-socket-<hash>.properties 端口文件（hash 由 serverPath 的
     * out 目录计算），存在则连接已有服务；连不上或无端口文件则 spawn，spawn 最多重试 3 次，
     * 仍失败则抛出异常。
     */
    private async startSocket(serverMaxSize: number): Promise<void> {
        const lspLogPath = this.ensureDirectories();
        const projectPath = this.config.projectPath!;
        const outDir = getServerOutDir(this.config.serverPath);
        const portFile = path.join(
            projectPath, '.idea', '.deveco', 'arkts', '.cache',
            `lsp-socket-${getServerPathHash(outDir)}.properties`,
        );

        const existingPort = this.tryReadPortFile(portFile);
        if (existingPort !== null) {
            try {
                logger.info(`[LspClient] Port file found (lspSocketPort=${existingPort}), connecting to existing server`);
                this._ownsProcess = false;
                await this.connectSocket(existingPort);
                logger.info('[LspClient] Connected to existing socket server');
                return;
            } catch (e) {
                logger.warn(`[LspClient] Failed to connect to existing socket server (port=${existingPort}): ${e instanceof Error ? e.message : e}, falling back to spawn`);
            }
        }

        const MAX_SPAWN_RETRIES = 3;
        let lastError: Error | null = null;
        for (let attempt = 1; attempt <= MAX_SPAWN_RETRIES; attempt++) {
            try {
                if (attempt === 1) {
                    logger.info('[LspClient] Spawning server in socket mode');
                } else {
                    logger.info(`[LspClient] Retry ${attempt}/${MAX_SPAWN_RETRIES} spawning socket server`);
                }
                this._ownsProcess = true;
                await this.spawnSocketServer(serverMaxSize, lspLogPath, projectPath);
                logger.info('[LspClient] Socket server started and connected');
                return;
            } catch (e) {
                lastError = e instanceof Error ? e : new Error(String(e));
                logger.warn(`[LspClient] Spawn attempt ${attempt}/${MAX_SPAWN_RETRIES} failed: ${lastError.message}`);
                this.cleanupSpawnResidue();
            }
        }
        throw new Error(`Failed to start socket server after ${MAX_SPAWN_RETRIES} attempts: ${lastError?.message}`);
    }

    /** 清理失败的 spawn 残留（进程 + socket）。 */
    private cleanupSpawnResidue(): void {
        if (this.process) {
            try {
                if (this.process.exitCode === null && this.process.signalCode === null) {
                    this.process.kill();
                }
            } catch {
                // 进程可能已自行退出
            }
            this.process = null;
        }
        if (this.socket) {
            try {
                this.socket.destroy();
            } catch {
                // socket 可能已关闭
            }
            this.socket = null;
        }
    }

    /** 读取端口文件，返回端口号；文件不存在或解析失败返回 null。 */
    private tryReadPortFile(portFile: string): number | null {
        try {
            if (!fs.existsSync(portFile)) {
                return null;
            }
            const content = fs.readFileSync(portFile, 'utf8');
            const match = content.match(/lspSocketPort\s*=\s*(\d+)/);
            if (match) {
                const port = parseInt(match[1], 10);
                if (Number.isFinite(port) && port > 0) {
                    return port;
                }
            }
            return null;
        } catch {
            return null;
        }
    }

    /** socket 模式 spawn 服务端进程，从 stdout 解析端口后建立 TCP 连接。 */
    private async spawnSocketServer(
        serverMaxSize: number,
        lspLogPath: string,
        projectPath: string,
    ): Promise<void> {
        logger.debug(`[LspClient] serverMaxSize=${serverMaxSize}MB`);
        const args = buildAceServerArgs({
            serverPath: this.config.serverPath,
            lspLogPath,
            serverMaxSize,
            transportFlag: '--scope=multi',
            projectPath,
        });

        const nodePath = resolveNodePath(this.config.nodePath);
        logger.debug(`[LspClient] Starting process (socket): node ${args.join(' ')}`);
        logger.debug(`[LspClient] nodePath: ${nodePath}`);
        this.process = spawn(nodePath, args, {
            cwd: this.config.cwd || process.cwd(),
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            detached: true,
        });

        const port = await this.waitForPortFromStdout(SOCKET_PORT_TIMEOUT_MS);
        logger.debug(`[LspClient] LSP_SOCKET_LISTENING port=${port}`);

        await this.connectSocket(port);

        // stdout 不走 handleData（socket 模式下 LSP 消息走 TCP）；仅绑定 stderr + exit
        this.bindProcessEvents(true, false);
    }

    /** 监听子进程 stdout，解析 `LSP_SOCKET_LISTENING:(\\d+)` 获取端口号。 */
    private waitForPortFromStdout(timeoutMs: number): Promise<number> {
        return new Promise((resolve, reject) => {
            const stdout = this.process?.stdout;
            if (!stdout) {
                reject(new Error('LSP server failed to start: no stdout'));
                return;
            }
            const regex = /LSP_SOCKET_LISTENING:(\d+)/;
            // 端口行可能被管道分包截断，累积后再匹配（只保留尾部，避免 server 刷屏时无上限增长）
            let buffered = '';
            const timer = setTimeout(() => {
                stdout.removeListener('data', onData);
                reject(new Error('LSP server failed to start: port not received within timeout'));
            }, timeoutMs);
            const onData = (chunk: Buffer): void => {
                buffered += chunk.toString('utf8');
                const match = buffered.match(regex);
                if (match) {
                    clearTimeout(timer);
                    stdout.removeListener('data', onData);
                    resolve(parseInt(match[1], 10));
                    return;
                }
                // 未命中才裁剪：先匹配再丢弃头部，避免端口行被同批噪声挤出窗口
                buffered = buffered.slice(-MAX_PORT_SCAN_BYTES);
            };
            stdout.on('data', onData);
        });
    }

    /** 建立 TCP 连接到 127.0.0.1:port，连接成功后绑定 socket 事件。 */
    private connectSocket(port: number): Promise<void> {
        return new Promise((resolve, reject) => {
            const socket = net.connect(port, '127.0.0.1');
            const timer = setTimeout(() => {
                socket.destroy();
                reject(new Error(`TCP connection to LSP socket timed out (port ${port})`));
            }, SOCKET_CONNECT_TIMEOUT_MS);
            socket.on('connect', () => {
                clearTimeout(timer);
                this.socket = socket;
                this.bindSocketEvents(socket);
                resolve();
            });
            socket.on('error', (err: Error) => {
                clearTimeout(timer);
                reject(new Error(`TCP connection to LSP socket failed: ${err.message}`));
            });
        });
    }

    /** 绑定 TCP socket 的 data/error/close 事件。 */
    private bindSocketEvents(socket: net.Socket): void {
        socket.on('data', (chunk: Buffer) => this.handleData(chunk));
        socket.on('error', (err: Error) => {
            logger.error(`[LspClient] socket error: ${err.message}`);
            if (!this.isClosing) {
                this.emit('error', err);
            }
        });
        socket.on('close', () => {
            logger.info('[LspClient] socket closed');
            if (!this.isClosing) {
                this.emit('error', new Error('LSP socket closed'));
            }
        });
    }

    /**
     * 接管一个已 spawn 的 LSP 子进程的 stdio，复用本实例的 Content-Length 帧解析 + 事件分发。
     * 与 {@link start} 的差异：不 spawn、不调 {@link ensureDirectories}、不做 500ms warmup。
     * 用于原生二进制 LSP server（如 clangd）—— 调用方自行 spawn 后调用本方法接管。
     *
     * @param process 已 spawn 的子进程
     * @param options.stderrAsError 是否把 stderr 输出当作致命错误（emit 'error' 事件）。
     *   - true（默认，ace-server 适用）：stderr 只应有真正的错误，触发 error 事件
     *   - false（clangd 适用）：stderr 是常规日志通道（--log=info），仅记录不触发 error
     */
    public attachProcess(process: ChildProcess, options?: { stderrAsError?: boolean }): void {
        if (this.process) {
            throw new Error('[LspClient] process already attached');
        }
        this._ownsProcess = true;
        this.process = process;
        this.bindProcessEvents(options?.stderrAsError ?? true, true);
        logger.info('[LspClient] attached to external process');
    }

    /**
     * 绑定 stdout/stderr/exit 事件到本实例的 handleData / error 通路。
     * 由 {@link startStdio}（ace-server spawn）与 {@link attachProcess}（外部 spawn）共用。
     *
     * @param stderrAsError 是否把 stderr 输出当作致命错误。默认 true（ace-server 适用）。
     *   clangd 等使用 stderr 作为常规日志通道的 LSP server 应传 false。
     * @param bindStdout 是否把 stdout 数据交给 {@link handleData} 解析。默认 true（stdio 模式）。
     *   socket 模式下 LSP 消息走 TCP socket，stdout 仅用于端口解析，应传 false。
     */
    private bindProcessEvents(stderrAsError: boolean = true, bindStdout: boolean = true): void {
        if (!this.process) {
            return;
        }
        if (bindStdout) {
            this.process.stdout?.on('data', (chunk: Buffer) => {
                this.handleData(chunk);
            });
        }
        this.process.stderr?.on('data', (chunk: Buffer) => {
            const errorMessage = chunk.toString('utf8').trim();
            logger.error(`[LspClient] stderr: ${errorMessage}`);
            if (!this.isClosing && stderrAsError) {
                this.emit('error', new Error(`[LspClient] stderr: ${errorMessage}`));
            }
        });
        this.process.on('exit', (code) => {
            logger.info(`[LSP EXIT] code=${code}`);
            if (!this.isClosing) {
                this.emit('error', new Error(`LSP process exited with code ${code}`));
            }
        });
    }

    public sendRaw(jsonBody: string, name: string): void {
        const message = this.buildLspMessage(jsonBody);
        if (this.socket && !this.socket.destroyed && this.socket.writable) {
            logger.debug(`[LspClient] [SOCKET SEND] ${name}: ${jsonBody.slice(0, 200)}`);
            this.socket.write(message, 'utf8');
            return;
        }
        if (!this.process?.stdin?.writable) {
            logger.warn('[LspClient] Cannot send message, no writable transport');
            return;
        }
        logger.debug(`[LspClient] send message: ${name}`);
        this.process.stdin.write(message, 'utf8');
    }

    public send(method: string, params: unknown, id?: number | string): void {
        const message: Record<string, unknown> = {
            jsonrpc: '2.0',
            method,
            params,
        };
        if (id !== undefined) {
            message.id = id;
        }
        this.sendRaw(JSON.stringify(message), method);
    }

    /** 发送标准 LSP notification（无 id）。 */
    public sendNotification(method: string, params: unknown): void {
        this.sendRaw(
            JSON.stringify({ jsonrpc: '2.0', method, params }),
            method,
        );
    }

    /** 发送标准 LSP request（带 id，等待响应）。 */
    public sendRequest(method: string, params: unknown, id: number | string): void {
        this.sendRaw(
            JSON.stringify({ jsonrpc: '2.0', id, method, params }),
            method,
        );
    }

    private buildLspMessage(jsonBody: string): string {
        const contentBuffer = Buffer.from(jsonBody, 'utf8');
        return `Content-Length: ${contentBuffer.length}\r\n\r\n${jsonBody}`;
    }

    private handleData(data: Buffer): void {
        this.buffer = Buffer.concat([this.buffer, data]);

        while (true) {
            const headerEndIdx = this.buffer.indexOf('\r\n\r\n');
            if (headerEndIdx === -1) {
                break;
            }

            const header = this.buffer.slice(0, headerEndIdx).toString('ascii');
            const contentLengthMatch = header.match(/Content-Length:\s*(\d+)/i);
            if (!contentLengthMatch) {
                logger.warn('[LspClient] Invalid LSP header, drop until next packet');
                this.buffer = this.buffer.slice(headerEndIdx + 4);
                continue;
            }

            const contentLength = parseInt(contentLengthMatch[1], 10);
            if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > MAX_CONTENT_LENGTH) {
                logger.warn(`[LspClient] Invalid Content-Length: ${contentLengthMatch[1]}, drop until next packet`);
                this.buffer = this.buffer.slice(headerEndIdx + 4);
                continue;
            }
            const bodyStartIdx = headerEndIdx + 4;
            const bodyEndIdx = bodyStartIdx + contentLength;

            if (this.buffer.length < bodyEndIdx) {
                break;
            }

            const body = this.buffer.slice(bodyStartIdx, bodyEndIdx).toString('utf8');
            const recovered = this.recoverFramedJson(body);
            if (recovered && recovered.rest.length > 0) {
                logger.warn(
                    `[LspClient] recovered mixed LSP frame, bodyLen=${body.length}, restLen=${recovered.rest.length}`,
                );
                this.logSocketRecv(recovered.json);
                this.emit('message', recovered.json);
                this.buffer = Buffer.concat([Buffer.from(recovered.rest, 'utf8'), this.buffer.slice(bodyEndIdx)]);
                continue;
            }
            this.logSocketRecv(body);
            this.emit('message', body);
            this.buffer = this.buffer.slice(bodyEndIdx);
        }
    }

    /** socket 模式下打印接收到的报文（截断到 200 字符，避免超大 LSP 帧刷爆日志）。 */
    private logSocketRecv(body: string): void {
        if (this.socket) {
            logger.debug(`[LspClient] [SOCKET RECV] ${body.slice(0, 200)}`);
        }
    }

    /**
     * 在已向子进程写入 exit 通知后调用：子等进程自发退出（LSP shutdown）或超时再 kill。
     */
    public waitForExitOrTimeout(timeoutMs: number): Promise<void> {
        const child = this.process;
        if (!child) {
            return Promise.resolve();
        }
        if (child.exitCode !== null || child.signalCode !== null) {
            return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
            let settled = false;
            const finalize = (): void => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timer);
                child.off('exit', onExit);
                resolve();
            };
            const onExit = (): void => finalize();
            child.once('exit', onExit);
            const timer = setTimeout(finalize, timeoutMs);
        });
    }

    /**
     * Recover cases where one framed body contains:
     * - first complete JSON-RPC payload
     * - plus leading bytes of next `Content-Length` frame
     */
    private recoverFramedJson(body: string): { json: string; rest: string } | null {
        const start = body.search(/\S/);
        if (start < 0 || (body[start] !== '{' && body[start] !== '[')) {
            return null;
        }

        let depth = 0;
        let inString = false;
        let escapeNext = false;

        for (let i = start; i < body.length; i++) {
            const ch = body[i];

            if (inString) {
                if (escapeNext) {
                    escapeNext = false;
                    continue;
                }
                if (ch === '\\') {
                    escapeNext = true;
                    continue;
                }
                if (ch === '"') {
                    inString = false;
                }
                continue;
            }

            if (ch === '"') {
                inString = true;
                continue;
            }
            if (ch === '{' || ch === '[') {
                depth++;
                continue;
            }
            if (ch === '}' || ch === ']') {
                depth--;
                if (depth === 0) {
                    const json = body.slice(start, i + 1);
                    const rest = body.slice(i + 1);
                    return { json, rest };
                }
            }
        }

        return null;
    }

    /**
     * 释放传输连接。
     * socket 模式：仅销毁 TCP 连接，不 kill 进程——依赖 server 检测连接断开后自主关闭；
     * 同时置空 process，避免后续 sendRaw 回退写 stdin（socket 模式 server 不读 stdin）。
     * stdio 模式：kill 子进程（已由 LSP exit 通知触发退出，此处兜底）。
     */
    public stop(): void {
        this.isClosing = true;
        if (this.socket) {
            this.socket.destroy();
            this.socket = null;
            this.process = null;
            return;
        }
        const child = this.process;
        if (!child) {
            return;
        }
        this.process = null;
        const alive = child.exitCode === null && child.signalCode === null;
        if (alive) {
            try {
                child.kill();
            } catch {
                // 进程可能已自行退出，kill 抛 ESRCH/EPERM 时忽略
            }
        }
    }
}
