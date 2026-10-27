/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

export interface HmErrorOptions {
  code?: string;
  details?: Record<string, unknown>;
  cause?: Error;
}

export class HmError extends Error {
  code: string;
  details: Record<string, unknown> | undefined;
  constructor(message: string, options: HmErrorOptions = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = options.code || (new.target as { code?: string }).code || 'HM_ERROR';
    this.details = options.details;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }
}

export class HdcError extends HmError {
  static code = 'HDC_ERROR';
  args: string[];
  stderr: string;
  constructor(message: string, options: HmErrorOptions & { details?: Record<string, unknown> } = {}) {
    super(message, { ...options, code: options.code || 'HDC_ERROR' });
    this.args = (options.details?.args as string[]) || [];
    this.stderr = (options.details?.stderr as string) || '';
  }
}

export class HdcTimeoutError extends HdcError {
  static code = 'HDC_TIMEOUT';
  constructor(message: string, options: HmErrorOptions = {}) {
    super(message, { ...options, code: 'HDC_TIMEOUT' });
  }
}

export class HdcCommandError extends HdcError {
  static code = 'HDC_COMMAND_FAILED';
  constructor(message: string, options: HmErrorOptions = {}) {
    super(message, { ...options, code: 'HDC_COMMAND_FAILED' });
  }
}

export class DeviceError extends HmError {
  static code = 'DEVICE_ERROR';
  constructor(message: string, options: HmErrorOptions = {}) {
    super(message, { ...options, code: options.code || 'DEVICE_ERROR' });
  }
}

export class DeviceNotFoundError extends DeviceError {
  static code = 'DEVICE_NOT_FOUND';
  constructor(message: string, options: HmErrorOptions = {}) {
    super(message, { ...options, code: 'DEVICE_NOT_FOUND' });
  }
}

export class DeviceFileError extends DeviceError {
  static code = 'DEVICE_FILE_ERROR';
  constructor(message: string, options: HmErrorOptions = {}) {
    super(message, { ...options, code: 'DEVICE_FILE_ERROR' });
  }
}

export class RpcError extends HmError {
  static code = 'RPC_ERROR';
  endpoint: string;
  constructor(message: string, options: HmErrorOptions = {}) {
    super(message, { ...options, code: options.code || 'RPC_ERROR' });
    this.endpoint = (options.details?.endpoint as string) || '';
  }
}

/** Lifecycle errors: resource push / process start / port forwarding / readiness probe failure */
export class RpcLifecycleError extends RpcError {
  static code = 'RPC_LIFECYCLE_ERROR';
  constructor(message: string, options: HmErrorOptions = {}) {
    super(message, { ...options, code: 'RPC_LIFECYCLE_ERROR' });
  }
}

/**
 * Request made after endpoint has been disposed.
 * Unlike RpcLifecycleError: this is a **terminal state**, retrying is meaningless,
 * and the disposed process must never be restarted for retry purposes.
 */
export class RpcDisposedError extends RpcLifecycleError {
  static code = 'RPC_DISPOSED';
  constructor(message: string, options: HmErrorOptions = {}) {
    super(message, { ...options, code: 'RPC_DISPOSED' });
  }
}

/** Transport layer: socket error / close / ECONNREFUSED / EPIPE */
export class RpcTransportError extends RpcError {
  static code = 'RPC_TRANSPORT_ERROR';
  constructor(message: string, options: HmErrorOptions = {}) {
    super(message, { ...options, code: 'RPC_TRANSPORT_ERROR' });
  }
}

/** Request timeout or connection idle timeout (hypium hangs forever here; we must reject) */
export class RpcTimeoutError extends RpcError {
  static code = 'RPC_TIMEOUT';
  constructor(message: string, options: HmErrorOptions = {}) {
    super(message, { ...options, code: 'RPC_TIMEOUT' });
  }
}

/** Framing error / request_id mismatch / JSON parse failure */
export class RpcProtocolError extends RpcError {
  static code = 'RPC_PROTOCOL_ERROR';
  constructor(message: string, options: HmErrorOptions = {}) {
    super(message, { ...options, code: 'RPC_PROTOCOL_ERROR' });
  }
}

/**
 * Remote business exception (response body exception != null).
 * The connection is healthy for these errors; reset and retry are prohibited.
 */
export class RpcRemoteError extends RpcError {
  static code = 'RPC_REMOTE_ERROR';
  remote: unknown;
  constructor(message: string, options: HmErrorOptions = {}) {
    super(message, { ...options, code: 'RPC_REMOTE_ERROR' });
    this.remote = options.details?.remote;
  }
}

/**
 * Whether the error is "link-level": the socket is no longer usable and must be reset and rebuilt.
 */
export function isTransportLevelError(err: unknown): boolean {
  return (
    err instanceof RpcTransportError ||
    err instanceof RpcTimeoutError ||
    err instanceof RpcProtocolError
  );
}

/**
 * Whether "reset + rebuild + retry" is allowed. Returns false for business exceptions.
 */
export function isRecoverableRpcError(err: unknown): boolean {
  if (err instanceof RpcDisposedError) {
    return false;
  }
  return isTransportLevelError(err) || err instanceof RpcLifecycleError;
}
