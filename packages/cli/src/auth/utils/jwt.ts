/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { JwtPayload } from '../types/auth-types';

/**
 * 解析 JWT Token 的 payload 部分
 * @param token JWT Token 字符串
 * @returns 解析后的 payload 对象，如果格式无效则返回 null
 *
 */
export function parseJwtPayload<T = JwtPayload>(token: string): T | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      return null;
    }

    const payload = parts[1];
    // Base64Url 解码
    const base64Url = payload.replace(/-/g, '+').replace(/_/g, '/');
    // 补齐 Base64 填充
    const base64 = base64Url.padEnd(
      base64Url.length + ((4 - (base64Url.length % 4)) % 4),
      '='
    );
    // 解码为 UTF-8 字符串
    const json = Buffer.from(base64, 'base64').toString('utf8');

    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

/**
 * 验证 JWT Token 格式是否有效
 * @param token JWT Token 字符串
 * @returns 如果格式有效返回 true，否则返回 false
 */
export function isValidJwtFormat(token: string): boolean {
  const parts = token.split('.');
  return parts.length === 3 && parts.every((part) => part.length > 0);
}
