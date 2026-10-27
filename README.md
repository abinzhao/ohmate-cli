# OHMate CLI

基于指定 DevEco CLI 源码快照的 HarmonyOS 开发工具。入口为
`@ohmate/ohmatecli` / `ohmatecli`；终端、Web 和 Agent 共用 Runtime、
命令 Schema、任务、审批及回执。保留 Huawei MIT 版权，来源见
[upstream-baseline.json](upstream-baseline.json)。

当前为本地开发版，尚未发布到 npm。CLI、Web、任务与 TRAE CLI
Seed-2.1-Turbo 已有本机实际验证；完整产品和 GA 尚未验收。

## 开始使用

需要 Node.js >=22.19.0。在此产品目录执行：

```bash
npm ci --ignore-scripts
npm run build
node packages/cli-wrapper/cli.js --help
node packages/cli-wrapper/cli.js doctor --format json
node packages/cli-wrapper/cli.js capabilities --format json
```

构建、运行和设备命令需要对应 DevEco Studio / CLT / SDK / HDC；
缺少这些工具时仍可查看帮助、检查工程和分析依赖。

```bash
# 仓库内本地入口（无需全局安装）
bin/ohc --project /absolute/app                 # 交互终端
bin/ohc --web --project /absolute/app           # Web，打开浏览器

# 安装或 npm link 后可直接使用短命令
ohc                                             # 交互终端
ohc --web                                       # Web，打开浏览器
ohc --web --no-open --project /absolute/app     # Web，只输出 URL

# 源码 Node 入口仍然可用
node packages/cli-wrapper/cli.js --project /absolute/app
node packages/cli-wrapper/cli.js --web --no-open --project /absolute/app --format json

# 在已登录的 TRAE CLI 中发现模型，再明确选择
node packages/cli-wrapper/cli.js model trae-cli
node packages/cli-wrapper/cli.js model list
node packages/cli-wrapper/cli.js model select MODEL_CONFIG_ID
```

`ohc` 与 `ohmatecli` 指向同一实现；`--web` 是 `ui` 的快捷入口。
全局安装前需分别 link `packages/cli-common` 与 `packages/cli-wrapper`，
或使用仓库内 `bin/ohc`。

自然语言任务须确认上下文发送范围；R2/R3 操作须消费绑定当前输入的审批计划。
模型列表不代表每个模型都已经通过实际调用。

模型取消会终止本次拥有的进程树，必要时强制结束，等待 stdio 关闭后清理
临时目录；POSIX 下还会清理比 stdio 父进程存活更久的自有进程组。
显式选择的 `.js`、`.mjs`、`.cjs` 模型启动脚本通过当前 Node
执行，无需 POSIX shebang；Windows／Linux 的实际安装与模型验证仍待完成。

构建回执新增 CycloneDX 1.6 SBOM，与 build manifest 绑定文件路径和 SHA-256。
`release verify` 校验其原始字节与当前依赖清单，缺失、篡改或清单不一致会阻断。
此绑定只覆盖已观察的依赖清单，生产编译闭包、许可证、漏洞与 Release 纯度仍待验收。

## 文档入口

| 文档 | 内容 |
| --- | --- |
| [使用说明](docs/usage.md) | 安装、终端、Web、TRAE CLI、任务审批、故障处理 |
| [完整命令参考](docs/commands.md) | 从 Runtime 生成的全部公开命令、参数和执行前提 |
| [命令行为与边界](docs/command-guide.md) | 工程、构建测试、分析、调试、集成及输入预算 |
| [Agent 使用合同](SKILL.md) | 工具调用、上下文和权限边界 |
| [隐私说明](PRIVACY.md) | 数据和认证处理 |

内部实施状态、验收记录和交接快照不随公开仓库发布；能力与验收边界以命令帮助和实际回执为准。

## 开发检查

```bash
npm run typecheck
npm run lint
npm run build
npm run catalog
npm run check:catalog
env TMPDIR=/private/tmp npm test
```

命令参数的唯一事实源是 ToolSpec Registry；修改后先构建，再生成目录。
根 README、SKILL 与 `docs/` 为维护源，包内文档由 `sync-cli-docs.mjs`
同步，不手改生成副本。测试默认最多并行 4 个 worker，限制真实进程和
大型 fixture 复制的 CPU/I/O 争用。默认测试不包含全部独立 Kit、插件或真机验收；
检查通过的范围应按实际执行记录说明。
