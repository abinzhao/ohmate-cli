/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { createHash } from 'node:crypto';
import { problemAttachmentType, PROBLEM_LIMITS } from './zip.js';

// Only bounded headers/trailers survive verification. Attachment bytes are
// inert, never extracted, decoded as images, displayed or included in receipts.
export function attachmentVerifier(path: string) {
  const type = problemAttachmentType(path);
  if (!type) { throw new Error('PROBLEM_FILE_ROLE'); }
  const hash = createHash('sha256'), decoder = new TextDecoder('utf8', { fatal: true });
  let size = 0, prefix = Buffer.alloc(0), tail = Buffer.alloc(0);
  return {
    visit(chunk: Buffer) {
      size += chunk.length;
      if (size > PROBLEM_LIMITS.maxFileBytes) { throw new Error('PROBLEM_LIMIT'); }
      hash.update(chunk);
      if (prefix.length < 33) { prefix = Buffer.concat([prefix, chunk.subarray(0, 33 - prefix.length)]); }
      tail = chunk.length >= 12 ? Buffer.from(chunk.subarray(-12)) : Buffer.concat([tail, chunk]).subarray(-12);
      if (type === 'text') {
        try {
          if (decoder.decode(chunk, { stream: true }).includes('\0')) { throw new Error('PROBLEM_ATTACHMENT_INVALID'); }
        } catch { throw new Error('PROBLEM_ATTACHMENT_INVALID'); }
      }
    },
    finish(expectedSize: number, expectedHash?: string) {
      if (!size || size !== expectedSize) { throw new Error('PROBLEM_FILE_SIZE'); }
      if (type === 'text') {
        try { decoder.decode(); } catch { throw new Error('PROBLEM_ATTACHMENT_INVALID'); }
      } else if (type === 'png') {
        if (size < 45 || !prefix.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
          !prefix.subarray(8, 16).equals(Buffer.from('0000000d49484452', 'hex')) ||
          !tail.equals(Buffer.from('0000000049454e44ae426082', 'hex'))) { throw new Error('PROBLEM_ATTACHMENT_INVALID'); }
      } else if (size < 4 || !prefix.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ||
        !tail.subarray(-2).equals(Buffer.from([255, 217]))) { throw new Error('PROBLEM_ATTACHMENT_INVALID'); }
      const digest = hash.digest('hex');
      if (expectedHash && expectedHash !== digest) { throw new Error('PROBLEM_HASH_MISMATCH'); }
      return { size, sha256: digest, type };
    },
  };
}
