/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { join } from 'node:path';

/**
 * 签名服务相关端点
 */
export const SignatureEndpoints = {
  /** 签名使用的 base url */
  BASE_URL: 'https://connect-api.cloud.huawei.com',

  /** 证书列表查询路径 */
  CERT_LIST_PATH: '/api/cps/harmony-cert-manage/v1/cert/list',

  /** 证书删除路径 */
  CERT_DELETE_PATH: '/api/cps/harmony-cert-manage/v1/cert/delete',

  /** 证书添加路径 */
  CERT_ADD_PATH: '/api/cps/harmony-cert-manage/v1/cert/add',

  /** 证书下载链接申请路径 */
  CERT_DOWNLOAD_URL_PATH: '/api/amis/app-manage/v1/objects/url/reapply',

  /** 设备添加路径 */
  DEVICE_ADD_PATH: '/api/cps/device-manage/v1/device/add',

  /** 设备列表查询路径 */
  DEVICE_LIST_PATH: '/api/cps/device-manage/v1/device/list',

  /** provision添加路径 */
  PROVISION_ADD_REAL_PATH:
    '/api/cps/provision-manage/v1/ide/real/provision/add',

  /** provision添加路径 */
  PROVISION_ADD_TEST_PATH:
    '/api/cps/provision-manage/v1/ide/test/provision/add',

  /** provision删除路径 */
  PROVISION_DELETE_PATH: '/api/cps/provision-manage/v1/provision/delete',
} as const;

/**
 * 证书相关常量
 */
export const CertConstants = {
  /** 自动 debug 签名生成的证书名称前缀 */
  CERT_NAME_PREFIX: 'auto_debug_',

  /** 自动 release 签名生成的证书名称前缀 */
  CERT_NAME_PREFIX_RELEASE: 'auto_release_',

  /** 证书类型：1=debug 证书，2=release 证书 */
  CERT_TYPE_DEBUG: '1',
  CERT_TYPE_RELEASE: '2',

  /** teamId 中的非法字符 */
  TEAM_ID_INVALID_CHARS: /[\\/.:]/g,

  /** 证书格式规范 */
  CERT_PATTERN: /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/,

  /** 默认key值 */
  TARGET_FRIENDLY_NAME: 'debugKey',

  CERTIFICATE_PATTERN_GLOBAL:
    /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,

  /** bundleName正则表达 */
  BUNDLE_NAME_REGEX: /^[a-zA-Z][a-zA-Z0-9._-]*$/,

  /** 证书起始格式 */
  CERT_BEGIN_HEADER: '-----BEGIN CERTIFICATE-----',

  /** 证书保存目录（相对用户主目录） */
  CERT_SAVE_DIR: join('.ohos', 'config'),

  /** 下载连接超时（ms） */
  DOWNLOAD_CONNECT_TIMEOUT_MS: 5000,
} as const;

/**
 * 云侧响应判定常量（对齐 AutoSigningConfigsService）
 */
export const SignatureResponseSignals = {
  /** 响应体含此子串表示成功 */
  SUCCESS_MARKER: '"code":0',

  /** 返回结果为空 */
  SQUARE_BRACKETS: '[]',

  /** statusCode=403 时 reason phrase 精确匹配此串 */
  OPENPROXY_BLOCKED_URL: 'Openproxy_Blocked_URL_list',

  /** 响应体含此 ret.code 表示证书数量上限 */
  CERT_LIMIT_CODE: '205389872',

  /** 响应体含此 ret.code 表示非 Harmony 用户（USER_NOT_HARMONY_ALLOW） */
  USER_NOT_HARMONY_CODE: '205389904',

  /** device number exceeds limit */
  DEVICE_EXCEEDS_LIMIT_CODE: '205389859',

  /** deviceName is repeat */
  DEVICE_NAME_REPEAT_CODE: '205389857',

  /** test provision exceeds limit */
  PROVISION_EXCEEDS_LIMIT_CODE: '205389938',

  /** provision name is repeat */
  PROVISION_NAME_REPEAT_CODE: '205389830',
} as const;

/**
 * HTTP 状态码
 */
export const SignatureHttpStatusCode = {
  FORBIDDEN: 403,
  UNAUTHORIZED: 401,
} as const;

/**
 * 签名相关错误信息
 */
export const SignatureErrorMessages = {
  ERR_FORBIDDEN:
    'You do not have AppGallery Connect permissions for the current team. Request access from the team administrator or switch to a team where you have permissions.',

  ERR_UNAUTHORIZED: 'Invalid AccessToken. Sign in and try again.',

  ERR_CERT_LIMIT_REACHED:
    'The number of certificates has reached the limit. Delete some certificates and try again.',

  ERR_CERT_NETWORK_ERROR:
    'Ensure the external network connection is available before downloading the certificate.',

  ERR_CERT_INVALIDATE: 'The downloaded .cer file is invalid. Try again.',

  ERR_DOWNLOAD_CER:
    'Failed to download the certificate file. Check the following configurations: Network connection, HTTP Proxy, etc.',

  ERR_USER_NOT_HARMONY:
    'The user is not in harmony allow list, please grant the permission',

  ERR_READ_CSR: 'Failed to read the .csr file, please try again later',

  ERROR_WHILE_ADD_DEVICE: 'Failed to add the device, please try again.',
  DEVICE_LIMIT_REACHED:
    'The number of devices has reached the limit. Delete some unused devices and try again.',
  DEVICE_NAME_REPEAT: 'Duplicate device name, please try again.',
  DEVICE_LIST_EMPTY: 'No devices available.',

  ADD_PROFILE_FAIL: 'Failed to add the profile, please try again.',
  NO_AGC_PERMISSION:
    'You do not have the AppGallery Connect permission with the current team. Apply for the permission form the team administrator, or switch to a team with which you already have the permission.',
  ERROR_WHILE_DOWNLOAD_PROFILE:
    'Failed to download the profile, please try again.',
  PROFILE_NAME_REPEAT: 'The profile name already exists in the AGC.',
  ERROR_WHILE_PARSE_PROFILE: 'Failed to parse the profile, please try again.',
  TEST_PROVISION_EXCEEDS_LIMIT: 'Provision number exceeds limit.',

  CERTIFICATION_AND_PROFILE_NOT_INCONSISTENT:
    'The certificate application file is inconsistent with the file in profile, please try again.',
  CERTIFICATE_HAS_EXPIRED:
    'The signature does not take effect or has expired. It may be the current system time is inaccurate, please calibrate the system time and sign again.',

  ERROR_SIGN_BUNDLE_NAME_VALIDATE:
    'The bundle name contains 7 to 128 characters, including only letters, digits, and underscores (_). It must be start with a letter and contain at least three segments separated by periods (.), each of the segments ending with a digit or letter.',
} as const;

/**
 * 环境预检相关错误信息
 */
export const EnvCheckMessages = {
  // ── env-checker.ts ──
  TOOLCHAIN_INIT_FAILED: 'Auto-sign failed: unable to initialize toolchain',

  // ── auth-checker.ts ──
  LOGIN_REQUIRED:
    'Failed to automatically generate signatures.Run devecocli auth login to sign in.',
  TEAM_INFO_FAILED:
    'Failed to obtain user team information.Check the network connection, HTTP proxy, and other configurations.',
  REALNAME_REQUIRED:
    'Users without real-name verification are not supported.Complete real-name verification in AppGallery Connect.',
  SESSION_EXPIRED: 'User session expired or token invalid. Please login again.',
  REGION_CHINA_ONLY:
    'This feature is only available for accounts registered in Chinese mainland.',

  // ── device-checker.ts ──
  DEVICE_MISSING:
    'Unable to create the profile file due to missing devices.Connect a device through IP or USB, or manually add a device in AppGallery Connect first.If you are installing the HAP package on an emulator, you can skip the signing step.',
  DEVICE_DETECT_FAILED:
    'Unable to detect devices. Please check hdc status. If installing HAP on an emulator, signature step can be skipped.',

  // ── project-checker.ts ──
  PROJECT_DIR_MISSING:
    'Not in a valid project directory (project-level build-profile.json5 not found).',
  ATOMIC_SERVICE_UNSUPPORTED:
    'AtomicService projects are not yet supported. Please configure signing manually.',
} as const;
