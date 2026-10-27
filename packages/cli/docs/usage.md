# OHMate 使用说明

适用于本地开发者和通过 shell 调用工具的 Agent。源码产品根为 `OHMate-CLI/`；
以下源码命令在此目录执行。`ohmatecli` 表示已经安装的本地包入口。
版本 0.1.0，Node.js >=22.19.0；尚未公开发布到 npm。

## 安装与第一份检查

```bash
npm ci --ignore-scripts
npm run build
node packages/cli-wrapper/cli.js --help
node packages/cli-wrapper/cli.js doctor --format json
node packages/cli-wrapper/cli.js project inspect --project /absolute/app --format json
node packages/cli-wrapper/cli.js deps analyze --project /absolute/app --format json
```

帮助与依赖分析无需模型或设备。`project inspect` 读取真实工程标记；
工具源码根不是 HarmonyOS 应用，应用任务必须使用真实应用根。
缺少必需工具或证据会返回 3；读取不完整不能解释为检查通过。
源码构建不会全局安装 bin；可以使用仓库内 `bin/ohc`，或始终使用
`node packages/cli-wrapper/cli.js`。
本地 npm 包由维护者生成并验证后安装；本说明不引用尚不存在的公开 registry 包。

## CLI 交互终端

```bash
bin/ohc --project /absolute/app
# 安装或 npm link 后
ohc --project /absolute/app
# 等价显式入口
node packages/cli-wrapper/cli.js agent chat --project /absolute/app
```

`ohc` 是 `ohmatecli` 的短别名；`ohc --web` 等价于 `ui`。

双 TTY 终端中无参数启动交互；管道或无 TTY 环境显示帮助。
运行 `/help` 查看当前快捷命令：

| 输入 | 作用 |
| --- | --- |
| `/execute doctor {}` | 调用确定性工具，无需模型 |
| `/models` | 列出已保存模型配置 |
| `/trae` | 从 PATH 中的 TRAE CLI 发现模型 |
| `/trae /absolute/path/to/trae-cli` | 使用明确可执行文件 |
| `/model CONFIG_ID` | 选择模型配置 |
| `/files entry/src/main/ets/pages/Index.ets` | 选择发送材料；多路径用逗号分隔 |
| `/write entry/src/main/ets/pages/Index.ets` | 允许 Agent 对这些精确路径提出 Patch |
| `/tools workspace.read` | 指定允许调用的工具 ID；多个用逗号分隔 |
| `/session SESSION_ID` | 选择续聊会话 |
| `/exit` | 退出交互终端 |

发送自然语言前审查材料和工具范围，再确认发送。文件被选中只授予读取范围；
写入需单独的路径声明与审批。文件、模型或会话内容改变后必须重新预览。
Ctrl+C 请求取消，等待所属进程收尾；取消不会撤销已完成的工程写入。

## Web 工作台

```bash
node packages/cli-wrapper/cli.js ui --project /absolute/app --no-open --format json
node packages/cli-wrapper/cli.js ui status --format json
node packages/cli-wrapper/cli.js project register /absolute/app --format json
node packages/cli-wrapper/cli.js project list --format json
node packages/cli-wrapper/cli.js ui stop --format json
```

从启动回执打开本机 URL。默认监听 `127.0.0.1` 随机端口；
`--no-open` 保留服务并只返回地址。关闭网页不删除后台任务。
工作台启动根改变时，先停止旧工作台再启动；网页可以切换已登记应用。

在“模型连接”中发现或选择模型，在新任务中选择材料并确认上下文。
任务页显示计划、Diff、审批、取消、恢复与回执；报告页查看真实任务产物。
`ui layout/find/wait` 是设备命令，通过各自帮助查看参数。
认证失效后重新从工作台入口获取访问，不复制 token 到聊天或日志。

## TRAE CLI 模型

先在用户自己的 TRAE CLI 完成登录，确保 `trae-cli` 在 PATH，或传入绝对路径。

```bash
node packages/cli-wrapper/cli.js model trae-cli --format json
node packages/cli-wrapper/cli.js model list --format json
node packages/cli-wrapper/cli.js model select CONFIG_ID
node packages/cli-wrapper/cli.js model check CONFIG_ID --format json
```

发现使用 `models --json`，不选择模型、不发送提示词。
`model check` 会发起真实小型探测，可能产生费用；只在准备验证时执行。
Agent 通过独立临时 `app-server --stdio` 会话调用模型，
工具提案回到 OHMate Runtime。认证由 TRAE CLI 管理，OHMate 不复制其凭据。
本机 TRAE CLI 0.211.1 的 `Doubao-Seed-2.1-Turbo` 已验证文本、
工具往返、续聊和取消；其他发现模型需要分别验证。

公开 IDE 模型桥是另一条接入路径，见
[模型桥说明](trae-model-bridge.md)。其协议测试不等于真实 IDE 宿主认证通过。
其他 BYOK 配置和上下文预算见 [详细模型合同](command-guide.md#会话模型与终端)。

## Headless Agent

```bash
node packages/cli-wrapper/cli.js context preview --prompt "检查代码" \
  --files entry/src/main/ets/pages/Index.ets --allowed-tools workspace.read \
  --project /absolute/app --format json

node packages/cli-wrapper/cli.js agent run "检查代码" \
  --files entry/src/main/ets/pages/Index.ets --allowed-tools workspace.read \
  --preview-hash REVIEWED_HASH --project /absolute/app --format json
```

第二条命令使用第一条回执中的已审查预览哈希；传入相同材料、模型和会话。
不得把 `REVIEWED_HASH` 当作固定值。默认没有 Patch 范围，
默认 64 KiB 材料预算；大工程应选择与任务有关的文件。
续聊使用 `--session-id`，历史变化使旧哈希失效；不自动恢复付费模型请求。

## 任务与审批

```bash
node packages/cli-wrapper/cli.js task submit doctor --wait --format json
node packages/cli-wrapper/cli.js task list --format json
node packages/cli-wrapper/cli.js task show TASK_ID --format json
node packages/cli-wrapper/cli.js task events TASK_ID --after 0 --format ndjson
node packages/cli-wrapper/cli.js task approve TASK_ID PLAN_ID --wait --format json
node packages/cli-wrapper/cli.js task cancel TASK_ID --format json
node packages/cli-wrapper/cli.js task resume TASK_ID --wait --format json
```

工具 ID 使用 [命令参考](commands.md) 中的值，例如 `build.run`。
`task submit --payload <JSON>` 是被提交工具的输入；
`--input <JSON>` 则是当前命令的完整 Schema。协议服务不进入后台任务。
`task show` 退出 0 仅表示查询成功，任务本身的退出码在 `data.receipt`。

R2/R3 操作首次返回 5 和 `planId`。直接命令审批时，用完全相同输入追加
`--approve-plan PLAN_ID`；后台任务用 `task approve`。计划十分钟过期、
一次性使用，并绑定参数、工程、源码及版本。文件或输入改变后重新生成计划。
写操作不会因 `resume` 自动重放；同工程写互斥，worker 异常退出后的锁释放
可能需要十五秒，期间返回 `RESOURCE_BUSY`。

## 工程检查与交付

```bash
node packages/cli-wrapper/cli.js build plan --project /absolute/app --format json
node packages/cli-wrapper/cli.js test plan --project /absolute/app --format json
node packages/cli-wrapper/cli.js deps sbom --standard cyclonedx --project /absolute/app --format json
node packages/cli-wrapper/cli.js skill export --format json
node packages/cli-wrapper/cli.js skill verify --path EXPORTED_DIRECTORY --format json
```

`build run`、`test local/instrument` 和配置修改先检查计划与工具前提，再审批。
当前 Instrument 真机执行不可用，`--build-only` 只证明测试 HAP 构建。
基础 SBOM 已实现，不能代替完整生产构建闭包与漏洞、许可证实物审计。
`release verify` 缺 producer 时保持 incomplete，不能作为发布授权。

离线分析输入必须属于已支持格式，当前各分析器只覆盖有界子集。
`replay` 提供导入、校验、只读计划与分页，不执行真实设备重放。
设计、海报、受控更新等能力以命令帮助和实际回执为准；未运行能力不视为已验收。

## 结果与故障处理

| 退出码 | 含义与处理 |
| --- | --- |
| 0 | 当前执行范围成功；另检查 evidence 和未验证项 |
| 1 | 发现问题；按 findings 修复后复核 |
| 2 | 参数或工程错误；检查路径与帮助 |
| 3 | 必需能力或证据缺失；按 missing 配置或补证 |
| 4 | Schema、输入或哈希校验失败；重新检查输入 |
| 5 | 待审批或策略拒绝；按 plan 消费审批，不可用能力不会因审批解锁 |
| 6 | 工具错误；读取回执和 stderr |
| 130 | 取消并完成当前收尾；检查已完成写入及未清理责任 |

| 现象 | 检查方式 |
| --- | --- |
| 源码修改未生效 | 重新 `npm run build`；源码入口读取构建后的 bundle |
| 找不到 `ohmatecli` | 使用源码 Node 入口，或安装已验证的本地包 |
| 终端只显示帮助 | 在真实双 TTY 终端中执行 |
| Web 启动根冲突 | `ui status` 检查，再显式 `ui stop` 后重启 |
| TRAE 可执行文件找不到 | 用 `model trae-cli --executable /absolute/path` |
| 模型调用失败 | 在 TRAE CLI 检查登录和模型可用性，再显式 `model check` |
| 上下文超限 | 选择更少相关文件；不要把产品仓库规则充当应用上下文 |
| 计划过期或指纹变化 | 同范围重新预览和生成计划 |
| 文档检索缺归档 | 补齐有来源与哈希的官方 `docs.zip/index.zip` |

数据默认保存在 `~/.local/share/ohmate`，可用 `OHMATE_DATA_DIR` 指定隔离目录。
语言用 `OHMATE_LANG` 或 `--lang`。默认无遥测、无自动更新、无全局 Skill 迁移。
密钥通过环境变量引用，不用 argv、回执或浏览器持久化。
完整命令行为见 [command-guide.md](command-guide.md)，权限事实以运行时回执为准。
