# Upstream DevEco CLI reference

Historical source documentation. OHMate behavior is defined by the product README.

<div align="center">
  <h1>DevEco CLI</h1>
  <p>一个面向 HarmonyOS 应用开发的统一命令行入口。</p>
  <p>
    <a href="https://www.npmjs.com/package/@deveco/deveco-cli"><img src="https://img.shields.io/npm/v/@deveco/deveco-cli.svg" alt="NPM Version" /></a>
    <a href="https://www.npmjs.com/package/@deveco/deveco-cli"><img src="https://img.shields.io/npm/dm/@deveco/deveco-cli.svg" alt="NPM Downloads" /></a>
    <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-%3E%3D22-green.svg" alt="Node.js" /></a>
    <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blue.svg" alt="Platform" />
    <a href="https://developer.huawei.com/consumer/cn/download/"><img src="https://img.shields.io/badge/DevEco%20Studio-%3E%3D6.0.0-orange.svg" alt="DevEco Studio" /></a>
    <img src="https://img.shields.io/badge/Command%20Line%20Tools-%3E%3D26.0.0-orange.svg" alt="Command Line Tools" />
    <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="License" /></a>
  </p>
</div>

`DevEco CLI` 将 `DevEco Studio` 工具链统一封装为一个 `CLI`，内置 `ohpm`、`hvigor`、`hdc`、`emulator`、`hilog`，同时集成 HarmonyOS 技能安装、项目脚手架、本地 HarmonyOS 文档检索和 `MCP` 服务。

> 关于数据采集与隐私（遥测打点内容、存储加密、上报及关闭方式），请参阅 [PRIVACY.md](./PRIVACY.md)。


## 快速开始

### 前置要求

- 操作系统为 `macOS` 、 `Windows` 或 `Linux`（需配置对应环境变量）
- 安装`Node.js`，推荐使用22及以上版本
- [DevEco Studio](https://developer.huawei.com/consumer/cn/download/) >= 6.0.0 或 [Command Line Tools](https://developer.huawei.com/consumer/cn/download/) >= 26.0.0
  - **macOS**：必须安装在 `~/Applications` 或 `/Applications` 目录下。

### 安装

```bash
npm install -g @deveco/deveco-cli@latest
```

安装后可以通过以下命令更新到最新版本：

```bash
devecocli update
```

### 最短工作流

```bash
devecocli create --app-name MyApp
cd MyApp
devecocli run
devecocli log --level E
```

### 文档检索

```bash
devecocli docs search List
devecocli docs read 开发指南/UI_Design_Kit_UI设计套件/UI_Design_Kit简介/ui-design-introduction
```

更多命令和参数可通过 `devecocli --help` 或各子命令的 `--help` 查看。

## 环境变量

`devecocli` 当需要使用非默认安装路径、多版本并存时固定选型，Command Line Tools或在Linux下运行时，可通过以下环境变量显式指定工具链根：

| 名称                     | 说明                                                   |
| ------------------------ | ------------------------------------------------------ |
| `DEVECO_CLI_STUDIO_PATH` | 显式指定 DevEco Studio 安装根，优先级最高              |
| `DEVECO_CLI_CLT_PATH`    | 显式指定 Command Line Tools 安装根 |

完整优先级链：

```text
DEVECO_CLI_STUDIO_PATH > DEVECO_CLI_CLT_PATH > Auto_Detect
```

### 平台与版本约束

| 平台    | DevEco Studio Auto_Detect                     | Command Line Tools | 最低版本                      |
| ------- | --------------------------------------------- | ------------------ | ----------------------------- |
| Windows | 支持                                          | 可选               | Studio `6.0.0` / CLT `26.0.0` |
| macOS   | 支持                                          | 可选               | 同上                          |
| Linux   | 不支持                                        | 必选               | CLT `26.0.0`                  |

### 使用示例

```bash
# 设置 DevEco Studio
export DEVECO_CLI_STUDIO_PATH="/Applications/DevEco-Studio.app" （可带或不带尾部 Contents）
devecocli device list

# 设置 CLT
export DEVECO_CLI_CLT_PATH=/opt/command-line-tools
devecocli device list
```

## AI Agent 集成

### Agent 插件

支持插件的 Agent 可加载 DevEco CLI 插件，获得内置 Skill 和 CLI 检查、安装及调用能力。

插件使用方法见 [插件说明](./.plugin/README.md)，支持的 Agent 及其差异由 [平台配置](./.plugin/platforms.json) 定义。

### 命令行安装 Skill / MCP

`DevEco CLI` 支持通过命令行将自身技能添加到 `Agent` 中。下面以 `opencode` 为例展示最短流程：

```bash
# 1. 给 opencode 安装 deveco-cli 技能
devecocli init --agent opencode

# 2. 给 opencode 在当前 HarmonyOS 项目配置 MCP
devecocli init --mcp --agent opencode --project ./MyApp

# 3. 进入项目并启动 opencode
cd MyApp
opencode
```

也支持 `atomcode`等 Agent，使用方式相同：

```bash
# 给 atomcode 安装技能
devecocli init --agent atomcode
```

如果 `Agent` 不在 `--agent` 参数取值范围内，可使用 `--path` 参数进行添加，参考如下命令：

```bash
devecocli init --path D:\work\ARKTS\NewData
```

进入 `Agent` 后可以直接描述任务，例如：

- `Build this project in release mode and run it on my emulator`
- `Tail the last error logs from this app`
- `Check for syntax errors in src/main/ets/pages/Index.ets`

**说明：**
- 在`Windows`上搭配`devecocli`使用`opencode`时，推荐将[powershell 7](https://learn.microsoft.com/en-us/powershell/scripting/install/install-powershell-on-windows?view=powershell-7.6) 作为默认执行终端。
- 在`Windows`上用`opencode`执行devecocli build/emulator start等指令时，若命令结束后终端无法正常退出，建议将默认终端切换为[powershell 7](https://learn.microsoft.com/en-us/powershell/scripting/install/install-powershell-on-windows?view=powershell-7.6)

## 常用命令

| 命令                        | 用途                                        |
| ------------------------- | ----------------------------------------- |
| `devecocli create`        | 创建新的 HarmonyOS 项目                         |
| `devecocli build`         | 构建项目并产出 `.hap` / `.hsp` / `.har` / `.app` |
| `devecocli check lint`    | 检查代码规范并输出实践建议与报告                      |
| `devecocli check arkts`   | 对 `.ets` 源文件执行 ArkTS 静态检查                      |
| `devecocli run`           | 安装并运行应用                                   |
| `devecocli device list`   | 查看当前连接设备                                  |
| `devecocli emulator list` | 查看本地模拟器实例                                 |
| `devecocli ui layout`    | 导出设备屏幕上的 UI 节点树（布局、坐标、节点 ID）           |
| `devecocli ui window list` | 查看设备窗口列表（为 `ui layout` / `ui click` 等提供窗口 ID） |
| `devecocli ui screenshot` | 对真机或模拟器执行 UI 截图                          |
| `devecocli ui click`      | 点击指定坐标或节点 ID                             |
| `devecocli ui swipe`      | 自定义滑动（指定起点、终点和速度）                   |
| `devecocli ui text`       | 输入文本到焦点或指定位置                            |
| `devecocli log`           | 查看 `hilog` 或崩溃日志                          |
| `devecocli verify`        | 根据自然语言测试计划执行 UI 意图校验              |
| `devecocli docs search`   | 搜索本地 HarmonyOS 文档                         |
| `devecocli docs update`   | 更新 HarmonyOS 文档到最新兼容版本                   |
| `devecocli init`          | 安装内置技能或配置 `MCP`                           |
| `devecocli skills`        | 管理 HarmonyOS 技能市场中的技能                     |
| `devecocli signature generate` | 自动生成调试签名材料并配置到项目     |
| `devecocli check compat`  | 扫描源代码在两个 `SDK` 版本之间的 `API` 变更         |

## 命令集

### `help`

查看版本、帮助信息以及所有子命令

**命令格式：**

```bash
devecocli help
```

```text
# 返回结果
Usage: devecocli [options] [command]

HarmonyOS application development command line tool

Options:
  -V, -v, --version      output the version number
  -h, --help             display help for command

Commands:
  build [options]        Build the HarmonyOS project
  run [options]          Build and run the project on a connected device
  update                 Update deveco-cli to the latest version
  device                 Manage connected devices
  emulator               Manage emulator instances
  auth                   Authentication commands (login, logout, status, team)
  ui                     Inspect and interact with UI on a connected device
  skills                 Manage HarmonyOS skills
  log [options]          Obtain device application logs
  verify [options]       Run UI verification on a connected device
  create [options]       Scaffold a new HarmonyOS application project
  init [options]         Install the deveco-cli skill or configure the deveco-mcp server into AI agents
  serve                  Host bundled auxiliary protocol servers
  docs [options]         Search and read HarmonyOS documentation from local docs directory
  check                  Run DevEco project checks
  signature              Generate application signature
  help [command]         display help for command
```

### `init`

将`deveco-cli` `Skill` 或者 `MCP` 服务配置到智能体中

**已有 Skill 和 MCP 配置默认跳过。更新已有内容或将复制安装的 Skill 改为软链接，需执行 `devecocli init -f`（或 `--force`），旧内容及本地修改会被删除。** 可用 `--agent`、`--project` 或 `--path` 选择位置；`-f` 也允许创建不存在的目标目录。正确安装的软链接随 CLI 更新生效，不需要重复 `init`；建链失败时回退为复制。

**命令格式：**

```bash
devecocli init --agent <agents> --project <path> --path <path> --skill --mcp --force
```

**参数：**

| 参数名         | 说明                                                                                        |
| ----------- | ----------------------------------------------------------------------------------------- |
| --agent     | 可选，智能体名称，多个智能体名称以英文逗号分隔。缺省时配置到所有已检测到的智能体中 |
| --project   | 可选，指定工程路径，将`deveco-cli` `Skill` 或 `MCP` 服务安装到该工程项目中                                       |
| --path      | 可选，指定 `deveco-cli` `Skill` 的配置路径。不可与 `--project` 、`--agent` 、 `--mcp` 同时使用                |
| --skill     | 可选，安装 `deveco-cli` `Skill`。不可与 `--mcp` 同时使用。`--mcp` 与 `--skill` 都缺省时，执行 `--skill`         |
| --mcp       | 可选，配置 `MCP` 服务，与 `--project` 一起使用表示配置工程级 `MCP` 服务，独立使用表示配置用户级 `MCP` 服务。不可与 `--skill` 同时使用 |
| -f, --force | 可选，直接替换已有 Skill 或 MCP 配置，并允许创建不存在的目标目录 |

**示例：**

```bash
# 配置Skill
devecocli init -f   # 安装或更新deveco-cli Skill
devecocli init --skill
devecocli init --agent agentname    # agentname需替换为实际的智能体名称
devecocli init --path D:\work\ARKTS\NewData -f

# 配置MCP
devecocli init --mcp
devecocli init --mcp --agent agentname    # agentname需替换为实际的智能体名称   
devecocli init --mcp --project D:\work\ARKTS\NewData -f
```

> MCP 配置支持 `opencode`、`pi`、`trae-cn`、`cursor`、`codebuddy`、`claude-code` 和 `codex`。

### Skill 支持的智能体

支持以下 52 个智能体。使用 `--agent` 指定名称，多个名称用英文逗号分隔。

`amp`、`antigravity`、`antigravity-cli`、`astrbot`、`atomcode`、`augment`、`bob`、`claude-code`、`cline`、`codearts-agent`、
`codebuddy`、`codex`、`continue`、`crush`、`cursor`、`deepagents`、`deveco`、`devin`、`droid`、`dsh`、
`gemini-cli`、`github-copilot`、`goose`、`grok`、`hermes-agent`、`iflow-cli`、`junie`、`kilo`、`kimi-code-cli`、`kiro-cli`、
`kode`、`lingma`、`minimax-code`、`mistral-vibe`、`neovate`、`ona`、`openclaw`、`opencode`、`openhands`、`pi`、
`qoder`、`qoder-cn`、`qwen-code`、`reasonix`、`replit`、`trae`、`trae-cn`、`universal`、`warp`、`windsurf`、
`zcode`、`zed`。

未检测到智能体时，可显式指定 `--agent` 安装。

### `docs search`

将关键词搜索版本说明、指南、API参考、最佳实践、`FAQ` 、变更预告等中的内容

**命令格式：**

```bash
devecocli docs search <keywords...> --catalog <name> --format <fmt> --limit <n>
```

**参数：**

| 参数名         | 说明                                                                                                                                                                                 |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| keywords... | 必选，搜索关键词，多个关键词用空格隔开                                                                                                                                                                |
| --catalog   | 可选，文档类别，取值包含`harmonyos-releases`（版本说明）、 `harmonyos-guides`（指南）、`harmonyos-references`（API参考）、`best-practices`（最佳实践）、`harmonyos-faqs`（FAQ）、`harmonyos-roadmap`（变更预告）、`all`（所有分类，默认） |
| --format    | 可选，控制输出格式，取值包括 `default` 、`json` ，默认为`default` ，输出结果包括文档ID、标题、文档的概括内容                                                                                                              |
| --limit     | 可选，设置搜索结果返回条数，默认为10                                                                                                                                                                |

**示例：**

```bash
devecocli docs search 沉浸光感
devecocli docs search '@State' '@Prop' --catalog best-practices --limit 10
devecocli docs search Row Column --format json
```

### `docs read`

按文档ID查询文档的完整内容

**命令格式：**

```bash
devecocli docs read <documentId> 
```

**参数：**

| 参数名        | 说明      |
| ---------- | ------- |
| documentId | 必选，文档ID |

**示例：**

```bash
devecocli docs read 开发指南/UI_Design_Kit_UI设计套件/UI_Design_Kit简介/ui-design-introduction
```

### `docs catalog`

查询文档分类和分类名称

**命令格式：**

```bash
devecocli docs catalog --format <fmt> 
```

**参数：**

| 参数名      | 说明                                        |
| -------- | ----------------------------------------- |
| --format | 可选，输出格式，`default` 或 `json` ，默认为 `default` |

**示例：**

```bash
devecocli docs catalog 
devecocli docs catalog --format json
```

### `create`

创建 HarmonyOS 应用工程，仅支持创建工程模板中的 `Empty Ability` 模板

**命令格式：**

```bash
devecocli create --app-name <name> --project-path <path> --bundle-name <bundle> --api-level <level> --device-types <types...>
```

**参数：**

| 参数名            | 说明                                                                |
| -------------- | ----------------------------------------------------------------- |
| --app-name     | 必选，应用名称                                                           |
| --project-path | 可选，工程路径，默认为：`./<appname>`                                         |
| --bundle-name  | 可选，包名，默认为：`com.example.<appname>` ，`appname` 自动转为小写               |
| --api-level    | 可选，API级别，最小值为17，最大值从安装的 `Deveco Studio` 的 `HarmonyOS` `SDK` 中自动获取 |
| --device-types | 可选，设备类型，可指定多个，写入 `module.json5` 的 `deviceTypes`，默认为 `phone`。支持 `phone`、`tablet`、`2in1`、`car`、`wearable`、`tv`；取值不在列表内时报错并列出全部合法值 |

**示例：**

```bash
devecocli create --project-path ./MyApp --app-name MyApp
devecocli create --project-path ./MyApp --app-name MyApp --bundle-name com.acme.myapp --api-level 23
devecocli create --app-name MyApp
devecocli create --app-name MyApp --device-types tablet
devecocli create --app-name MyApp --device-types phone wearable
```

### `auth login`

登录华为开发者账号，打开浏览器完成授权。交互式终端会先等待按 Enter 再拉起浏览器；传入 `--no-prompt` 可跳过确认直接拉起浏览器（供 Agent / 非交互终端使用；stdin 不是 TTY 时自动跳过）。Agent 执行登录或安装时，沿用会话中已有的相应授权，仅在缺少授权时询问。登录已获授权时直接运行 `devecocli auth login --no-prompt`，不再要求用户手动执行命令；用户仍需在浏览器完成认证。

**命令格式：**

```bash
devecocli auth login --no-prompt
```

**说明：**

- 海外账户暂不支持

### `auth logout`

登出并清除本地存储的凭据

**命令格式：**

```bash
devecocli auth logout
```

### `auth status`

显示当前登录的用户

**命令格式：**

```bash
devecocli auth status
```

### `auth team list`

列出当前用户已加入的团队

**命令格式：**

```bash
devecocli auth team list
```

**示例：**

```bash
devecocli auth team list
```

### `build`

编译并打包 HarmonyOS 工程或工程中的模块

**命令格式：**

```bash
devecocli build --product <product> --modules <modules> --build-mode <mode> --assemble-type <type> --signing-config <name>
```

**参数：**

| 参数名          | 说明                                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------- |
| --product    | 可选，产品的名称，默认为 `default`                                                                                  |
| --modules    | 可选，模块的名称。如需指定模块的 `target` 信息，使用 `module@target` 形式。当工程中只有一个模块时，可缺省；当工程中存在多个模块，且仅存在一个 `entry` 类型的模块时，可缺省 |
| --build-mode | 可选，构建模式，默认为 `debug`                                                                                     |
| --assemble-type | 可选，构建任务类型：`assembleHap`、`assembleApp`、`assembleHsp`、`assembleHar`。不指定时根据模块类型自动推断 |
| --signing-config | 可选，指定 `build-profile.json5` 中定义的签名配置名称，覆盖 product 默认关联的签名配置                                    |

**示例：**

```bash
devecocli build --build-mode release
devecocli build --modules entry library
devecocli build --modules library@phone
devecocli build --product oversea --modules entry --build-mode release
devecocli build --assemble-type assembleHap --build-mode release
devecocli build --product oversea --modules entry --build-mode release --signing-config default_release
```

**说明：**

- 选定模块的依赖会被自动解析和构建
- 执行`devecocli build --product <name>`命令后，产物为 `.app`
- 执行`devecocli build --product <name> --modules <m1>`命令后，产物为 `.hap` / `.hsp` / `.har`
- 构建成功后，控制台会打印所有产物的绝对路径（`.hap` / `.hsp` / `.har` / `.app`），可直接复制使用

### `build clean`

清理 HarmonyOS 项目的构建产物。默认模块模式（`--mode module`）按模块逐个清理；可指定 `--mode` 和 `--modules` 限定作用域。构建选项（analyze/parallel/incremental/daemon 等）由 `hvigor-config.json5` 的 `execution` 字段控制，与 DevEco Studio 一致。

**命令格式：**

```bash
devecocli build clean [--mode <mode>] [--modules <m1> <m2>]
```

**参数：**

| 参数名 | 说明 |
| --- | --- |
| `--mode <mode>` | 可选，hvigor `--mode` 值（默认 `module`） |
| `--modules <modules>` | 可选，限定清理的模块（多个以空格分隔） |

### `check compat`

基于 `DevEco Studio` 自带的 `apkanalyzer-apiscan` 插件，扫描源代码在两个 `SDK` 版本之间的 `API` 变更情况。

**子命令：**

| 子命令 | 说明 |
| --- | --- |
| `devecocli check compat` | 默认执行工程级扫描 |
| `devecocli check compat --modules <m1> [m2...]` | 按模块扫描 |
| `devecocli check compat <file1> [file2...]` | 按文件扫描（仅支持 `.ets`/`.c`/`.cpp`） |
| `devecocli check compat versions` | 列出可用的目标 `SDK` 版本 |

**命令格式：**

```bash
devecocli check compat [files...] --source-version <ver> --target-version <ver> [--modules <m...>] [--format <default|csv|json>] [--output-path <path>] [--limit <n>]
```

**参数：**

| 参数名 | 说明 |
| --- | --- |
| `--source-version` | 必填，当前工程 `SDK` 版本 |
| `--target-version` | 必填，目标 `SDK` 版本 |
| `--modules` | 可选，指定扫描的模块（多个以空格分隔）。与文件参数互斥 |
| `--format` | 可选，输出格式。`default`/`csv`/`json`。默认 `default`（控制台输出文本，文件输出 `csv`） |
| `--output-path` | 可选，报告输出路径。目录或文件（扩展名必须与 `--format` 匹配） |
| `--limit` | 可选，控制台显示的最大记录数，默认 `100` |

**版本号说明：**

- 可用版本可通过 `devecocli check compat versions` 查看
- `zsh` 环境下版本号需用引号包裹（包含括号），例如 `"<source_version>"`、`"<target_version>"`

**`compat versions` 参数：**

| 参数名 | 说明 |
| --- | --- |
| `--format` | 可选，输出格式。`default` 或 `json`。默认 `default`（文本输出，每行一个版本号） |

**格式与输出组合：**

| 场景 | 允许的 `--format` | 行为 |
| --- | --- | --- |
| 控制台输出（无 `--output-path`） | `default` / `json` | `default` 输出文本表格，`json` 输出 `JSON` |
| 文件输出（`--output-path <file>`，扩展名必须匹配 `--format`） | `default` / `csv` / `json` | `default`/`csv` 写 `.csv` 文件；`json` 写 `.json` 文件 |
| 目录输出（`--output-path <dir>`，无扩展名） | `default` / `csv` / `json` | `default`/`csv` 生成 `apiChange-res{N}.csv`；`json` 生成 `apiChange-res{N}.json` |

**示例：**

```bash
# 工程级扫描，输出到控制台
devecocli check compat --source-version "<source_version>" --target-version "<target_version>"

# 输出 JSON 到控制台
devecocli check compat --format json --source-version "<source_version>" --target-version "<target_version>"

# 输出报告到目录（默认 csv）
devecocli check compat --output-path ./report --source-version "<source_version>" --target-version "<target_version>"

# 输出 JSON 报告到目录（生成 apiChange-res{N}.json）
devecocli check compat --output-path ./report --format json --source-version "<source_version>" --target-version "<target_version>"

# 输出报告到指定文件
devecocli check compat --output-path ./report.json --format json --source-version "<source_version>" --target-version "<target_version>"

# 文件级扫描
devecocli check compat ./entry/src/main/ets/pages/Index.ets --source-version "<source_version>" --target-version "<target_version>"

# 模块级扫描
devecocli check compat --modules entry har1 --source-version "<source_version>" --target-version "<target_version>"
```

### `check lint`

检查代码规范并输出实践建议与报告。

**命令格式：**

```bash
devecocli check lint [path]
```

**参数：**

| 参数名                        | 说明                                                                  |
| ---------------------------- | --------------------------------------------------------------------- |
| `[path]`                     | 可选，待检查的文件或目录；默认使用 `build-profile.json5` 所在的项目根目录，否则使用当前目录 |
| `--config-path <path>`       | Code Linter 配置文件路径，仅支持 `.json` 或 `.json5`；默认使用待检查项目根目录下的 `code-linter.json5`，显式指定时必须与待检查路径属于同一项目 |
| `--fix`                      | 自动修复可修复的问题                                                  |
| `--incremental`              | 仅检查 Git 未提交文件                                                 |
| `--product <name>`           | `build-profile.json5` 中定义的 product，默认为 `default`              |
| `--format <default\|json>`   | 完整报告格式；`default` 输出 Markdown，`json` 输出 JSON；要求 DevEco Studio ≥ 6.1.0 |
| `--output-path <path>`       | 完整报告文件或目录,目录形式会自动生成带时间戳的报告文件；要求 DevEco Studio ≥ 6.1.0                         |
| `--limit <number>`           | 未指定 `--output-path` 时，限制终端显示的问题数量                      |

`emulator` 版本要求： DevEco Studio ≥ 6.1.0

### `check arkts`

对 `.ets` 源文件执行 ArkTS 静态检查，基于 DevEco Studio 的 `etsStandaloneChecker`。

**命令格式：**

```bash
devecocli check arkts [files...] [--fix] [--project <path>]
```

**参数：**

| 参数名 | 说明 |
| --- | --- |
| `[files...]` | 可选，待检查的 `.ets` 文件列表；默认检查项目内所有 `.ets` 文件 |
| `--fix` | 自动修复高置信度错误（如缺失的 `export` 关键字） |
| `--project <path>` | 项目根目录；默认从当前目录自动检测 `build-profile.json5` |

**示例：**

```bash
# 检查整个项目
devecocli check arkts

# 检查指定文件并自动修复
devecocli check arkts --fix entry/src/main/ets/pages/Index.ets

# 指定项目路径
devecocli check arkts --project /path/to/project
```

### `emulator list`

查看模拟器实例

**命令格式：**

```bash
devecocli emulator list [--format <table|json>]
devecocli emulator list --details
```

**参数：**

| 参数名 | 说明 |
| --- | --- |
| `--format` | 可选，控制终端输出格式，取值为 `table` 或 `json`，默认为 `table`；`json` 返回固定的五字段精简结构 |
| `--details` | 可选，直接输出底层 `Emulator -list -details` 的完整 JSON，不做任何字段裁剪、重命名或补充；与 `--format` 互斥 |

**示例：**

```bash
devecocli emulator list
devecocli emulator list --format json
devecocli emulator list --details
```

### `emulator start`

启动模拟器。首次使用时，需要签署 HarmonyOS 软件许可与服务协议，具体请参考 `emulator license`

**命令格式：**

```bash
devecocli emulator start [names...]
```

**参数：**

| 参数名         | 说明                                        |
| ----------- | ----------------------------------------- |
| \[names...] | 必选，模拟器实例名称，多个名称用空格隔开。若名称中带有空格，则名称需要添加英文引号 |
| --hdcport \<port> | 可选，指定模拟器的 hdc 端口号，取值范围 10000-16555，对应 Emulator 的 `-hdcport` 参数。 |
| --boot-mode \<mode> | 可选，指定模拟器启动方式，对应 Emulator 的 `-bootMode` 参数，可选值：`coldboot`（冷启动，保留上次使用的应用、文件等数据）、`snapshot`（热启动，加载上次关闭时保存的快照，需创建模拟器时启用 Quick Boot）、`reset`（清除数据后冷启动）。不指定时按创建模拟器时选择的方式启动（无法识别创建方式时默认 snapshot）。 |
| --no-window | 可选，以无界面方式启动模拟器，对应 Emulator 的 `-noWindow` 参数；无图形界面的 Linux 环境必选。 |

**示例：**

```bash
devecocli emulator start Phone
devecocli emulator start Phone1 Phone2
devecocli emulator start Phone --hdcport 12345
devecocli emulator start Phone --boot-mode coldboot --no-window
```

**说明：**

- `emulator start` 命令仅支持启动 `release` 版本的模拟器

### `emulator stop`

关闭模拟器

**命令格式：**

```bash
devecocli emulator stop [names...]
```

**参数：**

| 参数名         | 说明                                        |
| ----------- | ----------------------------------------- |
| \[names...] | 必选，模拟器实例名称，多个名称用空格隔开。若名称中带有空格，则名称需要添加英文引号 |

**示例：**

```bash
devecocli emulator stop Phone
devecocli emulator stop 127.0.0.1:5555
```

### `emulator` 场景操作

控制运行中的模拟器实例，直接映射 DevEco Studio 内置 Emulator 公开命令行参数。新增场景控制命令要求 Emulator 7.0 或更高版本；低版本会直接提示升级。截图不属于模拟器场景操作，统一通过 `devecocli ui screenshot` 执行。

**示例：**

```bash
devecocli emulator shake --target Phone
devecocli emulator power --target Phone
devecocli emulator rotate left --target Phone
devecocli emulator volume up --target Phone
devecocli emulator fold half-open --target Phone
devecocli emulator battery --target Phone --level 90
devecocli emulator battery --target Phone --status charging
devecocli emulator battery --target Phone --level 80 --status charging
devecocli emulator geolocation --target Phone --longitude 116.40024 --latitude 39.908
devecocli emulator scene outdoorRunning --target Phone
devecocli emulator sensor --target Phone --heartrate 80
```

**说明：**

- `--target` 支持模拟器名称或 `127.0.0.1:<port>` 序列号。
- `battery --level` 与 `battery --status` 可同时传入（一次调用同时设置电量与充电状态）。
- `battery --level` 会自动查询模拟器当前充电状态：充电时取值范围为整数 `[0, 100]`，未充电时为 `[1, 100]`。
- `battery --status` 取值为 `charging` 或 `discharging`。
- `--level 0` 与 `--status discharging` 组合非法（电量 0 仅在充电时允许），会被拒绝。
- `geolocation` 支持 `--longitude`、`--latitude`、`--altitude`、`--direction`。
- `scene` 取值为 `outdoorRunning`、`outdoorCycling`、`drivingNavigation`。
- `sensor` 支持 `--light-intensity`、`--humidity`、`--temperature`、`--steps`、`--heartrate`，可同时传入多个。
- `geolocation`/`battery`/`sensor` 多参数为逐项串行下发、非原子：第 N 项失败时前 N−1 项已生效且不回滚，建议失败后整体重跑。
- `fold <state>` 会根据目标模拟器的设备类型校验状态，设备与参数必须匹配：

  | 设备类型 | 支持的 `state` |
  | --- | --- |
  | `foldable` | `open`、`half-open`、`close` |
  | `2in1_foldable` | `open`、`vertical-open`、`half-open`、`close` |
  | `triplefold` | `single`、`double`、`triple`、`left-folded-right-half-folded`、`left-half-folded-right-expanded`、`left-expanded-right-folded`、`left-half-folded-right-folded`、`left-expanded-right-half-folded`、`left-half-folded-right-half-folded` |

  校验以目标模拟器实际返回的 `deviceType` 为准。非上述三种设备类型以及不属于目标设备类型的状态会在命令下发前被拒绝。校验通过后，底层映射为 `Emulator -instance <name> -foldedState <state>`。
- 设置 `DEVECO_CLI_DEBUG=1` 可查看底层命令映射，例如 `Emulator -instance <name> -shake`。

### `emulator create`

创建模拟器

**命令格式：**

```bash
devecocli emulator create <name> \
  --device-type <type> \
  --os-version <version> \
  [--instance-path <path>] \
  [--image-root <path>] \
  [--screen-profile <model>] \
  [--screen <config...>] \
  [--storage <size>] \
  [--memory <size>] \
  [--hot-boot <true|false>] \
  [--force]
```

**参数：**

| 参数名 | 说明 |
| --- | --- |
| `name` | 必选，模拟器名称 |
| `--device-type` | 必选，指定模拟器产品类型，支持的产品类型以官方设备支持类型为准，不区分大小写 |
| `--os-version` | 必选，模拟器镜像版本 |
| `--instance-path` / `--path` | 可选，模拟器实例路径 |
| `--image-root` | 可选，模拟器镜像路径 |
| `--screen-profile` | 可选，模拟器设备型号，例如 `Mate 70 Pro` |
| `--screen` | 可选，屏幕配置，格式为 `宽度(px) 高度(px) DPI 屏幕对角线长度(inch)`；宽度和高度范围为 720～3500 px，DPI 范围为 240～640，屏幕对角线长度范围为 3.5～9 inch；折叠屏模拟器传入两组配置 |
| `--storage` | 可选，存储空间，范围 `2–1023`，单位 G |
| `--memory` | 可选，运行内存，范围 `2–32`，单位 G |
| `--hot-boot` | 可选，取值为 `true` 或 `false`，从 26.0.0 Beta1 开始支持；API 26 及以上未指定时默认为 `true` |
| `--force` | 可选，覆盖已有同名的模拟器 |

`--screen-profile` 和 `--screen` 可同时指定，此时使用 `--screen`。

**示例：**

```bash
devecocli emulator create MyPhone --device-type phone --os-version "HarmonyOS 6.0.1(21)"

devecocli emulator create MyPhone \
  --device-type phone \
  --os-version "HarmonyOS 6.0.1(21)" \
  --screen-profile "Mate 70 Pro" \
  --storage 8 \
  --memory 8

devecocli emulator create Foldable \
  --device-type foldable \
  --os-version "HarmonyOS 6.0.1(21)" \
  --screen "2200 2480 480 7.8" "1080 2480 480 6.4"
```

### `emulator delete`

删除模拟器

**命令格式：**

```bash
devecocli emulator delete <name> [--instance-path <path>]
```

**参数：**

| 参数名 | 说明 |
| --- | --- |
| `name` | 必选，模拟器实例名称或序列号 |
| `--instance-path` / `--path` | 可选，模拟器实例路径；删除通过自定义路径创建的模拟器时，需传入创建时使用的同一路径 |

**示例：**

```bash
devecocli emulator delete MyPhone

devecocli emulator delete MyPhone --instance-path /custom/instance/path
```

### `emulator image list`

查询模拟器镜像列表

**命令格式：**

```bash
devecocli emulator image list --device-type <type> --all --format <format>
```

**参数：**

| 参数名           | 说明                                                                                                                         |
| ------------- | -------------------------------------------------------------------------------------------------------------------------- |
| --device-type | 可选，模拟器设备类型，支持 `phone` ， `foldable` ， `widefold` ， `triplefold` ， `tablet` ， `2in1` ， `2in1 foldable` ， `tv` ， `wearable` |
| --all         | 可选，查询已下载和未下载的所有镜像                                                                                                          |
| --format      | 可选，控制输出格式，取值为 `table` 或 `json` ，默认为 `table`                                                                                |

**示例：**

```bash
devecocli emulator image list
devecocli emulator image list --all
devecocli emulator image list --device-type phone
devecocli emulator image list --format json
```

### `emulator image download`

下载模拟器镜像。首次使用时，需要签署 HarmonyOS `SDK` 许可协议，具体请参考 `emulator license`

**命令格式：**

```bash
devecocli emulator image download --device-type <type> --os-version <version> --force
```

**参数：**

| 参数名           | 说明                                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| --device-type | 必选，模拟器设备类型，支持 `phone` ， `foldable` ， `widefold` ， `triplefold` ， `tablet` ， `2in1` ， `2in1 foldable` ， `tv` ， `wearable` ，全小写 |
| --os-version  | 必选，模拟器镜像版本                                                                                                                      |
| --force       | 可选，覆盖已有的模拟器镜像                                                                                                                   |

**示例：**

```bash
devecocli emulator image download --device-type phone --os-version "HarmonyOS 6.0.1(21)" --force
```

**说明：**

- `emulator image download` 命令仅支持下载 `release` 版本的模拟器镜像

### `emulator image remove`

删除模拟器镜像

**命令格式：**

```bash
devecocli emulator image remove --device-type <type> --os-version <version>
```

**参数：**

| 参数名           | 说明                             |
| ------------- | ------------------------------ |
| --device-type | 必选，模拟器设备类型，与下载镜像的device-type一致 |
| --os-version  | 必选，模拟器镜像版本，与下载镜像的os-version一致  |

**示例：**

```bash
devecocli emulator image remove --device-type phone --os-version "HarmonyOS 6.0.1(21)"
```

### `emulator license view`

查看协议文本（只读）

**命令格式：**

```bash
devecocli emulator license view
```

### `emulator license`

交互式查看并接受协议。打印完整协议文本后提示 y/N 确认。使用模拟器需要同意 HarmonyOS 软件许可与服务协议，下载镜像需要同意 HarmonyOS `SDK` 许可协议。若已同意则直接提示已接受。非交互终端下会报错，请改用 `emulator license accept`

**命令格式：**

```bash
devecocli emulator license
```

### `emulator license accept`

非交互式同意模拟器所有协议，直接写入同意记录，跳过协议展示和确认提示。适用于 Agent、自动化脚本、CI 或非交互终端环境。若已同意则直接提示已接受。Agent 遇到协议阻塞时，沿用用户已有的协议接受授权，直接执行此命令，成功后继续原操作；仅在缺少授权时询问。需要查看协议内容时使用只读的 `devecocli emulator license view`。

**命令格式：**

```bash
devecocli emulator license accept
```

### `device list`

查询所有已连接的设备，包括真机设备和运行中的模拟器

**命令格式：**

```bash
devecocli device list [--format <table|json>]
```

**参数：**

| 参数名 | 说明 |
| --- | --- |
| --format | 可选，输出格式。可选值：`table`、`json`，默认 `table` |

### `device view`

查询已连接的设备的详细信息，包括设备序列号、设备名称、设备类型、 `OS` 版本等

**命令格式：**

```bash
devecocli device view [--target <serialOrName>] [--format <table|json>]
```

**参数：**

| 参数名         | 说明                                    |
| ----------- | ------------------------------------- |
| -t，--target | 可选，目标设备名称或序列号。多设备缺省时，会列出所有已连接设备序列号和名称 |
| --format | 可选，输出格式。可选值：`table`、`json`，默认 `table` |

**示例：**

```bash
devecocli device view
devecocli device view --target 127.0.0.1:5555
devecocli device view -t "My Device Name"
devecocli device view -t 127.0.0.1:5555 --format json
```

### `device file`

在主机与设备（真机或模拟器）之间传输文件，底层映射为 `hdc -t <serial> file send/recv <src> <dst>`。

**命令格式：**

```bash
devecocli device file [--device <name|serial>] send <src> <dst>
devecocli device file [--device <name|serial>] recv <src> <dst>
```

**参数：**

| 参数名 | 说明 |
| --- | --- |
| --device | 可选，目标设备名称或序列号。单设备可省略，多设备时必填 |
| send <src> <dst> | 子命令，上传本地文件到设备 `<src>`(本地) → `<dst>`(设备端) |
| recv <src> <dst> | 子命令，下载设备文件到主机 `<src>`(设备端) → `<dst>`(本地) |

**示例：**

```bash
devecocli device file send ./local.txt /data/local/tmp/remote.txt
devecocli device file recv /data/local/tmp/remote.txt ./local.txt --device 127.0.0.1:5555
```

### `device sqlite3`

在设备上执行 `sqlite3`，底层映射为 `hdc -t <serial> shell sqlite3 <db-path> [args...]`，后续参数原样透传给设备的 `sqlite3`。

**命令格式：**

```bash
devecocli device sqlite3 [--device <name|serial>] <db-path> [args...]
```

**参数：**

| 参数名 | 说明 |
| --- | --- |
| --device | 可选，目标设备名称或序列号。单设备可省略，多设备时必填 |
| db-path | 设备端 SQLite 数据库文件路径 |
| args | 可选，透传给设备 `sqlite3` 的参数，如 `-json`、`-header`、`-readonly`、SQL 语句、点命令等 |

**示例：**

```bash
devecocli device sqlite3 /data/app/el2/100/database/com.example.app/foo.db "select * from user limit 5" -json
```

### `ui screenshot`

对真机或模拟器执行 UI 截图。

**命令格式：**

```bash
devecocli ui screenshot --device <name|serial> --display <displayId> --path <path>
```

**参数：**

| 参数                       | 说明                       | 默认值       |
| ------------------------ | ------------------------ | ---------- |
| --device \<name\|serial> | 真机或模拟器名称/序列号；多设备时必填     | 单设备自动选择 |
| --display \<displayId>   | 目标屏幕 ID，可选                | 默认屏幕     |
| --path \<path>           | 必填，文件夹路径或 PNG 文件路径；支持相对于当前目录的路径，目录必须存在且可写，目标文件不能已存在 | 无 |

**示例：**

```bash
mkdir -p screenshots
devecocli ui screenshot --device Phone --path ./screenshots
devecocli ui screenshot --device Phone --display 0 --path ./screenshots/phone.png
```

**说明：**

- `ui screenshot` 支持真机和模拟器。
- 仅有一个可用设备时可省略 `--device`，多个设备同时连接时必须指定。
- `--path` 可以使用相对于当前目录的路径。可以指定已存在的文件夹并自动生成 PNG 文件名，也可以指定完整的 PNG 文件路径；不会自动创建目录或覆盖已有文件。
- 截图能力统一通过 `ui screenshot` 提供，不放在模拟器场景操作命令中。
- 截图统一使用 `hdc shell snapshot_display` 和 `hdc file recv` 实现；设置 `DEVECO_CLI_DEBUG=1` 可查看实际执行命令。

### `ui screenrecord`

录制真机屏幕并保存为 MP4。仅支持提供系统录屏服务和 `mediatool` 的真机，不支持模拟器。

**命令格式：**

```bash
devecocli ui screenrecord [start] --device <name|serial> --path <dir|file.mp4>
devecocli ui screenrecord stop --device <name|serial> [--force]
devecocli ui screenrecord status --device <name|serial> [--format table|json]
```

**参数：**

| 参数 | 说明 | 默认值 |
| --- | --- | --- |
| --device \<name\|serial> | 设备名称或序列号；多设备时必填 | 单设备自动选择 |
| --path \<dir\|file.mp4> | 直接录制或 `start` 时必填；已有可写目录或新 MP4 文件路径，父目录必须存在 | 无 |
| --force | 仅用于 `stop`，允许停止非本 CLI 登记的录屏；此类视频不下载，到设备图库查看 | 不启用 |
| --format \<table\|json> | 仅用于 `status`，指定输出格式 | table |

**示例：**

```bash
mkdir -p recordings
# 直接录制，按 Ctrl+C 停止并保存
devecocli ui screenrecord --device Phone --path ./recordings/demo.mp4

# 分步控制
devecocli ui screenrecord start --device Phone --path ./recordings
devecocli ui screenrecord status --device Phone --format json
devecocli ui screenrecord stop --device Phone
```

**说明：**

- 不带子命令时进入交互录制；`start` 确认启动后立即返回，之后用 `stop` 停止并保存到启动时指定的位置。
- `--path` 支持相对路径；输入目录则自动生成文件名，不创建目录、不覆盖已有文件。录制期间目标被占用时，使用带 `-recovered` 后缀的文件名。
- `status` 返回 `recording`（本 CLI 录屏）、`busy`（非本 CLI 登记的录屏）或 `idle`（未录屏）；查询不会改变设备状态。
- 设备端已停止或视频保存失败时，可重试 `stop` 取回；再次启动会删除中断会话登记，不取回旧视频，原件保留在设备图库。跨终端操作需使用同一个 `DEVECO_CLI_DATA_DIR`。
- 设备图库保留视频原件。进程被强制结束且登记尚未完成时，需检查设备状态和图库。

### `ui click`

点击指定坐标或节点 ID 的中心位置。

**命令格式：**

```bash
devecocli ui click [x] [y] --device <name|serial> --id <id> --window <windowId>
```

**参数：**

| 参数 | 说明 |
| --- | --- |
| `[x] [y]` | 可选，目标坐标。缺省时需配合 `--id` 使用 |
| --device \<name\|serial> | 目标设备，多设备时必填 |
| --id \<id> | 节点 ID，自动解析为中心坐标。不可与 `[x] [y]` 同时使用 |
| --window \<windowId> | 目标窗口 ID，需与 `--id` 配合使用 |

**示例：**

```bash
devecocli ui click 100 200
devecocli ui click 100 200 --device Phone
devecocli ui click --id submit_button
devecocli ui click --id submit_button --window main_window
```

### `ui doubleclick`

双击指定坐标或节点 ID 的中心位置。

**命令格式：**

```bash
devecocli ui doubleclick [x] [y] --device <name|serial> --id <id> --window <windowId>
```

**参数：**

| 参数 | 说明 |
| --- | --- |
| `[x] [y]` | 可选，目标坐标。缺省时需配合 `--id` 使用 |
| --device \<name\|serial> | 目标设备，多设备时必填 |
| --id \<id> | 节点 ID，自动解析为中心坐标。不可与 `[x] [y]` 同时使用 |
| --window \<windowId> | 目标窗口 ID，需与 `--id` 配合使用 |

**示例：**

```bash
devecocli ui doubleclick 100 200
devecocli ui doubleclick 100 200 --device Phone
devecocli ui doubleclick --id photo_thumb
devecocli ui doubleclick --id photo_thumb --window main_window
```

### `ui longclick`

长按指定坐标或节点 ID 的中心位置。

**命令格式：**

```bash
devecocli ui longclick [x] [y] --device <name|serial> --id <id> --window <windowId>
```

**参数：**

| 参数 | 说明 |
| --- | --- |
| `[x] [y]` | 可选，目标坐标。缺省时需配合 `--id` 使用 |
| --device \<name\|serial> | 目标设备，多设备时必填 |
| --id \<id> | 节点 ID，自动解析为中心坐标。不可与 `[x] [y]` 同时使用  |
| --window \<windowId> | 目标窗口 ID，需与 `--id` 配合使用 |

**示例：**

```bash
devecocli ui longclick 100 200
devecocli ui longclick 100 200 --device Phone
devecocli ui longclick --id menu_item
devecocli ui longclick --id menu_item --window main_window
```

### `ui swipe`

自定义滑动（指定起点、终点和速度）。

**命令格式：**

```bash
devecocli ui swipe <x1> <y1> <x2> <y2> --device <name|serial> --speed <n>
```

**参数：**

| 参数 | 说明 |
| --- | --- |
| `<x1> <y1> <x2> <y2>` | 必选，起点和终点坐标 |
| --device \<name\|serial> | 目标设备，多设备时必填 |
| --speed \<n> | 可选，滑动速度（像素/秒），范围 `200` ~ `40000` |

**示例：**

```bash
devecocli ui swipe 100 500 100 200
devecocli ui swipe 100 500 100 200 --device Phone
devecocli ui swipe 100 500 100 200 --speed 1000
```

### `ui fling`

快速滑动（Fling）。

**命令格式：**

```bash
devecocli ui fling <x1> <y1> <x2> <y2> --device <name|serial> --speed <n>
```

**参数：**

| 参数 | 说明 |
| --- | --- |
| `<x1> <y1> <x2> <y2>` | 必选，起点和终点坐标 |
| --device \<name\|serial> | 目标设备，多设备时必填 |
| --speed \<n> | 可选，滑动速度（像素/秒），范围 `200` ~ `40000` |

**示例：**

```bash
devecocli ui fling 100 800 100 200
devecocli ui fling 100 800 100 200 --device Phone
devecocli ui fling 100 800 100 200 --speed 3000
```

### `ui drag`

拖拽操作。

**命令格式：**

```bash
devecocli ui drag <x1> <y1> <x2> <y2> --device <name|serial> --speed <n>
```

**参数：**

| 参数 | 说明 |
| --- | --- |
| `<x1> <y1> <x2> <y2>` | 必选，起点和终点坐标 |
| --device \<name\|serial> | 目标设备，多设备时必填 |
| --speed \<n> | 可选，滑动速度（像素/秒），范围 `200` ~ `40000` |

**示例：**

```bash
# 拖拽操作
devecocli ui drag 100 500 100 200
devecocli ui drag 100 500 100 200 --device Phone
devecocli ui drag 100 500 100 200 --speed 1500
```

### `ui dircfling`

向指定方向快速滑动。

**命令格式：**

```bash
devecocli ui dircfling <direction> --device <name|serial>
```

**参数：**

| 参数 | 说明 |
| --- | --- |
| `<direction>` | 必选，方向，取值为 `up`, `down`, `left`, `right` |
| --device \<name\|serial> | 目标设备，多设备时必填 |

**示例：**

```bash
devecocli ui dircfling up
devecocli ui dircfling down --device Phone
devecocli ui dircfling left
devecocli ui dircfling right
```

**与 `ui swipe` 的区别：**

- `ui swipe` 需要指定精确的起点和终点坐标，支持自定义速度，适用于特定区域滑动。
- `ui dircfling` 仅需指定方向，使用系统默认速度，适用于页面滚动或列表快速滑动。

### `ui text`

输入文本到当前焦点、指定坐标或指定节点位置。

**命令格式：**

```bash
devecocli ui text <text> [x] [y] --device <name|serial> --id <id> --window <windowId>
```

**参数：**

| 参数 | 说明 |
| --- | --- |
| `<text>` | 必选，待输入的文本 |
| `[x] [y]` | 可选，目标坐标 |
| --device \<name\|serial> | 目标设备，多设备时必填 |
| --id \<id> | 节点 ID，自动解析为中心坐标。不可与 `[x] [y]`同时使用 |
| --window \<windowId> | 目标窗口 ID，需与 `--id` 配合使用 |

**示例：**

```bash
devecocli ui text "Hello World"
devecocli ui text "Hello World" --device Phone
devecocli ui text "Hello World" 100 200
devecocli ui text "Hello World" --id search_box
devecocli ui text "Hello World" --id search_box --window main_window
```

### `ui layout`

导出设备屏幕上的 UI 节点树，输出每个节点的类型、节点 ID、坐标边界 `[left,top,right,bottom]`、文本及可交互标志（`clickable` / `longClickable` / `scrollable` / `checkable`）。

> **设备要求**：需设备 API 20 及以上。

**命令格式：**

```bash
devecocli ui layout --device <name|serial> --id <id> --window <windowId> --all-windows --depth <n> --format <fmt> --mode <full|simplified>
```

**参数：**

| 参数名 | 说明 |
| --- | --- |
| --device \<name\|serial> | 目标设备，多设备时必填 |
| --id \<id> | 节点 ID，筛选树中匹配节点（仅输出匹配节点，不带子节点，强制 JSON）。不可与未筛选的全树输出同时视为列表查询 |
| --window \<windowId> | 目标窗口 ID，与 `--all-windows` 互斥 |
| --all-windows | 包含所有窗口，与 `--window` 互斥 |
| --depth \<n> | 树深度限制，`0`=不限制（默认），`1`=仅根，`2`=根+子节点 |
| --format | 输出格式，`default` 或 `json`，默认 `default` |
| --mode | 输出模式：`full`=完整原始树；`simplified`（默认）=折叠无 ID、无文本、无可交互标志的包装节点 |

**示例：**

```bash
devecocli ui layout
devecocli ui layout --device Phone
devecocli ui layout --device Phone --format json
devecocli ui layout --mode full --depth 2
devecocli ui layout --id submit_button
devecocli ui layout --window 15 --format json
```

**说明：**

- `--mode simplified`（默认）会折叠无 `id`、无 `text`、无任何可交互标志的包装节点，使输出聚焦于有意义的可操作节点；根节点始终保留。`--depth` 在折叠后截断。
- `--id` 用于按节点 ID 查询，返回所有匹配节点（`children` 置空），常配合 `ui click --id` / `ui text --id` 定位坐标。
- 节点 `bounds` 为 `[left, top, right, bottom]`，`ui click --id` 等交互命令据此取中心坐标点击。
- `--window` 的窗口 ID 可通过 `devecocli ui window list` 获取。

### `ui window list`

查看设备上的窗口列表，输出窗口 ID、名称、PID、所属屏幕 ID 及是否聚焦。为 `ui layout --window`、`ui click --window` 等命令提供窗口 ID。

**命令格式：**

```bash
devecocli ui window list --device <name|serial> --format <fmt> --all
```

**参数：**

| 参数名 | 说明 |
| --- | --- |
| --device \<name\|serial> | 目标设备，多设备时必填 |
| --format | 输出格式，`default` 或 `json`，默认 `default` |
| --all | 显示包含系统窗口在内的所有窗口；缺省时仅显示应用窗口（`type === 1`） |

**示例：**

```bash
devecocli ui window list
devecocli ui window list --device Phone
devecocli ui window list --format json
devecocli ui window list --all
```

**说明：**

- 聚焦窗口在 `default` 格式下高亮显示。
- 缺省时仅列出应用窗口；加 `--all` 可查看系统窗口，用于排查多窗口场景。

### `run`

构建应用后，将应用安装到真机设备或模拟器上，并启动执行

**命令格式：**

```bash
devecocli run --module <m1> [m2...] --device <device> --product <product> --build-mode <mode> --ability <ability> --uninstall --skip-build --apply <fileName> --hotreload [action] --hotreload-apply <fileName>
```

**参数：**

| 参数名          | 说明                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------ |------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| --module     | 可选，模块名称，支持多个以空格分隔。如需指定模块的 `target` 信息，使用 `module@target` 形式。当工程中只有一个可运行模块（ `entry` / `feature` / `shared` ）时，可缺省                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --device     | 设备名称或设备序列号，单设备时可选，多设备时必选                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --product    | 可选，产品的名称，默认为 `default`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --build-mode | 可选，构建模式名称，默认为 `debug`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --ability    | 可选，待启动的 `Ability` ，默认：模块 `module.json5` 中的`mainElement`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --uninstall  | 可选，安装前先卸载已有应用                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --skip-build | 可选，跳过构建操作，直接安装应用 。\*\*说明：\*\*使用该参数时，需确保对应模块已有构建产物                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --apply \<fileName\> | 可选，快速增量部署。仅重编改动文件并安装，比全量 `run` 快。`<fileName>` 为 `.hvigor/` 下的改动文件清单（每行一个相对工程根路径）。前提：DevEco Studio ≥6.1.1，且先跑过一次 `devecocli run`。注意：不要与活跃的 `--hotreload` 会话混用（两者共用模块级 `buildConfig.json`），先 `devecocli run --hotreload stop` 停止会话 |
| --hotreload [action] | 可选，使用热重载功能。使用热重载时，该命令需持续存活，以使热重载构建可以快速响应。当不需要时，执行 `devecocli run --hotreload stop` 去停止进程，释放资源。会话存活期间不要对该工程执行 `--apply` 或普通 `run`/`build`（会清掉会话依赖的 `buildConfig.json`），需要时先停止会话再重启 |
| --hotreload-apply \<fileName\> | 可选，热重载（不重启应用即生效）。读取 `.hvigor/<fileName>` 改动清单，经编译安装使改动生效。前提：后台 `--hotreload` 进程在跑。范围：仅单个模块（`--module` 必填），且只支持 `.ets` 文件 |

**示例：**

```bash
devecocli run
devecocli run --module entry --device 127.0.0.1:5555
devecocli run --module library@phone --device 127.0.0.1:5555
devecocli run --module entry service uiextension --device 127.0.0.1:5555
devecocli run --product oversea --module entry --ability EntryAbility
devecocli run --build-mode release
devecocli run --uninstall
devecocli run --apply changes.txt
devecocli run --module entry --hotreload
devecocli run --hotreload stop
devecocli run --module entry --hotreload-apply changes.txt
```

**说明：**

- 应用启动成功后（含 `--apply` 增量部署重启后），默认自动执行**冒烟检查**：确认应用进程仍存活，并对屏幕截图做纯色空白检测（pHash）。通过时输出 `Smoke: PASS`；进程已退出时输出 `Smoke: FAIL_CRASH`（附带 `crash_log:` 崩溃日志路径），检测到空白屏时输出 `Smoke: FAIL_BLANK`（附带 `screenshot:` 截图路径），检查失败时命令以非零码退出。证据仅在失败时落盘于工程 `.hvigor/smoke/` 下的本次运行独立目录：失败的截图与崩溃日志自检查结束起**保留 24 小时**（期间任何后续 run 都不会删除），之后由下一次 run 自动清理；`PASS` 的截图在判定后连同目录一并删除。进行中的并发检查互不影响，`.hvigor/` 不会随 run 次数堆积。
- 无可启动的 `Ability`，或使用 `--hotreload` / `--hotreload-apply` 时，跳过冒烟检查。
- 冒烟检查取证前默认等待 `3000` 毫秒（供应用完成冷启动），可通过环境变量 `DEVECO_CLI_SMOKE_WAIT_MS`（毫秒）调整：设为 `0` 立即取证；冷启动较慢的设备可适当调大以避免误报。

### `log`

查看`hilog`普通日志或崩溃日志，或对本地故障日志/采样栈文件做结构化分析

**命令格式：**

```bash
# 设备日志流
devecocli log --device <device> --crash --level <level> --bundle-name <bundle-name> --keyword <keyword> --tail <num> --from <start> --to <end> --follow

# 本地故障日志分析（cpp_crash / js_error / app_freeze）
devecocli log --crash --path <file|dir> --format default|json|report|hilog

# 本地采样栈分析（freeze-cpuinfo-ext 增强日志）
devecocli log --stack --path <file> --format default|json|report --limit <num>
```

**参数：**

| 参数名           | 说明                                                                                                                         |
| ------------- | -------------------------------------------------------------------------------------------------------------------------- |
| --device      | 设备名称或设备序列号，单设备时可选，多设备时必选                                                                                                   |
| --crash       | 可选，查看崩溃日志；与`--path`搭配时改为分析本地故障日志文件或目录（自动识别日志类型，目录模式选取置信度/完整性/时间最优的候选）                                      |
| --stack       | 可选，分析本地采样栈文件（`--path`必选，不可与`--crash`同时使用）                                                                             |
| --path        | 可选，本地故障日志/采样栈的文件路径或目录路径；不可与设备日志流参数（`--device`、`--level`、`--bundle-name`、`--keyword`、`--tail`、`--from`、`--to`、`--follow`）同时使用 |
| --format      | 可选，本地分析输出格式：`default`（来源信息+中文报告）、`json`（结构化结果）、`report`（纯中文报告）；`--crash`另支持`hilog`（提取日志中的 HiLog 流水区段）。默认`default` |
| --limit       | 可选，`--stack`展示的热点数量上限，取值为正整数，默认`20`                                                                                  |
| --level       | 可选，日志级别，取值包括`D`（ `Debug` ）、`I`（ `Info` ）、`W`（ `Warn` ）、`E`（ `Error` ）、`F`（ `Fatal` ）                                       |
| --bundle-name | 可选，根据包名查看日志                                                                                                                |
| --keyword     | 可选，根据关键词查看日志，关键词区分大小写                                                                                                      |
| --tail        | 可选，显示最新的N行日志，取值为正整数                                                                                                        |
| --from        | 可选，起始时间，单位为`m`和`s`，`m`和`s`为小写，默认为`s`，`start`的取值需要大于等于`end`                                                                 |
| --to          | 可选，结束时间，单位为`m`和`s`，`m`和`s`为小写，默认为`s` 。不可与--follow同时使用。**说明：** 如当前时间为05：00，`start`设置为30s，`end`设置为10s，则起始时间为04：30，结束时间为04：50 |
| --follow      | 可选，实时输出日志。不可与--to同时使用                                                                                                      |

**示例：**

```bash
devecocli log --level E
devecocli log --crash --bundle-name com.example.app
devecocli log --device 127.0.0.1:5555 --level W --keyword Init
devecocli log --tail 100 --from 5m --to 2m
devecocli log --follow --bundle-name com.example.app
devecocli log --crash --path ./faultlogs --format report
devecocli log --crash --path cppcrash-com.example.app-1234-20260901100000 --format hilog
devecocli log --stack --path sample_stacks.txt --limit 20 --format json
```

### `verify`

根据自然语言测试计划，在连接的设备上执行 UI 意图校验。命令会启动应用、执行测试步骤，并返回校验结果。

**命令格式：**

```bash
devecocli verify --test-plan '<plan>' [--bundle-name <name>] [--no-fresh-start] [--device <name|serial>]
```

**参数：**

| 参数名           | 说明                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------- |
| --test-plan   | 必选，自然语言测试计划，描述需要执行的操作和预期结果，最多 3000 个字符。建议使用单引号包裹测试计划，避免特殊字符被终端解析                         |
| --bundle-name | 可选，待测试应用的包名。缺省时，优先从当前工程的 `AppScope/app.json5` 中自动获取                               |
| --no-fresh-start | 可选，不重新启动应用。缺省时，执行 UI 校验前会重新启动应用                                             |
| --device      | 可选，设备名称或设备序列号。连接单台设备时可缺省；连接多台设备时必选。设备名称支持部分匹配，包含空格时请使用引号包裹 |

**说明：**

- 执行前需要先通过 `devecocli verify init` 配置多模态模型。
- 未指定 `--bundle-name` 且无法从工程的 `AppScope/app.json5` 读取包名时，直接报错，请显式传入 `--bundle-name <name>`。
- `--device` 支持设备名称和设备序列号；连接多台设备时必须明确指定目标设备。
- 命令执行过程中会显示当前校验进度，完成后输出 JSON 格式的校验结果。
- 单次 UI 意图校验最长执行 10 分钟，超过后将终止本次校验。
- 返回结果中的 `id` 是本次校验任务的唯一标识，可用于获取日志和保存截图。

**示例：**

```bash
devecocli verify --test-plan '1. 启动应用，预期：进入应用主界面'
devecocli verify --test-plan '1. 启动应用；2. 点击登录按钮；3. 预期：进入首页' --bundle-name com.example.app
devecocli verify --test-plan '1. 检查当前页面' --device 127.0.0.1:5555
devecocli verify --test-plan '1. 检查当前页面' --device "Mate 70 Pro"
devecocli verify --test-plan '1. 检查当前页面' --no-fresh-start
```

### `verify init`

配置 UI 意图校验使用的多模态模型。三个参数均可单独更新；至少需要提供一个参数。

**命令格式：**

```bash
devecocli verify init [--base-url <url>] [--model-name <name>] [--api-key <key>]
```

**参数：**

| 参数名       | 说明                                                       |
| --------- | -------------------------------------------------------- |
| --base-url | 可选，多模态模型服务的 OpenAI 兼容接口地址                         |
| --model-name | 可选，多模态模型名称                                           |
| --api-key  | 可选，多模态模型服务的 API Key。API Key 在本地保存时会进行加密             |

**示例：**

```bash
devecocli verify init --base-url "https://example.com/v1" --model-name "qwen3-vl-plus" --api-key "your-api-key"
devecocli verify init --api-key "your-new-api-key"
```

### `verify log`

根据 UI 意图校验任务 ID 获取执行日志，并支持按关键词筛选和限制输出长度。

**命令格式：**

```bash
devecocli verify log --id <id> [--search-keywords '<keywords>'] [--max-log-size <n>]
```

**参数：**

| 参数名              | 说明                                                                  |
| ---------------- | ------------------------------------------------------------------- |
| --id             | 必选，`verify` 返回结果中的任务 ID                                    |
| --search-keywords | 可选，只输出包含指定关键词的日志行。关键词包含空格或特殊字符时请使用单引号包裹 |
| --max-log-size   | 可选，限制输出的最大字符数，默认为 `5000`；设置为 `-1` 表示不限制           |

**示例：**

```bash
devecocli verify log --id 89f9ad72-63fe-4923-97cb-cb69c3bc6105
devecocli verify log --id 89f9ad72-63fe-4923-97cb-cb69c3bc6105 --search-keywords 'error'
devecocli verify log --id 89f9ad72-63fe-4923-97cb-cb69c3bc6105 --max-log-size 5000
```

### `verify screenshot`

根据 UI 意图校验任务 ID，将校验过程中的截图保存到指定目录。

**命令格式：**

```bash
devecocli verify screenshot --id <id> --save-path <path>
```

**参数：**

| 参数名       | 说明                                             |
| --------- | ---------------------------------------------- |
| --id       | 必选，`verify` 返回结果中的任务 ID                 |
| --save-path | 必选，截图保存目录。目录不存在时会自动创建             |

**示例：**

```bash
devecocli verify screenshot --id 89f9ad72-63fe-4923-97cb-cb69c3bc6105 --save-path "C:\Users\user\Desktop\screenshots"
```

### `skills list`

查询可用的 `Skill`

**命令格式：**

```bash
devecocli skills list --long
```

**参数：**

| 参数名       | 说明                                              |
| --------- | ----------------------------------------------- |
| -l，--long | 可选，`Skill` 详情，包括描述和已安装的智能体列表。缺省时，仅显示 `Skill` 名称 |

**示例：**

```bash
devecocli skills list
devecocli skills list --long
devecocli skills list -l
```

### `skills find`

按关键词搜索 `Skill`

**命令格式：**

```bash
devecocli skills find <keyword>
```

**参数：**

| 参数名     | 说明       |
| ------- | -------- |
| keyword | 必选，搜索关键词 |

**示例：**

```bash
devecocli skills find deveco
```

### `skills add`

将 `Skill` 添加到智能体中。**已有内容默认跳过；更新或将智能体的复制副本改为软链接，需执行 `devecocli skills add --skill <name> -f`（或 `--force`），旧内容及本地修改会被删除。** 正确安装的软链接自动更新，不重复安装，建链失败时回退为复制。

解压后的 skill 数据存储在 `<CLI data directory>/skills/store/<name>`（全局）或 `<project>/.deveco-cli/skills/store/<name>`（项目级，建议在版本控制中忽略 `.deveco-cli/skills/`）。Agent 的 skill 条目（如 `.agents/skills/<name>`）直接链接至该存储，供新 Agent 复用现有文件。**注意：使用 `-f` 更新会影响该作用域下所有已链接的 Agent。**

**命令格式：**

```bash
devecocli skills add --all --agent <agents> --skill <skill-name> --project <path> --path <path> --force
```

**参数：**

| 参数名        | 说明                                                        |
| ---------- | --------------------------------------------------------- |
| --all      | 可选，添加所有可用的 `Skill` ，与 `--skill` 二选一                       |
| --agent    | 可选，智能体名称，多个智能体时以英文逗号分隔。缺省时，添加到已检测到的智能体中                   |
| --skill    | 可选，待添加的 `Skill` 名称，与 `--all` 二选一                          |
| --project  | 可选，指定项目路径，将 `Skill` 添加到该工程项目中                             |
| --path     | 可选，指定路径，将 `Skill` 添加到该路径，不可与 `--project` 或 `--agent` 同时使用 |
| -f，--force | 可选，直接替换已有 Skill，并允许创建不存在的项目目录或自定义目标目录 |

**示例：**

```bash
devecocli skills add --all
devecocli skills add --skill skillname --agent agentname --force # skillname需替换成实际的Skill名称
devecocli skills add --skill skillname --project ./my-app  # skillname需替换成实际的Skill名称
```

项目范围内，普通的 `skills/`、`data/`、`agent/` 目录不用于自动识别智能体；这类安装位置需显式指定 `--agent`。单个 Skill 安装失败后会继续处理后续 Skill，最后输出汇总并以非零状态退出。

### `skills remove`

删除已安装的 `Skill`。不带 `--agent` 时，清理当前全局或项目范围内所有支持的智能体；指定 `--agent` 时仅移除所选智能体的安装，其他智能体仍在使用的共享内容会保留，并列出使用者。项目中的普通 `skills/`、`data/`、`agent/` 目录不会被自动清理，需显式指定对应的 `--agent`。

**命令格式：**

```bash
devecocli skills remove --skill <skill-name> --agent <agents> --project <path> --path <path>
```

**参数：**

| 参数名       | 说明                                                       |
| --------- | -------------------------------------------------------- |
| --skill   | 必选，待删除的 `Skill` 名称                                       |
| --agent   | 可选，智能体名称，多个智能体时以英文逗号分隔。缺省时，清理所有支持的智能体         |
| --project | 可选，指定项目路径，删除该项目中的 `Skill`                                |
| --path    | 可选，指定路径，删除该项目中的 `Skill`，不可与 `--project` 或 `--agent` 同时使用 |

**示例：**

```bash
devecocli skills remove --skill skillname  # skillname需替换成实际的Skill名称
devecocli skills remove --skill skillname --agent agentname  # skillname需替换成实际的Skill名称
```

### `serve mcp`

启动本地 `MCP` 服务。智能体配置 `MCP` 服务后，可通过 `MCP` 协议调用下方列出的代码分析与语言特性工具。不同智能体平台配置 `MCP` 服务的界面不一样，一个智能体平台的配置示例如下。
推荐通过 `devecocli init --mcp` 自动配置

```bash
{
  "mcp": {
    "deveco-mcp": {
      "type": "local",
      "command": [
        "devecocli",
        "serve",
        "mcp"
      ],
      "environment":{
        "PROJECT_PATH": "D:\\code\\sample_project", // 工程路径
        "NODE_MAX_OLD_SPACE_SIZE": "8192", // 可选，设置内部node进程最大的老生代内存大小，默认为8192
        "DEVECO_PATH": "D:\\Application\\DevEco Studio", // 可选，Deveco Studio的路径
        "DEVECO_CLI_CPP_ENABLED": "true", // 可选，是否启用C++ LSP服务，默认为true，设为false可关闭
        "DEVECO_CLI_CPP_COMPILE_COMMANDS": "{workspace}/compile_commands.json" // 可选，自定义compile_commands.json路径，指定后跳过compileNative同步，直接复用该编译数据库。{workspace}占位符替换为工程根，多工程可共用同一份配置；文件缺失/非法时回退默认同步流程
      },
      "enbale": true
    }
  }
}
```

#### MCP 工具

`deveco-mcp` 服务遵循 [MCP](https://modelcontextprotocol.io) 规范，通过 `tools/list` 暴露工具、由模型经 `tools/call` 调用。每个工具由**名称**、**描述**和 **JSON Schema 入参**定义；返回值为 `content` 文本数组，`isError: true` 表示执行错误。

**工具总览：**

| 工具名 | 用途 | 支持语言 |
| --- | --- | --- |
| `check` | 静态语法分析，返回结构化诊断信息 | ArkTS、C/C++ |
| `hover` | 获取指定位置的悬浮信息（类型、文档） | ArkTS、C/C++ |
| `definition` | 查找符号定义位置 | ArkTS、C/C++ |
| `declaration` | 查找符号声明位置（ArkTS 中可能与定义不同） | ArkTS、C/C++ |
| `references` | 查找符号在全工程中的所有引用 | ArkTS、C/C++ |
| `implementation` | 查找符号的实现（如接口实现） | ArkTS、C/C++ |
| `workspaceSymbol` | 按名称在全工程搜索符号 | ArkTS、C/C++ |
| `documentSymbol` | 获取单文件的符号树（函数、类、变量及范围） | ArkTS、C/C++ |
| `callHierarchy` | 查询函数调用关系（incoming=调用方，outgoing=被调用方） | ArkTS 双向、C/C++ 仅 incoming |
| `restart` | 原地重启（重置状态 + 重新 sync/init），不杀进程、客户端不断开；ERROR 态可用 | ArkTS、C/C++（可按 target 单选） |

**可用性说明：**

- `check` 始终注册；`restart` 仅在 ArkTS LSP 使用 stdio 模式时注册，socket 模式共享 ace-server 生命周期，不提供 `restart`。MCP 对外仍使用 stdio。其余 8 个语言特性工具仅在检测到标准 LSP 服务入口（`standardIndex/index.js`）时注册，老版本将不暴露这些工具。
- 所有语言特性工具需项目进入 `READY` 状态（`ohpm install` + `hvigor sync` + LSP 初始化完成）后才可用；未就绪时返回 `please retry in N seconds`，模型可稍后重试。`restart` 例外：它正是用于把 server 从 `ERROR` 态拉回，调用后返回"约 10 秒后重试"，后台异步重置并重新 sync/init。
- C/C++ 工具需要工程包含 C++ 模块；无 C++ 代码时返回 `No C++ code`。
- 支持的文件扩展名：ArkTS 为 `.ets`；C/C++ 为 `.c` `.cc` `.cpp` `.cxx` `.c++` `.h` `.hh` `.hpp` `.hxx` `.h++` `.ipp` `.ixx` `.inl` `.inc` `.tpp`。
- 不属于当前工程的路径会被拒绝。

**入参定义：**

##### `check`

对传入的源文件进行静态语法分析并返回诊断信息，支持 ArkTS 与 C/C++ 在同一次调用中混合传入。

| 参数 | 类型 | 必选 | 说明 |
| --- | --- | --- | --- |
| `files` | string[] | 是 | 待检查的源文件路径列表，相对工程根目录，至少 1 个 |

##### `hover` / `definition` / `declaration` / `references` / `implementation`

位置类语言特性，共享同一入参结构。返回该位置符号的类型/文档信息、定义/声明位置、引用列表或实现列表。

| 参数 | 类型 | 必选 | 说明 |
| --- | --- | --- | --- |
| `file` | string | 是 | 源文件路径，相对工程根目录，支持 `.ets` 与 C/C++ 扩展名 |
| `line` | number | 是 | 行号，0-based |
| `character` | number | 是 | 列号（字符偏移），0-based |

##### `workspaceSymbol`

按名称在全工程搜索符号，无需打开具体文件。

| 参数 | 类型 | 必选 | 说明 |
| --- | --- | --- | --- |
| `query` | string | 是 | 符号名称或片段，非空 |

##### `documentSymbol`

获取单个文件的符号树，适合文件概览、结构化拆解和大文件切片。

| 参数 | 类型 | 必选 | 说明 |
| --- | --- | --- | --- |
| `file` | string | 是 | 源文件路径，相对工程根目录，支持 `.ets` 与 C/C++ 扩展名 |

##### `callHierarchy`

查询某位置函数的调用关系。

| 参数 | 类型 | 必选 | 说明 |
| --- | --- | --- | --- |
| `file` | string | 是 | 源文件路径，相对工程根目录，支持 `.ets` 与 C/C++ 扩展名 |
| `line` | number | 是 | 行号，0-based |
| `character` | number | 是 | 列号（字符偏移），0-based |
| `direction` | enum | 是 | `incoming`=谁调用了该函数；`outgoing`=该函数调用了谁。ArkTS 支持双向，C/C++（clangd）仅 `incoming` |

##### `restart`

原地重启 MCP server：重置双侧状态并重新 sync/init（ohpm install + hvigor sync + compileNative + LSP 握手），不杀进程、客户端连接保持。用于 sync/init 失败导致 server 停在 `ERROR` 态时（免去退出并重开 agent）。fire-and-forget：立即返回"约 10 秒后重试"，重置在后台异步进行。**注意：`restart` 仅在修复根因后用于恢复，不能修复错误的工程配置。若重启后再次失败，说明是持久性配置问题（oh-package.json5/build-profile.json5 无效、ohpm install 或 hvigor sync 失败、SDK 版本不符等），不要循环调用 `restart`，应请用户排查并修复工程后再重试。**

| 参数 | 类型 | 必选 | 说明 |
| --- | --- | --- | --- |
| `target` | enum | 否 | 重启哪一侧：`arkts`（ArkTS ace-server）、`cpp`（C++ clangd）、`all`（双侧，默认）。省略等同 `all` |

### `serve lsp`

启动本地 `LSP` 语言服务。智能体配置 `LSP` 服务后，可通过 `LSP` 协议获取代码补全、跳转定义、悬浮提示、引用查找、诊断等语言特性。当前支持 `ArkTS`和 `clangd`。

```bash
{
  "lsp": {
    "ArkTS": {
      "command": [
        "devecocli",
        "serve",
        "lsp",
        "--arkts"
      ],
      "extensions": [
        ".ets"
      ]
    },
    "clangd": {
      "command": [
        "devecocli",
        "serve",
        "lsp",
        "--cpp"
      ],
      "extensions": [
        ".c",
        ".cpp",
        ".cc",
        ".cxx",
        ".h",
        ".hpp",
        ".hxx",
        ".hh"
      ]
    }
  }
}
```

**参数：**

| 参数名 | 说明 |
| --- | --- |
| `--arkts` | 与 `--cpp` 二选一，启动 ArkTS 语言服务（ace-server） |
| `--cpp` | 与 `--arkts` 二选一，启动 C/C++ 语言服务（clangd） |
| `--project-path <path>` | 可选，工程根路径，默认为当前工作目录 |
| `--auto-detect` | 可选，当前目录向下查找工程根（检查当前目录自身及其子目录，最多 3 层子目录）；适用于 `--arkts` 和 `--cpp`；指定了 `--project-path` 则忽略 |

> `serve lsp` 是常驻 stdio 服务，**不能直接在终端运行**。请查阅所用智能体自身文档中"配置自定义 LSP 服务"的方式，将上述命令填入其配置。
>
> **注意：不要把 `serve lsp` 与 `devecocli serve mcp` 同时接入同一个智能体。** 两者会各自拉起一份 ace-server/clangd 实例，内存翻倍。请在直连 LSP 与 MCP 中二选一，**推荐 MCP**——接入更简单，且自带初始化。
>
> 智能体不支持自定义 LSP（仅支持 MCP）时，可搭配 [agent-lsp](https://github.com/blackwell-systems/agent-lsp)（把任意 stdio LSP 封装为 MCP server）使用，例如 MCP command：`["agent-lsp", "ets:devecocli,serve,lsp,--arkts"]`。

### `signature generate`

自动生成签名材料（包括p12密钥库、csr证书请求文件、p7b配置文件、cer证书文件），并将签名配置写入项目的 `build-profile.json5` 中。支持生成 `debug` 和 `release` 两种类型的签名。

**命令格式：**

```bash
devecocli signature generate  --product <product> --team-id <team-id> --type <type> --force --help
``` 

**参数：**

| 参数名                   | 说明                                      |
|-----------------------|-----------------------------------------|
| --product \<product\> | 可选，指定product生成签名，默认为 `default`          |
| --team-id \<team-id\> | 可选，指定生效的team-id,默认使用自身作为团队信息            |
| --type \<type\>       | 可选，签名类型：`debug` 或 `release`，默认为 `debug` |
| --force               | 可选，强制覆盖已存在的证书文件 |
| --help,--h            | 可选，查看帮助信息                               |

**示例：**

```bash
# 自动生成调试签名并写入工程配置
devecocli signature generate

# 生成 release 签名（用于正式发布）
devecocli signature generate --type release

# 指定product
devecocli signature generate --product default

# 指定team-id
devecocli signature generate --team-id 1222

# 强制覆盖已存在的证书文件
devecocli signature generate --force

# 查询帮助信息
devecocli signature generate --help
```

## 常见问题

[FAQ](https://gitcode.com/openharmony-sig/deveco-cli/wiki/FAQ.md)

## 开发

```bash
npm install
npm run dev
npm start -- <command>
npm run lint
npm run format
npm run build
```

- 架构与目录说明见 [`AGENTS.md`](./AGENTS.md)
- 如需参与维护，建议先阅读 `AGENTS.md` 中的约定与架构说明

## 许可证

[MIT](./LICENSE)
