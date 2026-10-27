# Hvigor 接入与便携 Skill

`integrate hvigor` 使用 `readProject`、`readSnapshot` 和 `inspectPatch` 形成实际
文件 Diff；审批、写入、撤回和恢复都使用已有 Runtime/Patch 协议。
根级默认导出须包含一个字面量 `plugins` 数组。工具插入一个独立 import 和
`ohmatePlugin()` 调用，保留其它插件与原始注释，不执行现有工程源码。
动态导出、计算属性、重复插件字段、已占用绑定和已有生成文件均拒绝。

生成插件仅使用官方 `HvigorPlugin.apply`、`HvigorNode.registerTask`、
`HvigorTask.run` 和 `NormalizedFile.getPath()`。本机验证来源为 Hvigor
6.26.4 的 `types/index.d.ts`；官方声明 SHA-256 随真实运行回执保存。
插件在目标工程解析 `@ohmate/cli-common/dist/cli.js`，使用当前 Node、argv、
明确 cwd、`shell:false`、超时和输出预算；不保存本机可执行路径。

| Hvigor 任务 | 同源工具 | 当前行为 |
| --- | --- | --- |
| `ohmatecliScan` | `scan` | Producer 缺失，退出码 3 |
| `ohmatecliDocs` | `docs.check` | Producer 缺失，退出码 3 |
| `ohmatecliTest` | `task.submit` → `test.local` | 创建待审批持久任务，退出码 5；退出 Hvigor 后审批执行 |
| `ohmatecliVerifyRelease` | `release.verify` | 当前工程的 14 项门禁；没有构建身份时保持 incomplete |

不把非零回执转为 Hvigor 成功。内部 dispatcher 只接受固定任务名和 Test
的 `submit` 开关，不支持任意 executable、工具 ID 或 argv。独立 CLI 可直接
执行带明确 product/module/manifest 的完整测试和 Release 命令。
目前薄任务不提供这些范围参数；Scan/Docs Producer 仍须继续实现。

`skill export` 从公开 Registry 生成一个 `ohmate-cli` 文件夹，位于私有
artifact store 的唯一父目录下。三个文件分别为简短 `SKILL.md`、
逐工具 `commands.json`、双文件哈希与 Registry 哈希 `manifest.json`。
导出不复制选项默认值和示例，不携带任何执行输入、环境、凭据或设备实例。
底座的精确命令、风险、协议、参数、选项与 JSON Schema 和原生命令一起记录；
Runtime 中无法表示为 JSON Schema 的限制仍在实际执行时检查。

`skill verify` 不执行文件。校验目录/文件链接、文件集合、1 MiB 单文件上限、
frontmatter、名称、引用、版本、哈希、入口和逐工具 Schema 漂移。
额外文件、重复命令和重算哈希后的入口篡改均被拒绝。
命令漂移返回 1；链接或私密输入返回 4。导出文件供手动分发，正文不授予权限。

验证脚本 `scripts/verify-integration.mjs` 在私有临时根中审批创建真实应用，
执行官方构建、任务目录、Scan 缺能力失败、Test 待审批及真实 Local Test、
Release 非就绪、Skill CLI/HTTP 校验与逐字节恢复。构建/原始官方日志和导出
保存在不可覆盖的验收目录；临时应用、工具 HOME 和 Web 服务最终清理。
无设备、云、签名或发布动作；macOS 验证不代表其它平台通过。
