# DevEco CLI / 鸿蒙开发 Plugin

在 {{hostName}} 中通过对话开发 HarmonyOS 应用。你可以让 AI Agent 创建项目、编译和运行应用、查看设备日志、操作应用界面，以及查询鸿蒙开发文档。

## 可以做什么

- **创建项目**：根据应用名称创建 HarmonyOS 工程。
- **配置签名**：登录开发者账号后，生成调试签名材料并写入项目配置。
- **编译和运行**：安装项目依赖、编译应用，并运行到已连接的设备或模拟器上，支持增量部署和热重载。
- **排查问题**：查看编译错误和设备日志，检查 ArkTS 语法、代码规范及 API 兼容性，支持部分问题的自动修复。
- **检查界面**：获取屏幕截图、录制真机屏幕、查看窗口和界面控件，执行点击、滑动、拖拽和文字输入。
- **查询文档**：搜索和阅读 HarmonyOS 开发指南、API 参考和示例。
- **管理设备**：查看已连接设备及其详情，在电脑和设备之间传输文件，操作设备上的 SQLite 数据库。
- **使用模拟器**：创建、启动、停止和删除模拟器，管理系统镜像，模拟定位、电量、传感器和折叠等场景。

## 使用准备

- 安装 Node.js 22 或更高版本。需要安装 DevEco CLI 时，还需要 npm 和能够访问 npm registry 的网络。
- 安装 DevEco Studio，并准备项目所需的 SDK。Linux 用户需要配置 Command Line Tools；可用功能取决于已安装的开发工具。
- 运行应用前，连接设备或启动模拟器。

首次使用时，Agent 会检查 DevEco CLI 是否可用。已有符合版本要求的 CLI 时，可以直接使用；需要安装或升级时，Agent 会根据你的授权执行。DevEco Studio、Command Line Tools 和 SDK 需要单独安装。

## 开始使用

安装并启用插件后，在 {{hostName}} 中打开 HarmonyOS 项目，向 Agent 描述你要完成的任务。例如：

> 帮我编译当前项目，并处理编译错误。

> 把当前应用运行到模拟器上。

> 查看设备上的错误日志，分析应用启动失败的原因。

> 获取当前应用的截图，检查登录按钮是否显示。

> 查询 ArkUI List 组件的用法和示例。

如果还没有项目，可以说：

> 在当前目录下创建一个名为 MyApp 的 HarmonyOS 项目。

连接多台设备时，请说明要使用的设备名称或序列号。任务需要登录时，按提示在浏览器中完成认证；需要接受模拟器协议时，阅读协议并确认后再继续。

## 入口与配置

插件提供以下命令，通常由 Agent 根据任务调用：

| 命令 | 用途 |
| --- | --- |
| `devecocli <command> [options]` | 调用选中的 DevEco CLI，执行编译、运行、查询文档等任务。 |
| `devecocli-runtime-check` | 查看当前使用的 CLI 路径、版本，以及插件要求的最低版本。 |
| `devecocli-install` | 为插件安装或更新 CLI，使用插件指定的默认版本。 |
| `devecocli-install --help` | 查看安装目录、默认版本和安装用法。 |
| `devecocli-install --version <version-or-tag>` | 安装指定版本或 npm 标签对应的版本，版本需要满足插件的最低要求。 |

### CLI 查找顺序

插件按以下优先级选择 DevEco CLI：

1. `DEVECO_PLUGIN_RUNTIME_EXECUTABLE` 指定的绝对文件路径。
2. 依次查找 {{hostBinDirs}} 中已有的 CLI。目录或 CLI 不存在、版本过低或无法识别时，跳过并继续查找。
3. `PATH` 中的 CLI：macOS / Linux 查找 `<PATH 目录>/devecocli`；Windows 查找 `<PATH 目录>\devecocli.cmd` 或 `<PATH 目录>\devecocli.exe`。
4. {{installRoot}} 中由插件安装的 CLI。设置 `DEVECO_PLUGIN_INSTALL_ROOT` 后，使用该变量指定的目录。

第 2 项中的目录仅用于查找已有 CLI，插件安装和更新 CLI 时使用第 4 项的目录。`PATH` 按目录排列顺序查找，忽略相对目录和插件自身的入口。找到的首个 CLI 版本过低或无法识别时，会继续检查第 4 项。第 4 项也需要满足最低版本；没有可用版本时，Agent 会提示安装或升级。路径中的 `~` 表示当前用户目录。

### 指定要使用的 CLI

如果安装了多个版本，或 CLI 没有加入 `PATH`，可以设置 `DEVECO_PLUGIN_RUNTIME_EXECUTABLE`。变量值必须是 CLI 入口文件的绝对路径，例如 npm 安装目录内的 `@deveco/deveco-cli/dist/cli.js`。请根据实际安装位置替换下面的示例路径。

Windows PowerShell：

```powershell
$env:DEVECO_PLUGIN_RUNTIME_EXECUTABLE = 'C:\tools\deveco-cli\node_modules\@deveco\deveco-cli\dist\cli.js'
```

macOS / Linux：

```sh
export DEVECO_PLUGIN_RUNTIME_EXECUTABLE='/opt/deveco-cli/node_modules/@deveco/deveco-cli/dist/cli.js'
```

设置后，从同一终端启动 {{hostName}}。使用桌面客户端时，也可以将变量加入用户环境配置，再重新启动客户端。随后让 Agent 运行 `devecocli-runtime-check`，确认选中的路径和版本。

这个变量也支持真实的 CLI 可执行文件；Windows 支持 npm 生成的标准 `.cmd` 入口和 `.exe` 文件。请指向已经安装的 DevEco CLI，不能填写目录或插件自身的 `bin/devecocli`、`bin/devecocli.cmd`。指定后会直接使用该入口，不检查最低版本；路径无效时会报错，需要修正或删除这个变量。

### 其他配置

| 环境变量 | 用途 |
| --- | --- |
| `DEVECO_PLUGIN_INSTALL_ROOT` | 修改插件安装 CLI 的目录，默认是 {{installRoot}}。需要填写绝对路径，并放在插件目录和当前项目目录之外。 |
| `DEVECO_CLI_DEBUG=1` | 输出命令执行日志，便于排查问题。 |

## 常见问题

### 已经安装过 DevEco CLI，还需要重新安装吗？

符合版本要求时可以直接使用。版本过旧时，Agent 会提示升级；如果你希望保留现有版本，也可以让 Agent 为插件单独安装 CLI。

### 更新插件后，还需要更新 DevEco CLI 吗？

插件和 DevEco CLI 分别更新。更新插件后的首次使用会重新检查 CLI，Agent 会提示是否需要升级。由插件单独安装的 CLI 也可以直接让 Agent 更新。

### 提示开发工具或设备不可用，怎么办？

让 Agent 检查 DevEco CLI、DevEco Studio 或 Command Line Tools 的配置，以及设备连接状态。安装失败时，请检查 npm registry 和代理配置；编译提示缺少 SDK 时，请安装项目要求的 SDK。

### 卸载插件会删除哪些内容？

卸载插件会保留已有的 CLI、项目、SDK、认证和签名文件。由插件单独安装的 CLI 默认保存在 {{installRoot}}，需要释放空间时，可以在相关进程停止后删除该目录。`~` 表示当前用户目录。

## 数据与隐私

DevEco CLI 默认开启匿名使用统计。设置环境变量 `DEVECO_CLI_DISABLE_TELEMETRY=1` 可以关闭。采集内容、存储方式和关闭步骤见随插件提供的 `PRIVACY.md`。
