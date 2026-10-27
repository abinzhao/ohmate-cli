# 隐私说明

`deveco-cli` 高度重视用户隐私保护。内置的匿名遥测（打点）功能仅用于改进产品体验（如统计命令使用频率、构建耗时、失败率等），**不收集任何敏感或可能关联到用户身份的信息**：不采集源码、文件内容、账号凭据、token、操作系统级硬件标识等，命令参数原则上仅记录 flag 名称、不记录取值。遥测默认开启，但可通过环境变量 `DEVECO_CLI_DISABLE_TELEMETRY=1` 随时一键完全关闭（详见第 6 节），关闭后不再采集任何数据；打点、上报失败也绝不会阻塞或改变任何命令行为。

## 1. 遥测默认开启

`deveco-cli` 默认开启匿名遥测，用于改进产品体验（如统计命令使用频率、构建耗时、失败率等）。遥测不影响任何业务功能的执行：打点失败、上报失败均不会阻塞或改变命令行为。

## 2. 采集内容

### 2.1 事件类别

| 事件 | 触发场景 | 采集的业务字段（event_detail） |
|---|---|---|
| 命令执行 | `devecocli` 各子命令（build / run / device / emulator / skills / docs / update / create / auth 等） | 命令名、使用的选项（仅 flag 名称，不含参数值）、耗时、成功/失败、错误码、部分命令的内存统计（如构建内存） |
| MCP 工具调用 | `devecocli serve mcp` 下的工具调用（check / hover / definition / references 等） | 工具名、方向（incoming/outgoing）、文件扩展名、CLI 与语言服务进程内存、成功/失败、错误码 |
| 技能操作 | `devecocli skills add / list / find / remove` | 子操作名、使用的选项（仅 flag 名称）、find 搜索词原文与长度、add/remove 的 --skill 取值、下载数据量、安装/移除成功数、失败原因（仅脱敏后的首词，不含具体错误文本） |
| 文档检索 | `devecocli docs search / read / catalog` | 搜索词原文与长度、目录名、文档 ID |
| 语法检查 | `devecocli check lint` / `check compat` | 命令选项（仅 flag 名称）、耗时、成功/失败、错误码、内存统计 |

### 2.2 每条事件的公共字段

- `uid`：匿名安装标识（installation ID）。初始化时在本机随机生成 UUID v4 并存储于数据目录，不读取 MAC 地址、硬件或任何系统信息；删除数据目录（见第 4 节）后重新生成，重置前后的遥测事件无法关联到同一安装。
- `session_id`：本次进程会话的随机 ID，每次运行重新生成，仅用于聚合本次会话内的事件，不作为身份标识。
- `trace_uuid`：每条事件的随机 ID。
- 环境信息：操作系统名称与架构、CLI 版本、DevEco Studio 版本、CLT 版本、Node.js 版本。
- 耗时、成功/失败、错误码。
- 预定义枚举值：与 CLI 管理的固定系统选项对应的取值，如文档目录名（catalog）、目标 agent 名、来源分类（user_project/sdk/system）、输出格式等白名单值。仅收集固定、预定义的选项值。
- 异常信息：出错时仅采集脱敏后的错误信息——TraceError 取其脱敏的 `traceMessage`，其余异常仅上报错误码（如 `ENOENT`/`EACCES`）或异常类型名，不采集堆栈轨迹，不携带原始错误消息。

## 3. 不采集的内容

- **不采集**：源码、文件内容、工程内数据、命令输出、终端输入。
- **不采集**：除 skills find / docs search 的搜索词原文与 skills add/remove 的 --skill 取值外，不采集用户创建的输入内容与外部标识符，如本地文件路径、Maven 坐标、自定义项目名。
- **不采集**：DevEco 账号、登录凭据、token、Cookie 等敏感信息。
- **不采集**：操作系统级硬件标识（Windows `MachineGuid`、macOS `IOPlatformUUID`、Linux `machine-id` 等）及 MAC 地址。安装标识 `uid` 为纯随机生成，与硬件完全无关。

## 4. 本地存储与加密

- 数据目录：`<数据根目录>/TraceLogData/`。数据根目录默认 `~/.local/share/deveco-cli/`，可通过环境变量 `DEVECO_CLI_DATA_DIR` 覆盖。
- 事件按天分文件落盘（`telemetry-YYYY-MM-DD.txt`），文件使用 **AES-256-GCM 加密**存储。密钥由本机独立的随机密钥（`trace-file-secret`，与安装标识 `uid` 无关）派生，密钥文件仅存在于本机数据目录、不随事件上传，仅用于防止本地文件被直接读取；上传前在内存中解密。
- 上报失败的事件会加密归档到 `TraceLogData/failed/`，并按约 1 小时间隔自动重试（MCP 由调度器定时触发，CLI 由命令结束时按 `isUploadDue` 触发的后台进程触发）；文件名日期超过 7 天的失败文件会被直接删除、不再重试。
- 本地占用有上限：单个打点文件不超过 **8 MB**（约 7.6k 条事件）。归档上报失败的事件时，超出部分只保留最新事件、较旧事件被丢弃；超过 8 MB 的待上报文件会被直接丢弃而不上传（避免上传进程内存溢出）。进程中断遗留的 `.pending` 临时文件超过 1 小时后会被自动回收（并回同名文件重试或删除）。
- 删除数据：直接删除 `TraceLogData` 目录即可清空全部打点数据，同时重置安装标识 `uid`（`uid` 存储于该目录内）。

## 5. 上报

- 本地存在待上报事件且距首条事件超过 **5 分钟**时，通过 HTTPS 上报到遥测服务。
- 上报内容为上述事件数据，不含任何本地文件内容。

## 6. 如何关闭

设置环境变量并重启终端会话即可完全关闭遥测：

```bash
# Windows (PowerShell)
$env:DEVECO_CLI_DISABLE_TELEMETRY = "1"

# macOS / Linux
export DEVECO_CLI_DISABLE_TELEMETRY=1
```

关闭后：

- 不再采集任何事件，不创建新的打点文件，不上传。
- 已有打点数据不会自动删除（如需删除，见第 4 节）。
- 业务功能不受任何影响。

## 7. 相关环境变量

| 环境变量 | 作用 |
|---|---|
| `DEVECO_CLI_DISABLE_TELEMETRY=1` | 关闭遥测（采集与上报） |
| `DEVECO_CLI_DATA_DIR` | 覆盖数据根目录（含打点数据目录） |
