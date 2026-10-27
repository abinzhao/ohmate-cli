# 本地 Web 工作台运行合同

适用范围：OHMate 0.1.0 的 M1 Web 和 M2 会话/协议切片。页面是统一 Runtime 的入口，
不代表 M2–M4 调试、Kit 或完整工程生成已经完成。

## 入口与资源

| 入口 | 当前行为 |
| --- | --- |
| `ui` / `ui --no-open` | 独立后台 worker 启动或复用同一工作台；默认 127.0.0.1 随机端口 |
| `ui status` | 输出服务状态、进程、启动根与设备未探测状态，不含控制能力 |
| `ui stop` | 核验进程身份、认证本地控制请求，等待服务退出；任务记录保留 |
| `debug start` / `devtools serve` | 无浏览器启动同一服务，不探测设备；与 `ui` 共享 DebugSession |
| `debug status/list/show/stop` | 同源状态、持久会话记录及服务停止；停服保留会话，重启新建 ID |
| `debug protocol` | 1.1/1.0 只读协议的结构 Schema 与通道哈希，不代表实际采集能力 |
| `debug events <id> --stream <id>` | 校验并查询私有持久事件；不恢复设备认证 |
| `debug pair` | human 格式和双 TTY 下显示一次性邀请；检查启动根/代码指纹，普通回执不包含邀请 |
| `project register/list` | 校验真实 build-profile 与模块或 AppScope 公开配置，保存明确选择的应用 |
| `ui layout/find/wait` 等 | 保留原设备命令；原 `ui` 父节点通过 `execute deveco.ui` 可达 |

源码为 `apps/web`；CLI 构建步骤复制到 `dist/web`，五个 npm workspace 保持。
HTTP 只提供固定资源名，不将 URL 当本机文件路径。Runtime 可导入，
不会因 Web 模块启动监听、解析 argv 或打开浏览器。

一级导航为新任务、我的应用、成果与报告；调试通过当前应用的上下文入口打开。
六个意图按钮只填入可编辑目标。任务页使用 `#task/<id>` 路由，刷新和前进后退可
恢复任务；成果视图分开显示“已应用变更”和“执行计划”，并提供 stdout/stderr
运行日志。成果面板在窄屏作为模态层，支持背景隔离、焦点约束和 Esc 关闭。
最近任务与成果页支持关键词和状态筛选；侧栏提供已关联会话与当前应用状态。
界面跟随系统深浅色，错误提示保持到用户关闭。
自然语言发送需要模型与上下文预览确认；本地工具无需模型。当前应用选择、
模型引用配置、人工记忆、规则、任务审批、取消、恢复和回执均调用原注册服务。
设备未主动检测时显示未检测。界面中的回执不是应用已完成或已上架的证明。

## HTTP 到 CLI 映射

| 接口 | Runtime/CLI 操作 |
| --- | --- |
| `GET /api/v1/capabilities` | `capabilities`，原注册 Schema 与风险 |
| `GET /api/v1/debug/status` | `debug.status`，不含浏览器/控制能力 |
| `GET /api/v1/debug/sessions`、`/:id` | `debug.list/show`，已保存的同源调试记录 |
| `GET /api/v1/debug/protocol` | `debug.protocol`，与安装包 Runtime 导出的纯协议一致 |
| `GET /api/v1/debug/bridge` | 同一 worker 的当前桥接状态；无邀请或密钥 |
| `POST /api/v1/debug/pairing/revoke` | 认证和 CSRF 后的专用控制路由；不通过通用任务传递邀请 |
| `GET /api/v1/debug/sessions/:id/streams/:stream/events?after=n&limit=n` | 与 `debug.events` 同源完整校验和分页，返回 nextCursor/through/hasMore；只接受启动工作区 |
| 同路径 `/live` | 已保存调试事件的独立 SSE，支持 Last-Event-ID；end/fault 控制消息不计为采集事件 |
| `POST /api/v1/tasks` | `task.submit`，冻结 toolId、input、真实项目、locale；默认后台 |
| `GET /api/v1/tasks`、`/:id` | `task.list/show` |
| `GET /api/v1/tasks/:id/events?after=n` | 同一 `task.events` 存储；SSE，支持 Last-Event-ID |
| `POST /api/v1/tasks/:id/approve` | `task.approve`，仅接受该任务的未过期单次 planId |
| `POST /api/v1/tasks/:id/cancel/resume` | 原 TaskManager 取消与恢复；不自动重放写入 |
| `POST /api/v1/execute` | 已登记模型元数据、上下文、会话、规则、记忆与应用登记的短请求 |

所有其它可执行工具走持久任务。生命周期和 stdio 协议入口只在终端执行，
Web 返回明确终端入口；不能借通用任务递归运行这些控制服务。
网页允许选取启动根或已登记应用，拒绝未经登记的 task projectRoot，
也拒绝旧命令参数偷偷切换项目。创建目标仍由具体工具自身计划与审批处理。

SSE 每个持久事件使用真实 sequence 作为 id，结束使用单独 `event: end`，
该控制消息不算任务事件。游标按事件续读；浏览器断线不重放工具。
每个服务最多八个流、32 个进行中的 HTTP 请求，支持响应背压与断开清理。
强制取消后残留的进程记录需要核验实际身份；原进程已经死亡时正常结束流，
不会永久等待它写出 process.closed。
已批准的任务在 worker 启动前可能暂时仍为 awaiting-approval；有 approvedPlan
时事件流继续等待后续执行，不把这一过渡状态当成流结束。

## 认证与本地数据

浏览器链接使用一次性 fragment ticket，60 秒有效，交换后立即清除。
8 小时的会话 Cookie 为 HttpOnly、SameSite=Strict，仅本机明文 HTTP，
服务停止后失效。每次修改请求同时检查 Host、Origin 和随机 CSRF 值。
无跨域许可、第三方脚本、字体、遥测；CSP 禁止 iframe 嵌入和脚本注入。

服务控制能力位于私有 `web/service.json`（0600），目录拒绝符号链接，
文件拒绝符号链接、硬链接和异常权限；该字段不出现在 ui status、任务事件、
模型上下文或报告。
本地控制接口要求能力与进程身份，只向 loopback 请求，不按任意文件 PID 杀进程。
浏览器只配置凭据环境变量名称，不保存模型密钥。

每次服务启动保存私有 DebugSession 并将 ID 写入服务记录；正常停止记为 stopped，
原进程身份失效的会话查询为 disconnected。初始 target 为 null，bridge 为
`waiting-pairing`。loopback WebSocket 接入一次性邀请和标准 AEAD，加密确认后
接收只读摘要并在私有事件文件同步后 ack。已配对身份仍为 `peer-asserted`，
build 为 `unverified`，不能据此声明真实 Kit/设备认证或开放写操作。
格式、隐私和剩余接入见 `debug-bridge.md`。
HTTP/SSE 工作台与只读 Kit 协议分别建模；任务事件不能冒充设备事件。
调试页展示未配对/断开/停止和未验证身份，读取会话最新 stream 并支持下一页。
实时跟随保留最近 100 条，暂停或导航离开会关闭订阅。损坏日志显示明确错误，
不无限重连；刷新只读取状态，不恢复设备认证或重放操作。

固定资源、JSON 请求上限 512 KiB、已选公开文件预算、TaskStore 上限、
审批指纹与 Agent 预算一起限制输入和输出。模型授权仍绑定文件、规则、
记忆、历史、回执及 Schema；后台批准操作不能成为 Agent 自行授权的工具。
文件选择支持独立 `writePaths`，预览绑定精确路径及旧内容哈希。引用文件不
自动允许修改。Patch 计划按文件展示统一 Diff；代码以文本节点渲染。实际执行
和恢复都由同一 R2 工具完成，详见 `workspace-patch.md`。

## 验证

- `web.test.ts`：实际 HTTP、共享 CLI 快照、游标、Origin/CSRF、单次 ticket、
  R2 确认后的真实临时文件写入和重用拒绝、强制取消结束流、资源白名单。
- `web-lifecycle.test.ts`：真实后台进程、单服务复用、私有权限、
  终端优先入口、状态脱敏与停止后进程退出；不操作设备。
- `debug-lifecycle.test.ts`：三个入口复用、HTTP/CLI 会话一致、停止与重启；
  真实 worker 配对、事件落盘和终端同源查询。
- `debug-pairing.test.ts`、终端 `private-pairing.test.ts`：私有 sink、双 TTY、
  JSON/管道/非交互拒绝、代码和启动根漂移、写失败撤销及流 error 事件处理。
- `debug-events.test.ts`、`journal-concurrency.test.ts`：共享分页游标、同源/范围/
  Schema 校验、损坏和缺尾拒读、实时追加、Last-Event-ID、结束/fault 与提交锁。
- `bridge.test.ts`、`security.test.ts`、`event-journal.test.ts`：真实加密帧、
  N/N-1、重放/身份变化、确认前拒绝、配额/损坏/链接和 memory-only 文本。
  `debug-protocol` 仍单独验证只读 Schema、ack/冲突/gap、epoch 与时钟分段。
- `scripts/verify-debug-lifecycle.mjs`：构建入口及 Runtime 的 1.1/1.0 内存矩阵、
  实际 WebSocket/AEAD 的 N/N-1、持久事件和终端查询；不启动 Kit 设备端
  Producer。最新工作台的独立安装验证由 `verify-debug-workbench.mjs` 执行。
- `scripts/verify-web.mjs`：构建或独立安装入口、HTTP/CLI 目录和任务完全相同、
  SSE、安装资源 SHA-256；不需要模型或 HarmonyOS 应用设备。
- `scripts/verify-debug-workbench.mjs`：真实 PTY、构建/独立安装 CLI、104 条加密
  Node 测试对端事件、页面分页/实时计数/暂停与断开、memory-only 和 1280/390
  布局；邀请不进入持久数据。agent-browser 使用测试独占会话与快照引用。
- `scripts/verify-web-browser.mjs`：临时 Chrome 156，三导航六意图、无模型阻止、
  真实后台 doctor、R2 计划取消、应用选择、上下文、API 元数据、记忆与报告；
  1440×900、1024×768、390×844 无横向溢出且输入可达。另有新任务清空旧输入回归。
- `npm run test:web:touch`：先构建当前 CLI，再用测试独占 Chrome profile、
  CDP touchStart/touchEnd 探针和 touch tap 手势验证 390×844 抽屉、焦点隔离、
  文件 Sheet、模型菜单、成果 tabs 与设置 tabs；不使用 DOM `.click()`。
- `npm run test:platform`：先构建全部 workspace，再在当前真实宿主串行执行进程身份/
  取消、带空格脚本、文件锁和 Web worker 生命周期；每个平台需在其原机单独运行。
- `scripts/verify-patch-browser.mjs`：测试独占 Chrome profile 与本地服务，核验
  写入前 Diff、后台人工审批实际写入、后续事件、1440/390 布局和精确写入范围。

此前 agent-browser 成功打开临时 Chrome 后，其后续命令等待停滞；同一测试专属 Chrome
的直接 CDP 可正常操作，后续验收采用此降级。未使用用户原有浏览器资料。
当前验证 macOS Chrome 的鼠标和 CDP 触控仿真；物理触屏未执行。Safari 26.6.2
已安装，但 WebDriver 因“允许远程自动化”未启用而拒绝创建会话；未擅自修改该设置。
Firefox、Windows/Linux 原机服务与读屏实测未完成。
MCP Client、多模态材料、真实 Kit/HDC、网络/Mock/ArkUI/ArkWeb/性能子视图、
独立 evidence API 与完整工程生成/验证/交付仍在下一范围。
