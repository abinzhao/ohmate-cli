/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRuntime } from '../packages/cli/dist/runtime.js';

const runtime = await createRuntime();
const tools = runtime.registry.describe();
const snapshot = JSON.parse(await readFile(new URL('../upstream-baseline.json', import.meta.url), 'utf8'));
const product = JSON.parse(await readFile(new URL('../packages/cli/package.json', import.meta.url), 'utf8'));
const legacy = tools.filter((tool) => tool.adapter === 'legacy-child');
const catalog = {
  schemaVersion: '1.0',
  toolVersion: product.version,
  upstreamSnapshotHash: snapshot.snapshotHash,
  registered: tools.length,
  legacyRegistered: legacy.length,
  legacyCommandHash: createHash('sha256').update(JSON.stringify(legacy)).digest('hex'),
  tools,
};
const directory = new URL('../artifacts/contracts/', import.meta.url);
const cell = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
const code = (value) => `\`${cell(value).replace(/`/g, '&#96;')}\``;
const lines = [
  '# OHMate 完整命令参考',
  '',
  '此文件由 `npm run catalog` 从已构建 Runtime 自动生成。修改命令后先构建，再生成；',
  '`npm run check:catalog` 检查漂移。登记、风险等级与可取消声明不等于功能或平台验收通过。',
  '已知限制以命令帮助和实际回执为准，操作流程见 [使用说明](usage.md)。',
  '',
  `产品版本：${product.version}；公开 ToolSpec：${tools.length}；隔离底座入口：${legacy.length}。`,
  'JSON Schema、选项默认值及完整合同见 [command-catalog.json](command-catalog.json)。',
  '',
  '## 通用入口',
  '',
  '所有条目都可用 `ohmatecli <命令> --help` 查看实时帮助。',
  '`execute <toolId> --input <JSON>` 或 `--input-file <公共JSON文件>` 使用完整 Schema；',
  '两种输入方式互斥，不能混入该工具的专用参数。底座工具的结构化输入为 `{"argv":[...]}`。',
  '带默认值的字段可省略；Schema 序列化中的 required 不改变运行时默认值。',
  '选项中 `<value>` 表示选项出现时须带值，只有 mandatory=true 才表示必须提供该选项。',
  '',
  '| 全局选项 | 用途 |',
  '| --- | --- |',
  '| `--project <path>` | 明确工程根；设备与构建操作仍检查能力和目标 |',
  '| `--format json` | 单个统一回执；协议入口保留原协议流 |',
  '| `--lang zh-CN` / `--lang en-US` | 输出语言，稳定字段与枚举不翻译 |',
  '| `--non-interactive` | 不等待交互，待审批返回 5 |',
  '| `--approve-plan <id>` | 在原参数、工程与文件指纹不变时消费审批计划 |',
  '| `--raw` | 底座原始输出流 |',
  '',
  '## 命令索引',
  '',
  '| Tool ID | CLI 命令 | 风险 | 实现入口 |',
  '| --- | --- | --- | --- |',
];
const sorted = [...tools].sort((a, b) => a.id.localeCompare(b.id, 'en'));
for (const tool of sorted) {
  lines.push(`| [${tool.id}](#${tool.id.replaceAll('.', '-')}) | ${code(tool.command.join(' '))} | ${tool.risk} | ${tool.adapter} |`);
}
for (const tool of sorted) {
  lines.push('', `<a id="${tool.id.replaceAll('.', '-')}"></a>`, `## ${tool.id}`, '',
    cell(tool.description), '', '```bash', `ohmatecli ${tool.command.join(' ')} --help`, '```', '',
    `风险 ${tool.risk}；前提 ${tool.requirements.length ? tool.requirements.join(', ') : '无声明前提'}；` +
    `超时 ${tool.timeoutMs} ms；可取消 ${tool.cancellable ? '是' : '否'}；恢复 ${tool.recovery}。`);
  if (tool.protocol) lines.push('', '此入口输出原协议流，错误写入 stderr。');
  if (tool.arguments?.length) {
    lines.push('', '| 位置参数 | 必填 | 多值 |', '| --- | --- | --- |');
    for (const argument of tool.arguments) {
      lines.push(`| ${code(argument.name)} | ${argument.required ? '是' : '否'} | ${argument.variadic ? '是' : '否'} |`);
    }
  }
  if (tool.options?.length) {
    lines.push('', '| 选项 | 含义 | 默认值 | 必须提供 |', '| --- | --- | --- | --- |');
    for (const option of tool.options) {
      const choices = option.choices?.length ? `；取值：${option.choices.map(code).join(', ')}` : '';
      lines.push(`| ${code(option.flags)} | ${cell(option.description)}${choices} | ${option.defaultValue === undefined ? '未声明' : code(JSON.stringify(option.defaultValue))} | ${option.mandatory ? '是' : '否'} |`);
    }
  } else {
    lines.push('', '无命令专用选项；完整结构化输入以 JSON Schema 为准。');
  }
}
const json = `${JSON.stringify(catalog, null, 2)}\n`;
const outputs = [
  [new URL('command-catalog.json', directory), json],
  [new URL('../docs/command-catalog.json', import.meta.url), json],
  [new URL('../docs/commands.md', import.meta.url), `${lines.join('\n')}\n`],
];
if (process.argv.slice(2).some((arg) => arg !== '--check')) {
  throw new Error('Only --check is supported');
}
if (process.argv.includes('--check')) {
  for (const [file, content] of outputs) {
    if (await readFile(file, 'utf8').catch(() => null) !== content) {
      throw new Error(`Catalog drift: ${file.pathname}; run npm run catalog`);
    }
  }
} else {
  await mkdir(directory, { recursive: true });
  for (const [file, content] of outputs) await writeFile(file, content);
}
console.log(`Registered ${tools.length} ToolSpecs (${legacy.length} bundled command nodes).`);
