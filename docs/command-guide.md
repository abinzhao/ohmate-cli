# OHMate 命令行为与边界

本文件保留各命令的输入预算、所有权、恢复及证据边界。
入门流程见 [使用说明](usage.md)，完整参数见 [命令参考](commands.md)；
已知限制以命令帮助和实际回执为准。
本文源码命令在产品根目录执行；涉及 `docs/`、`examples/`、`extensions/`
的文本路径也相对产品根目录。

## 本地使用

需要 Node.js >=22.19.0。开发工具操作使用 DevEco Studio / CLT；帮助、命令目录和
只读诊断可在未安装官方工具时运行。

```bash
npm ci --ignore-scripts
npm run build
node packages/cli-wrapper/cli.js --help
node packages/cli-wrapper/cli.js doctor --format json
node packages/cli-wrapper/cli.js capabilities --format json
node packages/cli-wrapper/cli.js project inspect --project /path/to/app --format json
node packages/cli-wrapper/cli.js ui layout --help
node packages/cli-wrapper/cli.js build plan --project /path/to/app --format json
node packages/cli-wrapper/cli.js build run --project /path/to/app --format json
```

发布包尚未上传 registry。独立安装验证使用本地 npm 产物。

## 命令与执行

保留 `build/run/device/emulator/auth/skills/log/create/init/serve/docs/ui/check/
signature/verify/update` 的源码参数。每个子命令的最新参数、Schema、风险、取消
与恢复合同可由 `capabilities` 查询；`<command> --help` 不执行工具。
`create` 已迁入原生服务，命令参数保留，结构化工具输入改为具名字段。

`doctor` 检查 Node、工程配置、工具链路径和组件是否存在，不查询 registry、
安装依赖、登录、连接设备或迁移 Skill。显式工程身份无效时返回 2；
未指定工程时缺少工程或工具链只记录 warning。

`project inspect` 只读发现 ArkTS、Cloud、Native 和 Mixed facet，输出模块、
target、设备类型、云侧入口、字面量 Native target 与原始文件哈希。
ArkTS 模块位置来自 `build-profile.json5.modules[].srcPath`，需要源码和
SDK/Hvigor 配置；Cloud 支持 `function-config.json` 的显式 handler 加同目录
唯一非空 `.ts/.js` 入口，也保留 `@hw-agconnect/cloud-server` 与实际 `main`
源码的 npm 清单路径。handler 按 `文件名.方法名` 读取，最多64字符，
可选 functionType 只接受0/1，不推断导出或执行状态。Native 需要 CMake 声明与实际源码或
显式 `IMPORTED_LOCATION` 库。拒绝越界、敏感路径和符号/硬链接。
未知类型返回 2，有 facet 但输入不完整返回 3。未读取云账号配置；不支持的云侧
描述、双入口选择、动态/条件 CMake、云运行与 ABI 保持未验证。
发现结果不替代构建和配置的 ArkTS 校验。

```bash
ohmatecli execute doctor --input '{}' --format json
ohmatecli execute deveco.ui.layout --input '{"argv":["--depth","2"]}' --format json
ohmatecli execute doctor --input-file ./request.json --format json
```

R2/R3 操作先返回退出码 5 和当前参数、工程、风险及 `planId`。计划绑定源码
内容、Schema、参数、工程、目标和产品版本，十分钟过期且只能使用一次。
确认具体操作后，使用同一组输入追加 `--approve-plan <planId>` 执行。取消不代表回滚；
强制覆盖、卸载和清理按 R3 处理。受控产品更新尚未完成，底座自动更新被关闭。

`--format json` 输出单个统一回执；底座 stdout 作为 `data.stdout`，进度与错误
写入 stderr。`--raw` 输出底座原始流。`serve mcp/lsp` 保持原协议流，不附加信封。
退出码：0 成功、1 发现问题、2 参数/工程错误、3 必需能力缺失、4 Schema 校验
失败、5 策略拒绝、6 工具错误、130 取消。

## 无浏览器任务

```bash
ohmatecli task submit capabilities --wait --format json
ohmatecli task submit doctor --format json
ohmatecli task submit build.run --payload '{}' --project /path/to/app
ohmatecli task list --format json
ohmatecli task show <id> --format json
ohmatecli task events <id> --after 0 --format ndjson
ohmatecli task approve <id> <planId> --wait --format json
ohmatecli task cancel <id> --format json
ohmatecli task cancel <id> --force --format json
ohmatecli task resume <id> --wait --format json
```

默认由独立后台 worker 执行，关闭终端或 Web 不删除任务。`--wait` 等待最终
任务结果；`task show` 的退出码表示查询是否成功，任务退出码位于 `data.receipt`。
没有模型也能运行已登记的确定性工具。协议服务和递归控制任务不进入后台任务；
`agent.run` 是可提交的内部 Agent 入口，模型无法调用任务控制工具。
原生 CLI 参数和 JSON 输入均从同一 ToolSpec 读取，`--payload` 是被提交工具的
输入；`--input` 则是当前命令的完整 Schema 输入。

同工程写入互斥，原生设备工具按明确目标互斥；底座设备工具暂采用保守的全设备
互斥，防止名称与序列号别名绕过锁。取消先保存请求，再清理子进程并持久化回执；
第二次 SIGINT 请求强制清理。服务恢复先核验 PID 和进程身份，仅中断的只读工具
可以重试；安装、签名等写操作阻止重放。worker 异常退出后，文件锁最多需要
十五秒失效，`resume` 在锁仍有效时返回 `RESOURCE_BUSY`。

审批指纹忽略依赖、构建和产物目录、凭据文件，以及产品数据目录。上限为
10,000 个条目、单文件 8 MiB、总内容 64 MiB；超限会阻止审批，不能据此声称
已经验证被忽略文件或任意大型工程。

## 创建与配置

```bash
ohmatecli create --app-name DemoApp --api-level 22 --device-types phone tablet --format json
ohmatecli execute deveco.create --input '{"appName":"DemoApp","apiLevel":"22"}' --format json
ohmatecli config inspect --path AppScope/app.json5 --project /path/to/app --format json
ohmatecli config validate --path AppScope/app.json5 --project /path/to/app --format json
ohmatecli config edit --input '{"path":"AppScope/app.json5","edits":[{"field":["app","versionCode"],"value":2}]}' \
  --project /path/to/app --format json
```

`create` 复用随包 DevEco 模板生成器，不调用外部 CLI。先在产品私有目录预览，
给出实际文件 Diff、模板和生成文件哈希、目标状态及 SDK 来源；仅审批后提交
到当前工程/cwd 下的目标目录。目标父目录须已存在，拒绝非空目录、符号链接、
越界与私有状态。名称须为 ASCII；未指定 API 时必须从 SDK 元数据取得真实值，
无模板映射的版本会阻断。生成项目级 `AGENTS.md`，自动检查工程标记和模块，
构建、测试、真机仍标为 `not-run`。无法读取 Studio 图标时明确报告底座 1×1
图标兜底，不能作为正式上架素材。创建使用目录 rename；外部最后时刻的目录
写入竞态需要隔离工作区，创建失败不自动重放或删除用户的后续内容。

`config` 支持 app/module/build/oh-package/Hvigor/Runtime Profile 和资源
element/profile JSON 的公开文件。`edit` 的 `operation` 默认是 `replace`，
替换存在的叶字段；显式 `add` 新增对象字段或在原数组索引前插入，原数组
长度表示追加；`remove` 删除指定字段，不传 `value`。父容器须已存在，
同一批操作使用审批快照的原始坐标。保留其它字节、注释、换行和 UTF-8 BOM；
重复键、缺失字段、容器替换、重叠字段与密钥内容会阻断。新增或删除容器
会展示完整值的 Diff。字段路径使用字符串键或数字数组索引。字段 Diff 与文件 Diff 绑定
同一 R2 审批，写入和恢复复用 Patch 日志。`validate` 当前检查语法、顶层对象
和无损编辑条件，SDK 全量语义校验另行执行；输出 `officialValidation:not-run`。

`module.json5` 中的可选 `faultLog` 扩展另做 API21、Stage 模块、名称、源文件、
非导出及有界本地依赖检查。确定错误返回 1；依赖未知、宿主预注册、系统延迟执行
或构建未验证时返回 3、`valid:null`，静态无误不等于接入完成；未配置明确返回
`faultLog.status:not-configured`。参考模板位于
`examples/OHMateKitProducer/entry/src/main/ets/faultlogextension/`，与 Core 分离。
宿主 `faultLogHost.configure(debug)` 不注册，应用本地确认后显式
`confirm(true)` 注册不同名正常 A 和空 B；Extension 使用同名 B。
`detach/onDisconnect` 清空内存并保留过滤配置，显式 `revoke()` 删除 owned
watcher，失败保留清理责任。Extension 使用九秒单调时钟预算、最多 32 条事件名
摘要，不读取故障 params/附件、不自动导出；实际约三十分钟延迟和系统十秒退出
须在授权设备验证。参考页面尚无此确认控件，不自动启用。

独立 `dfx/LeakWatcherHost.ets` 提供参考应用本地 JSLeakWatcher 接入。
`configure(true)` 仅声明宿主独占此主线程 VM 的监测 API；应用代码必须依次
`review(mode)`、`confirm(revision, allowRawFiles)`、`start(revision)`。
`objects` 对原对象调用 `watch(object)`，不复制到线程池，标签固定；
`check()` 只保留空/非空返回状态，不解析或保留对象清单。
`components` 仅监测 CustomComponent，显式 90 秒间隔、最多一个快照，
确认须接受平台生成原始堆文件；回调不读取路径，仅保留最多 32 次数组形状观察。
单次运行十分钟、审阅三十秒，宿主生命周期累计最多 256 次审阅、32 次对象
注册和 3 次手动检测，失败也计入配额。关闭失败保留所有权，只能显式重试；
线程变化不关闭错误 VM，时钟异常永久失效。Ability 退出关闭监测，平台文件
可能仍存在，关闭不代表删除。API26/Phone/debug/SysCap 和宿主独占门控，
不经 Bridge、Agent、日志或 ZIP 传递数据。页面尚无确认控件，真机检测、
GC 开销、平台文件清理与 Release 隔离未验证。

独立 `dfx/RawHeapHost.ets` 提供重型原始堆采集的应用代码入口，默认关闭。
宿主须在独占的非主线程 Worker 上提供 `RawHeapFiles`，依次
`configure(true, files)`、`review('process')`、
`confirm(revision, allowRawFiles, developerOptionsAcknowledged)`、`collect(revision)`。
文件与开发者选项需独立确认；确认不查询或开启系统开发者选项。
API26 三参数 `dumpJsRawHeapData(false, false, true)` 请求全进程 VM，
不主动请求 GC 或释放快照缓存；双参数 API 仅采集调用线程 VM，不能用于
声称主线程采集。主线程、非 Phone、非 debug 和缺失 SysCap 均拒绝。
独占声明不能发现其它 Worker 或应用已有采集器，集成仍由宿主管理。

`RawHeapFiles.prepare` 必须先承担部分、未知路径和迟到输出的清理责任；
`adopt` 只接收最多 16 个、累计 16384 字符的原始返回路径，不能认证文件归属。
SDK 不允许指定输出目录，本例不提供通用路径读取或删除实现，不扫描沙箱。
宿主负责本地有界处理并立即清理，不能凭返回路径覆盖或删除既有文件。
每个宿主 Worker VM 最多一次采集尝试和 256 次审阅，失败消耗额度。
审阅与等待各三十秒；等待预算包含准备、采集、处理和清理。
取消、超时、时钟或线程变化先结束等待，保留在途责任；迟到输出仅交原文件
宿主清理。失败只能 `retryCleanup()` 显式重试，重试等待同样有界。
清理返回 `true` 仅报告 `host-reported-clean`，不证明物理擦除或缓存释放。
没有页面确认、默认 Worker/文件宿主、Bridge、日志、导出或 Agent 入口。
模块 debug 的 `sourceOption.workers` 显式包含此独立源文件，保证编译；
Release 未声明它。声明不启动 Worker，也不证明 Release 产物已清除代码。
原始文件、性能、开发者选项、全进程 VM 范围和 Release 隔离须真机验证。

声明模块下的 `obfuscation-rules.txt` 和 `consumer-rules.txt` 使用相同命令。
规则请求示例：
`{"path":"entry/obfuscation-rules.txt","edits":[{"operation":"add","option":"-keep-property-name","values":["jsonField"]}]}`。
支持 global/property/file 三类名称列表和 Schema 中的基础开关；开关不传
`values`，名称按精确 token 增删，保留其它规则和注释。消费者规则只允许
global/property 保留列表，可删除既有危险开关进行修复。未知指令返回退出码
3 和 `valid:null`，阻止编辑；空列表、孤立参数、文件名路径、重复操作与参数
注入会阻断。解析上限为 10000 token。校验只覆盖明确支持的语法子集，
Release/API 前提和实际依赖规则合并仍需官方验证，`effectiveMerge:not-run`
不能作为发布就绪依据。

`--input-file` 与 `--input` 互斥，适用于当前命令的完整 Schema，不能混入命令
专用参数。只读取显式公共 JSON 文件，最多 1 MiB；拒绝密钥内容、链接文件、
私有产品状态和读取期间发生变化的文件。工具自身的更小输入预算仍然生效。

## 离线堆快照分析

```bash
ohmatecli analyze jsleak --snapshots /path/to/before.heapsnapshot --format json
ohmatecli analyze jsleak --snapshots /path/to/before.heapsnapshot /path/to/after.heapsnapshot --format json
```

只读显式快照，不连接设备或执行转换工具。当前支持经过 Node 22/V8 样本
验证的七字段 JSON 布局子集，校验类型声明、索引、数量和整数；
截断、未知布局/版本、无效 UTF-8、私有/链接文件或超限立即返回 4，
整次分析不发布部分报告。最多两份、每份 32 MiB、合计 64 MiB，
每份 250000 节点、1000000 边、250000 字符串及 16 MiB 字符串字节，
最多 50000 分组；报告最多 64 MiB。

原始 SHA-256、声明的强边可达性、按类型和名称哈希分组的对象数量/
自身字节，以及每组一个最长 16 节点的最短强路径进入回执和私有 JSON
报告。弱边和 shortcut 排除，路径截断明确标记，堆字符串和边名称不复制。
完整报告超过 1 MiB 时，回执仅保留数值摘要、分组数量及带哈希的报告
引用，`groupsLocation:report-artifact` 明确标记；文件保留所有分组和差值。
双快照只按输入顺序比较分组数值，保留正/负/零差值；不关联对象 ID，
也不认证采集时间、设备或 build。Retained Size、泄漏结论、真实 Ark
采集、rawheap 转换、混合堆关联和其它快照段尚未验证，结果始终
`incomplete`、退出 3。命令注册不代表九类分析器或全部格式已可用。

## 离线 GC 摘要分析

```bash
ohmatecli analyze gc --log /path/to/capture.log --format json
```

读取显式公共 UTF-8 `.log`/`.txt`，当前仅支持 OpenHarmony 5.0.3 官方源码
和文档示例所声明的 ArkCompiler `[gc]` 单行摘要。保留准确 GC 类型、
LocalHeap/SharedHeap、打印的前后 used/committed MiB、总 GC 耗时与独立
并发标记耗时、已知触发原因，以及原始文件/行字节范围和 SHA-256。
SharedGC 未打印并发标记耗时，保持 null；打印数值已有舍入，不转换为
精确字节。未知类型/原因/摘要、非法数值、截断、BOM、无效 UTF-8、链接/
秘密名或超限返回 4，不发布部分报告。

单文件 16 MiB、100000 行、每行 16 KiB、10000 个摘要，报告最多 16 MiB。
超过 1 MiB 时回执保留摘要和哈希引用，`eventsLocation:report-artifact`
指向保存全部事件的私有报告。重复行保持独立，行顺序不证明采集时间或
同一进程/线程/VM；其它日志只统计未分析行数，不复制正文或关联详细段。
分配阈值和失败仅为单特征候选，不证明 OOM、泄漏或唯一根因。
频率、分配速率、详细段关联、运行时版本、设备/build 身份和实时采集
保持未验证，结果始终 `incomplete`、退出 3。官方示例不是本机设备采样。

## 离线 FD 快照与申请栈分析

```bash
ohmatecli analyze fdleak --log /path/to/capture.log --format json
```

读取显式公共 UTF-8 `.log`/`.txt`，支持 Huawei Reliability Technology Lab
FDLeak Skill 1.4 规格中的 `leaked fd nums`、句柄/目录 Top 10 和 FdTrack
申请栈子集。计数为非负安全整数；Top 合计可以小于快照，总量不足、重复
字段/名称、坏栈、空的已声明 Top/栈区段、UTF-8/BOM、链接、秘密名和超限
返回 4，不发布部分报告。缺少快照计数即拒绝，缺少 PID 不补造身份。

保留原文件及字段/行字节范围、SHA-256；进程、时间、路径和模块名仅哈希，
栈偏移保持原值，调用方向为从右向左。申请次数是十分钟内全部申请统计，
包含后来已关闭的 FD，不能与存量相加或单独证明泄漏。PID 相同只表示
日志声明一致；专项明细只记录区段存在，整机记录不归属到故障进程。
单文件/报告 16 MiB、100000 行/每行 16 KiB、各 Top 10 项、10000 栈/
每栈 32 帧、名称 1024 字节。报告超过 1 MiB 时回执使用
`stacksLocation:report-artifact`，完整栈保留在私有报告。

文本格式版本、真实 Producer/采集、设备/build、符号化、专项关联和泄漏
根因仍未验证，结果始终 `incomplete`、退出 3。技能规格例与预算 fixture
不证明设备实采；RESOURCE_OVERLIMIT 事件 JSON 不属于本子集。

## 离线 JS Crash 主栈分析

```bash
ohmatecli analyze jscrash --log /path/to/capture.log --format json
```

读取显式公共 UTF-8 `.log`/`.txt`，支持官方 JS Crash 规格中的已知
`Reason`/`Error name`、单行 `Error message` 和 JS `Stacktrace` 子集。
至少一种已知类型声明、异常消息和主栈缺失即返回 4；双类型必须一致。
未知类型、多行消息/源码片段、Native 主栈、截断/坏栈、重复/拼接日志、
不连续或混合帧编号、非法整数、BOM、无效 UTF-8、链接、秘密名和超限
均拒绝，不发布部分报告。缺少身份/版本字段明确列出，不补造。

单文件 16 MiB、100000 行/每行 16 KiB、主栈 256 帧、函数/位置 1024
字节、字段 4096 字节、报告 1 MiB。保留原始文件、字段/行范围和
SHA-256，消息、函数、路径和其他元数据值只保存哈希/字节数；字段值
去除行首尾空白，原始行哈希保留完整字节。JS 帧保留原顺序及声明行列号，
支持普通路径和四段 `module|dependency|version|path` 形式，不读取源码。
HybridStack、SubmitterStacktrace、AsyncStack、ModuleImportStack、HiLog
只记录区段存在与源行，不解析、关联或复制正文。

官方 `Fingerprint` 是故障聚类哈希，不是 buildId 或 SourceMap 构建指纹。
原始行列号、调试形式和日志内反解声明均不证明源码定位成功。错误码只
保留数值，未按 Kit 映射；符号/SourceMap、运行时、根因、应用归属、
快照关联和设备/build 身份未验证，单特征候选保留多个定界方向，结果
始终 `incomplete`、退出 3。官方规格例和预算 fixture 不证明实采，
公开旧样本缺少类型声明时也会拒绝。

## 离线 Native Crash 故障线程分析

```bash
ohmatecli analyze cppcrash --log /path/to/capture.log --format json
```

读取显式公共 UTF-8 `.log`/`.txt`，支持官方 `Reason:Signal:`、已知崩溃
信号/子码、`Fault thread info`、线程声明和连续 `#NN pc` Native 主栈。
未支持的信号/子码、缺失区段/线程/栈、JS 混合主栈、GWP-ASan、截断标记、
拼接/重复日志、非法整数/地址/帧后缀、续行 Fatal 消息、BOM、无效 UTF-8、
链接、秘密名和超限返回 4，不发布部分报告。旧 `Reason:SIGSEGV` 或缺少
故障线程区段的公开样本也会拒绝；不从文件名补造故障类型或线程身份。
官方 `UNKNOWN` 子码可保留为未知声明，不推测其数值或含义。

保留原文件、字段、区段、线程及帧的字节范围和 SHA-256；路径、函数、
线程名、Fatal 消息与其他元数据值只保存哈希。pc、地址、BuildID 与有符号
函数偏移保留原声明字符串，避免 64 位精度丢失。官方输出可能使用相对
或绝对 pc，不能把该列直接认证为相对偏移。函数/BuildID 不证明符号化或
产物匹配，`[Unknown]` 不补造路径。Registers、SubmitterStacktrace、
Other thread info、Memory near registers、FaultStack、Maps、OpenFiles、
HiLog 仅记录区段存在，不解析或关联正文。

单文件 16 MiB、100000 行/每行 16 KiB、256 帧、名称 1024 字节、字段
4096 字节、BuildID 至多 64 字节、报告 1 MiB。Fingerprint 是故障聚类
哈希；NULL/栈溢出的日志提示仅保留哈希。信号和 `.so` 路径不能认定根因
或责任；仅给多个定界方向。符号/压缩 DWARF、寄存器与检测器分析、
BuildID 关联、运行时、实采和设备/build 身份未验证，结果始终
`incomplete`、退出 3。官方格式例和重复帧预算 fixture 不证明设备实采。

## 离线 Freeze 事件与线程栈分析

```bash
ohmatecli analyze freeze --log /path/to/capture.log --format json
```

读取一个显式公共 UTF-8 `.log`/`.txt`。当前子集要求已知 `Reason`、
星号分隔的事件区段、`start time`、`EVENTNAME`、`TIMESTAMP`、
`PID`、`UID`、`MSG` 和连续编号线程栈；支持 `THREAD_BLOCK_6S`、
`APP_INPUT_BLOCK` 及 `BUSSINESS_THREAD_BLOCK_6S` /
`BUSINESS_THREAD_BLOCK_6S`。普通主线程日志可保留单次 3s 或 6s 抓栈，
两区段只接受 3s → 6s 或 3s → 输入超时。业务事件只接受单区段，
使用事件 TID；TID 或对应栈缺失时保留未知，不以 PID 主线程替代。
主线程事件 TID 与 PID 冲突、进程声明冲突、未知/旧事件格式、缺失必需
字段、重复或截断帧、非法数字、BOM/无效 UTF-8、链接/秘密名和超限返回
4，不发布部分报告。旧 `UI_BLOCK_6S` 公开日志仍不在支持范围。

保留原文件、字段、区段、线程、帧的字节范围和 SHA-256；进程名、线程名、
消息、时间、路径与函数仅保存哈希。混合 Native/JS 帧保留原顺序，pc、
BuildID 与有符号偏移保持字符串；JS 行列号和线程 state 仅是声明。
队列、Binder、CPU、内存、热等级、FFRT、内嵌采样/提交者栈和 HiLog
只记录区段存在，不把对端或采样帧混入目标栈，也不统计热点或关联符号。
不自动发现附件、工程或符号文件。

单文件 16 MiB、100000 行/每行 16 KiB，至多 2 个事件区段、每区段
64 线程/128 区段标记、每线程 256 帧、合计 512 帧，名称 1024 字节、
字段 4096 字节、BuildID 64 字节、报告 1 MiB。已知系统资源 NOTE
仅给候选；单栈、相同双栈、state 和 Fingerprint 均不能认定唯一根因。
系统因素、采样/符号关联、阻塞/繁忙、责任、运行时、实采和设备/build
身份尚未验证，结果始终 `incomplete`、退出 3，后台任务为 failed/degraded。

## 离线 API 错误码与 SDK 声明分析

```bash
ohmatecli analyze api --log /path/to/capture.log --format json
ohmatecli analyze api --log /path/to/capture.log --sdk-module @ohos.multimedia.media --format json
```

读取一个显式公共 UTF-8 `.log`/`.txt`，仅解析
`MM-DD HH:mm:ss.SSS PID TID E|F Cxxxxx/tag: message` 中单一显式
`error code:`、`code:` 或 `code=` 正整数。HTTP 状态、普通数字和低级别行
只计为上下文；不从 tag、域号或错误码前缀推断 API。多个错误码字段、
非法数字/时间/封套、混合 faultlog、截断、BOM/无效 UTF-8、链接、
秘密名或超限返回 4，不发布部分报告。保留原输入和事件行的范围/hash、
PID/TID/错误码与域声明；时间、tag、消息只保留哈希，不保存正文。

`--sdk-module` 可选；指定时通过 ToolProvider 读取当前工具链中对应
`@ohos.*.d.ts`，并核对 SDK 与 ETS 包的 API/平台/包版本一致。保留两份
元数据与声明文件原始哈希、匹配 BusinessError JSDoc 行范围和脱敏类别。
这是模块级声明候选，不认证具体调用、失败设备所用 SDK 或运行时。
未知描述保留 unclassified，无匹配码保持未知；显式 SDK 不可读、冲突或
超限时返回 4，不降级成已确认含义。未指定参数时不查询 SDK/知识库。

输入 16 MiB、100000 行/每行 16 KiB、1024 个事件、tag 1024 字节；
SDK 声明 4 MiB、元数据各 16 KiB、匹配声明 512 条、报告 1 MiB。
不自动采集设备、查找工程/附件/源码或验证状态时序。错误码只给多个
定界方向，根因、责任、API/状态关联、实采及设备/build 身份未确认；
结果始终 `incomplete`、退出 3，后台任务为 failed/degraded。

## 离线 Native 内存 sample 与 smaps 分析

```bash
ohmatecli analyze nativeleak --sample /path/to/sample.txt --format json
ohmatecli analyze nativeleak --sample /path/to/sample.txt --smaps /path/to/smaps.txt --format json
```

读取显式公共 UTF-8 `.log`/`.txt`，支持 OpenHarmony 5.0.3 原始
sample 的 pid/processName/threshold/actualRss/TopPssMemory 与
`time(s) PssMemory(KB) realtime` 表；该 Producer 将 RSS 和 PSS+SwapPss
写入同一向量且会裁剪记录，表内没有逐行指标标记。因此保留全部行，
不按位置认定 RSS/PSS。起止/峰值/差值/百分比及方向仅描述混合数值序列，
不代表纯 PSS 增长；起点为零时百分比未知，不推断速率或线性增长。
保留原始字段/行范围和哈希、声明的单调秒数；进程名与 realtime 仅哈希。

可选 `--smaps` 只支持该版 hidumper 的两行表头、十个数值列、名称及
Summary 汇总表。名称按精确已知标签分类，其余保持 unclassified，
正文仅保留哈希；各行 PSS 与 SwapPss 分开求和，Summary 的 Pss 列已
包含 SwapPss，校验时不再重复相加。占比的分母来自此表的汇总，不使用
sample 的数值替代；两份输入不建立进程、时间或设备关联。

每文件 16 MiB、合计 32 MiB、100000 行/每行 16 KiB；sample 与
smaps 各至多 1024 行记录、名称 1024 字节、报告 1 MiB。未知格式、
重复字段/表/名称、缺列/汇总、不安全整数/溢出、时间倒退、截断、
BOM/坏 UTF-8、链接、秘密名或超限返回 4，不发布部分报告。
不按文件名发现附件、不读取 pickle 或执行采集脚本。DMA/GPU 未采集；
htrace/NMD/native hook、分配释放生命周期、符号及跨文件关联未分析。
内存占用与增长只给多个排查方向，根因、泄漏、责任和实采/device/build
保持未确认；结果 `incomplete`、退出 3，后台任务为 failed/degraded。

## 离线 UI 事件分析与自动分诊

```bash
ohmatecli analyze ui --log /path/to/events.txt --format json
ohmatecli analyze auto --log /path/to/events.txt --format json
```

UI 只解析 OpenHarmony 5.0.3 Ace 的窗口 focus/unfocus/foreground/
background/destroy 通知、上下文 currentId/trackedId/reason 与 instanceId。
支持 release 前缀及 `ui_content_impl.cpp` debug 前缀；PID/TID、上下文和
源行号仅声明，名称/时间仅哈希。原因按 Producer 的六个枚举校验，
文档示例中的 `scoped` 不受支持，源码实际打印 `scope`。
currentId 位于 `[100000,1000000)` 只给单项特征候选和多个排查方向，
不从 destroy 通知、相同 ID 或文件顺序认定失效上下文、窗口状态、因果、
布局或实际渲染。输入 16 MiB、100000 行/每行 16 KiB、1024 事件、
名称 1024 字节、报告 1 MiB；未知/截断/坏数值/UTF-8/BOM/链接/
秘密名/超限拒绝且不发布部分结果。

auto 仅对显式公共 UTF-8 `.log`/`.txt` 分诊 UI、GC、API、JS/Cpp Crash、
Freeze、FD 与 Native sample 标记。唯一候选使用已有解析器验证，多候选
保留列表且 `selection=null`，由用户明确选择分析域；标记不证明格式有效、
实采或跨域关联。解析器拒绝后返回 4，不改选其他域。分诊与派生报告
的原始字节哈希必须一致；中间派生文件属于私有临时目录并在结束后清理，
最终只发布一份 auto 报告。输入沿用 16 MiB/100000 行/16 KiB 行预算，
每域至多 32 个原始行引用并保留标记总数，所选报告 16 MiB、最终 17 MiB。
超过 768 KiB 的报告回执仅提供摘要与哈希引用，完整内容在报告中。
不发现快照、SDK、附件、设备或工程，不执行采集；根因、runtime/
capture/device/build 未确认。两入口结果 `incomplete`、退出 3，
后台任务为 failed/degraded；多域列表是分诊结果，不是联合故障结论。

## 依赖分析与 SBOM

```bash
ohmatecli deps analyze --project /path/to/app --format json
ohmatecli deps why --name @example/library --project /path/to/app --format json
ohmatecli deps audit --project /path/to/app --format json
ohmatecli deps sbom --standard cyclonedx --project /path/to/app --format json
ohmatecli deps sbom --standard spdx --project /path/to/app --format json
```

四个命令均只读、不安装、不查询 registry，不需要模型、工具链或设备。
建立 OHPM、npm 和 Native 组件与关系图，提供输入文件 SHA-256、声明范围、
锁定版本、依赖 scope、模块循环、重复版本、字面量导入候选和 Native 桥。
OHPM 使用已核实的 v3 `specifiers/packages` 契约；根锁明确启用统一锁时才
供模块使用。npm 支持 v2/v3 `packages`、workspace 链接和嵌套包解析，
不会把未登记子项目视为已锁定 workspace。声明漂移单独报告，保留锁版本。
本地模块和 npm workspace 也保留 `declaredVersion` 与 `versionSource`；
源码清单版本变化不会覆盖已锁版本，多个锁上下文冲突会明确降级。

Native 当前解析字面量 CMake target 和链接；变量、include、子目录和
configure-time 发现明确降级，不执行 CMake。导入分析是轻量候选，不替代
编译器；动态加载、资源和构建使用尚未全部排除，`unused:not-evaluated`。
显式引用的普通 GNU/BSD `.a` 记录成员顺序、原始字节范围、SHA-256 和
ELF 声明；最多 256 个成员、64 KiB GNU 名称表、256 字节成员名。
符号/名称表仅记录范围和哈希，不校验表内引用。重复成员名保留独立范围，
不生成成员依赖或推测链接选择。thin 归档不读取外部成员，未知格式、
非可重定位 ELF、无已知 machine、坏范围和超限均保持不完整。
成员声明不认证 ABI 兼容或产物归属，两种 SBOM 保留相同成员元数据，
库的标准 checksum 始终使用整个库的原始字节。
漏洞、许可证实物和 ABI 验证标为 `not-run`，不把锁元数据作为验证通过。
缺锁、未知格式、重复键、越界、私有/链接/敏感文件和读取预算超限均给出
`incomplete` 与退出码 3。已知问题返回 1，完整的已支持输入无问题返回 0。

`sbom` 在回执 `data.document` 输出 CycloneDX 1.6 或 SPDX 2.3，跨生态
关系同时保存在 `data.relationships`；缺失版本和许可证不填猜测值。
扫描忽略依赖安装目录、构建产物、隐藏目录和产品状态；上限为 10,000
目录条目、2,000 文件、单文件 8 MiB、总原始字节 32 MiB。输出仅证明此范围内
的依赖清单，不能证明整个 Release 包的洁净性。

## 构建与测试编排

```bash
ohmatecli build plan --modules entry@default --project /path/to/app --format json
ohmatecli build --modules entry@default --project /path/to/app --format json
ohmatecli build run --modules entry@default --project /path/to/app --format json
ohmatecli test plan --kind local --files entry/src/test/Acceptance.test.ets --project /path/to/app --format json
ohmatecli test local --files entry/src/test/Acceptance.test.ets --no-coverage --project /path/to/app --format json
ohmatecli test local --modules entry --build-only --no-coverage --project /path/to/app --format json
ohmatecli test instrument --modules entry --project /path/to/app --format json
```

`build plan` 与 `test plan` 只读；普通构建和两种测试先给 R2 计划。
默认 `build` 与 `build run` 共享原生 Runtime、任务和产物回执。默认入口保留原有
参数和 `{argv:[...]}` 调用，配置变化时先安装 OHPM 依赖；`build run` 仅在显式
`--install` 时安装。显式 `--signing-config`（含等号写法）和可解析到声明配置的隐式
签名选择需 R3 审批。模板中没有对应配置的引用标为 `unresolved`。临时覆盖仅改写产品的配置名，计划和恢复记录不保存
签名材料；成功、失败或取消后核验逐字节恢复，后续改动或不安全文件阻止覆盖。
构建验证声明的
product、module、target、buildMode 和模块类型，按 HAP/HAR/HSP 分开调用
已有 HvigorAdapter；默认入口保留显式 assemble 覆盖的警告并交由官方工具执行。
官方任务目录
与当前插件的延迟任务定义共同提供后端依据，源码和可执行文件分别记录哈希。
不调用 Commander action，不改进程 cwd，不混入全局 HOME 或凭据。

官方 Hvigor 首次启动可能自动下载其包管理器；计划明确记录工具链启动和工程
脚本的网络风险，当前不能承诺隔离网络的离线构建。执行使用私有 HOME 和
已观察到的 `--no-daemon`；取消等待工具退出。记录 argv、cwd、原始输出、
真实退出码、工具与 SDK 元数据、源码/配置/锁文件、依赖快照和产物 SHA-256。
原始输出保留 UTF-8 哈希；阻断/截断、显式警告和提示分别标 P0/P1/P2。
安装/同步后的锁文件和依赖重新取证；旧产物、缺失模块产物或源码漂移返回证据不完整。
遗留 quickfix `build/config/buildConfig.json` 的删除先展示实际 Diff 与哈希，
执行后保存不可覆盖的原字节与恢复记录。清理中断或签名恢复冲突仍保留恢复入口：

```bash
ohmatecli build signing inspect --journal-id <id> --project /path/to/app --format json
ohmatecli build signing restore --journal-id <id> --project /path/to/app --format json
ohmatecli build cache inspect --journal-id <id> --project /path/to/app --format json
ohmatecli build cache restore --journal-id <id> --project /path/to/app --format json
```

恢复需独立审批，签名恢复为 R3、缓存恢复为 R2；存在后续编辑时拒绝恢复。
文件事务先移位并核验原字节，以排他创建提交新内容；冲突时保留当前文件和
持有的原文件，恢复核验成功后才清理。持有路径仅作为本地恢复元数据记录。
缓存恢复先准备完整字节和权限再提交；中断留下的权限差异或待清理原件可重新
审批恢复。多次冲突的持有路径持续登记，全部原件核验后才清理。
构建 provenance 保存 SDK 前端、ArkGuard 包、loader 桥接脚本与默认 es2abc
候选的实际哈希；es2abc 发行版本未知，候选不代表实际执行路径。组件漂移会
使审批过期，构建中的新增或变化另记 `compilerDrift`。默认目录下实际生成的
loader 保存哈希、新旧状态及明确的 worker、字节码 HAR/SourceMap 等输入；
这是构建后声明记录，完整最终配置和传递读取闭包仍未验证。缺失或
敏感输入返回降级且保留官方结果。全部 loader 的声明按单次采集累计
4096 项/64 MiB，读取前检查文件类型和剩余预算，FIFO 等非普通文件拒绝。
根目录及声明模块的 `oh_modules` 另存编译前安装清单，包含隐藏存储与范围内
OHPM 链接目标的字节哈希。审批绑定这份清单；编译期间的新增、删除、变化
记入 `installedInputDrift`，不可读、敏感、越界链接和超预算输入返回降级，
保留官方退出与产物。清单最多 10000 项、单文件 8 MiB、合计 64 MiB；
`binding:inventory-only` 不代表实际编译读取闭包、最终配置或缓存认证。
私有 Hvigor 构建进程及 worker 另存 `compilerObservation`：实际 `job.run`
配置的允许字段、SDK Host 调用、模块解析及同步/异步读取字节哈希。配置中的
loader 路径可补充自定义目录；仍是 `observed-partial`，不代替完整配置。
`configurationStages` 分别记录 SDK 默认合并后的输入、SDK 补充后的值、
实际 Rollup 输入和 Ark 派生返回；`configurationIndex` 关联原始调用配置。
只保存允许的标量数据属性，不执行 getter 或复制嵌套配置；原函数失败不补造
输出阶段。每次调用最多 64 阶段/256 KiB，并共享总配额；缺口不认证完整配置、
Watch、缓存或 `buildId`。
`textReads` 单列 Host 返回文本和 ScriptSnapshot 的 UTF-8 哈希，不覆盖原始
文件字节，也不用于判断源码漂移。Watch Host 在实际使用前重新包装，保留
SDK 后置替换的方法。BOM 解码、源码预处理、仅缓存返回和已解码的文件读取
明确区分；缺少原始读取时保持缺口，不补读文件冒充实际编译输入。
`fs.readFile` 和 `fs.promises.readFile` 按发起时的构建调用归属保存结果，
原始 Buffer 在交给调用者前取哈希，文件的 `readMethods` 记录实际入口。
带编码的返回仅记为解码文本；相对路径和文件 URL 在发起时解析。
关闭时仍未完成的读取留下缺口，迟到结果不能归入下一次构建。
观察到的 `fs.promises.open` 句柄可记录 `FileHandle.readFile` 和
`fs.promises.readFile(handle)`；打开时解析路径，读取前后核对句柄与路径的
device/inode/size/mtime/ctime，只有完整 Buffer 返回才计入文件哈希。
当前位置产生的部分返回拒绝作为整文件，带编码的结果仍只计文本；路径替换、
未知 Promise 句柄来源、原始失败及关闭后的晚返回保留缺口，不补读文件。
观察前已创建句柄的直接方法、不可包装方法及其它 descriptor 操作仍未覆盖。
`fs.createReadStream` 和已观察句柄的 `FileHandle.createReadStream` 可记录
完整流的原始字节哈希。观察既有入队和事件分发，不新增 `data`/`readable`
消费者；编码流在解码前增量取哈希，消费到原始 EOF/end 后才记录文件。
读取前及入队/结束时核对 fd/path 身份；局部范围、当前位置部分读取、
人工 EOF/chunk、取消、超额、路径替换和中途写入保持缺口。
已观察 FileHandle 作为 fd 时按打开来源归属，忽略原 path；数字 fd、
自定义或 getter I/O、不可包装流和晚消费不推断原始字节来源。
原始背压、错误、autoClose 和 emitClose 语义保持，完整文件系统闭包仍未认证。
`nativeCalls` 记录 SDK `ModuleMode` 的 es2abc shell 调用边界：分发前的允许
配置、命令哈希/字节数/参数数、声明的文件清单/缓存/编译上下文/输出路径，
以及匹配 `exec` 返回的 PID 和关闭事件。每调用最多 64 条/256 KiB，
命令最多 256 参数/64 KiB，共享总配额；不保存命令正文或 native 输出。
原 SDK/ChildProcess 的返回、异常与事件分发保持；命令不匹配、重复分发、
getter、危险路径、不可包装和关闭时未完成均留下缺口。
关闭立即封存，晚到事件不修复证据或进入下一调用。
`binding:sdk-call-reference-only` 不认证 shell 实际执行文件、native 输入字节、
缓存来源或最终配置；编译后描述文件哈希也只证明编译后字节。
`nativeDescriptions` 观察四个 SDK 生成方法内的同步写调用，保留写入前的
UTF-8/Buffer 字节数与哈希、写入/方法结果、对象身份和顺序。
`nativeCalls.descriptionSequences` 只关联同 job、同对象、同声明路径的
最近一次单写成功生成。重复写入、失败、未知编码、getter、不可包装和
跨 job 对象保持缺口；关闭后不补记。每 job 最多 64 条/256 KiB 元数据，
单份 8 MiB、累计 16 MiB 输入指纹计入共享预算，不保存正文或另读文件。
`sdk-write-call-only` 不证明写入持久化、分发时文件字节或 native 实际读取。
`nativeInputWrites` 记录 SDK 两个源码生成入口的源文件参数（或 AST 自有
fileName）、目标路径、写入前 UTF-8/Buffer 哈希与大小、生成身份、写入及方法
结果和共享顺序。原 Promise 身份、返回值和异常保持；每 job 最多 512 次尝试/
写入、512 KiB 元数据，单份 8 MiB、累计 16 MiB，计入共享配额。
描述的 `inputReferences` 保留 module/bytecode/cache-pair 路径声明，其余字段
只存哈希；每份最多 512 行、累计 256 KiB 引用元数据。来源序号只关联描述写入
之前已完成的最近一次同 job、单写成功目标。重复、失败、无写入重试、较早
Promise 晚完成、危险路径及未知表示均不恢复旧绑定；关闭后不补记。
bytecode 行及 cache 输出只作为声明。`sdk-source-write-call-only` 不认证
磁盘持久化、后续文件字节、缓存读写或 native 实际读取；不保存正文或另读文件。
cache-pair 的 `sourceDescriptionSequence` 仅关联同 job、同对象、同输入路径
最近一次已完成的单写成功 npm-entries 描述；它与 `sourceWriteSequence`
互斥。重复、失败、无写入重试、嵌套晚完成或后续目标替换不恢复旧关联，
未知编码和超预算写入也使目标失效；无法观察来源参数或目标属性的尝试
撤销旧描述目标绑定。原 npm 描述指纹仍为
`sdk-write-call-only`，proto 输出只保留声明，不证明缓存命中或 native 读取。
SDK 的 Watch 入口及 Rollup-lite Task 为 setup、每次 `run`/`hotCompile` 和
`close` 分别记录观察；`watchRounds` 以 session/round 和原配置索引关联，
保存实际事件、变化文件及 `rollup-reported` 复用清单。关闭立即截断该轮
未完成读取；重复、缺轮、关闭后新轮和敏感路径拒绝，观察日志最多 64 个。
保留原 Promise、返回、异常及事件分发；不可包装的导出保留执行与缺口。
Task.close 返回与外层进程关闭分别验证。上报的复用清单仍为
`watch-cache-reuse-unverified`，不证明 ArkTS 完整 Watch 或内存/文件缓存闭包。
Host 的不存在探测在编译后重查新增；已读输入变化、不可读或未关闭观察
返回降级。运行时缓存/输出读取单列，`.tsbuildinfo` 与 `.tsbuildinfo.linter`
保留读取及后续哈希为 `cache-unverified`，不作为源码漂移或缓存认证。
全部观察共享 10000 项/64 MiB 输入和 16 MiB 记录预算，最多 64 个文件；
未覆盖的句柄/流读取、原生解析器、内部闭包调用和未捕获的 Host 仍明确缺失。
`outputLayout` 单列 Hvigor 实际返回的模块 target 和 product 输出目录，任务
枚举后、编译前取产物基线，结束后重查哈希。同步方法返回时立即记录，
不依赖工作进程的 `exit` 回调，也不将方法完成当作进程退出。
自定义输出目录中的直接新产物可收集；不递归 product 的符号子目录，也不把
未观察到的子目录 APP 归属于输出根。产物及其路径上的链接仍拒绝，
硬链接产物不作为证据。
无前置目录基线标为 `baseline-unavailable`，未变化产物为 `reused-unverified`。
其它 target、歧义目录、越界、敏感路径、符号链接及未关闭观察均不能证明
目标产物完整。观察最多 64 文件、128 路径、4 MiB 记录；目录扫描限 10000 项。
`observed-partial` 仅证明观察到路径，完整输出布局仍缺失，不认证缓存或 buildId。
provenance 仍为 `incomplete`、
`buildId:null`，不能用于自动符号化或重放。

普通 `run` 在安装前通过私有、无 daemon 的官方 `tasks` 查询输出目录和 HAP/HSP
元数据文件的实际路径；`--skip-build` 也执行此查询，但不执行 assemble。
元数据与输出目录分别按 module、target、product 匹配，不从产物目录反推。
查询会加载工程构建脚本，因此仍需可信工程和既有 `run` 审批。
缺失、歧义或危险路径会阻止安装，不回退到默认目录的旧包。路径查询、原始
工具退出和产物哈希保存为私有 `run-artifact-paths` 证据，build 身份保持未认证。

文件级测试从所选模块 `test`/`src/test` 或 `ohosTest` 路径解析字面量
`describe`/`it`；注释、字符串和正则中的文字不作为套件。动态和歧义名称拒绝
自动推断；重复套件名、无测试模块和不存在的范围在运行前拒绝。各模块独立调用
实际范围，核对全部所选方法。结果区分 `executed`、`build-only`、`not-run`、
`failed` 和 `cancelled`。旧报告、缺失方法、未知格式、统计不一致、额外用例或
源码漂移不算通过。支持当前 DevEco 26 的 `class/test/result` 和总计行，也保留
显式 `[pass] Suite#method` / `[fail] Suite#method`。原始报告保存为不可覆盖证据。
Local Test 的 `--build-only` 调用官方 `UnitTestBuild`，返回 3，不能视为用例通过。
Instrument Test 缺少已核验的设备选择接口时返回 `not-run`，不自动选设备。
覆盖率、ASan、Cloud 与 Native ABI 尚未完成验证。

macOS 实际审批创建、安装 Hypium、unsigned HAP、两条 Local Test、仅构建、
单方法 HTTP 测试和后台构建已通过；故意失败的用例返回 1。原始报告与产物哈希在
`artifacts/validation/m1-quality-local-sample-r1/`。更早的失败证据仍保留。

## Release 证据校验

```bash
ohmatecli build run --build-mode release --project /path/to/app --format json
ohmatecli release verify --manifest /path/to/private/build-provenance.json --project /path/to/app --format json
ohmatecli release guide --manifest /path/to/private/build-provenance.json --project /path/to/app --lang zh-CN --format json
ohmatecli release artifacts --manifest /path/to/private/build-provenance.json \
  --symbols build/sourceMaps.map build/nameCache.json build/libexample.so --project /path/to/app --format json
```

三个命令均由 CLI/Web/Agent 的同一 Registry 执行。`verify` 输出设计合同的
14 项门禁，每项包含范围、来源哈希、发现和缺失证据。构建 manifest 记录
product、module@target 和 buildMode；包和源码须与其哈希一致。缺 manifest
时仍可检查显式 `--artifacts`，但无法认证构建身份。未知产品/模块、产物错配、
私有文件、链接、坏 ZIP/ELF 和越界输入返回 4。

检查显式生产依赖、源级调试 API/敏感日志候选、ArkGuard 声明、HAP 实际
`app.debug`/`buildMode`、SourceMap/证书文件名和本机路径。证书 payload
不解码。Native ELF 从有界节区读取架构、GNU BuildID、调试节和静态符号，
校验 ABI 目录，保留动态符号表；这不证明全部 Native ABI 或符号关联已完成。
ZIP 不解压到工程；限制 10,000 条目、单条 32 MiB、总解码 64 MiB、
嵌套深度 3，输入文件最多 128 MiB。

存在发现返回 1；没有发现但缺 Producer 证据返回 3。权限使用、编译后可达
调试入口、混淆合并、云产物、生产 SBOM 和完整符号关联保持 `incomplete`，
因此当前报告不能表示已具备发布资格。`guide` 生成双语人工步骤，不登录、
签名或上传。`artifacts` 将原 manifest、包与显式符号逐字节复制到私有
证据目录，使用不可覆盖文件和来源映射；源码输入只记录哈希，归档闭包仍不完整。

## 受控代码 Patch

`workspace patch` 的输入为 `changes` 数组，每项包含精确相对路径 `path`、
原文件 SHA-256 `oldHash` 和新文本 `text`。新建文件使用 `oldHash:null`，
删除文件使用 `text:null`。先返回 R2 计划、逐文件哈希和统一 Diff，确认同一
输入后再执行；最多 20 个文件，单文件 128 KiB，输入 256 KiB，父目录须已存在。

```bash
ohmatecli workspace patch --input '{"changes":[{"path":"src/new.ts","oldHash":null,"text":"export const value = 1;\n"}]}' \
  --project /path/to/app --format json
ohmatecli task submit workspace.patch --payload '<same-json>' --wait --project /path/to/app
ohmatecli task approve <taskId> <planId> --wait
ohmatecli workspace recovery inspect --journal-id <journalId> --project /path/to/app
ohmatecli workspace recovery restore --journal-id <journalId> --project /path/to/app
```

`restore` 也先给独立 Diff 和审批计划；后续编辑与记录哈希不匹配时拒绝恢复。
拒绝越界、敏感文件、产品私有状态、符号链接、硬链接、二进制和重复目标。
每个文件采用原子写入，后续失败或协作取消时撤回本次已经完成的写入；冲突
导致无法撤回时返回 `PATCH_RECOVERY_REQUIRED`，保存恢复状态和不可覆盖的证据快照。
回执哈希对应证据文件实际字节，后续恢复不会修改先前的证据快照。

OHMate 的锁只协调本产品内的写操作。Node 文件 API 不提供多文件事务，也不
保证最终哈希检查到系统调用之间不发生外部编辑竞态；需要这种隔离的环境应在
独立 checkout 中执行。进程硬中断后仅提供显式恢复检查，不自动重放 Patch。

## 会话、模型与终端

本机 TRAE CLI 可直接作为模型提供方，不需要 API 地址或复制账号凭据：

```bash
ohmatecli model trae-cli
ohmatecli model trae-cli --executable /absolute/path/to/trae-cli
ohmatecli model list
ohmatecli model select <配置ID>
ohmatecli model check <配置ID>
```

先在本机 TRAE CLI 完成登录。发现只读取 `models --json`，不自动选择模型或发送
提示词。Web“模型连接 → 发现 TRAE CLI 模型”使用相同入口。模型请求通过独立
`app-server --stdio` 进程和临时会话执行；仅传入经批准的上下文，关闭宿主工具、
MCP、环境与 Skill 能力。工具调用交回 OHMate Runtime 校验和执行，写操作仍需
人工审批。请求结束或取消后等待进程退出，再删除临时目录。
本机 TRAE CLI 0.211.1 的 Seed-2.1-Turbo 已验证文本流、工具往返和续聊；
其他模型、CLI 版本和平台需分别检查，不将模型列表视为调用能力证明。

TRAE 本地模型桥扩展位于 [extensions/trae-model-bridge](../extensions/trae-model-bridge/README.md)。
本地打包使用 `npm run build:trae-bridge`；用户安装并启动扩展后，从私有终端设置
临时密钥变量，再运行 `ohmatecli model trae --endpoint http://127.0.0.1:<端口>/v1`。
发现不自动选择；Web“模型连接 → 发现 TRAE 模型桥”复用同一入口。
仅能使用宿主公开 API 开放的模型，每次请求需在 TRAE 中确认。实际宿主模型调用
尚未验证，不宣称支持全部内置模型。详见 [桥接合同](trae-model-bridge.md)。

交互终端中直接运行 `ohc`（或 `ohmatecli`、`ohmatecli agent chat`）；`ohc` 是
短别名，无 TTY 时无参数显示帮助。`/execute <toolId> <JSON>` 使用同一 Runtime，`/files`、`/tools`、
`/write`、`/model`、`/session` 选择读取文件、允许提出修改的路径与会话，
`/models` 列出配置，`/trae [可执行文件完整路径]` 发现 TRAE CLI 模型，
`/approve <taskId> [planId]` 批准并执行待审批计划，随后发送新消息继续该会话，
`/help` 列出命令。Tab 补全控制台命令和 `/execute` 的工具 ID，上下键浏览本次
会话历史；空闲时第一次 Ctrl+C 提示、第二次退出（130）。确定性操作不要求模型。

应用对话使用 `ohmatecli --project /path/to/app`；Web 先选择已登记应用。
工具源码仓库的根规则可能超过默认 64 KiB 发送预算，不能代替目标应用上下文。
续聊仅把与当前材料路径、来源、原文和哈希完全一致的历史副本替换为
`current-material` 引用；旧版本内容、工具结果与原始会话记录保留。

```bash
ohmatecli model list --format json
ohmatecli model add example --api openai-completions --model <model-id> \
  --endpoint https://provider.example/v1 --credential-env OHMATE_MODEL_KEY
ohmatecli model select example
ohmatecli model check example --format json
ohmatecli context preview --prompt "检查代码" --files src/main.ts \
  --allowed-tools workspace.read --project /path/to/app --format json
ohmatecli agent run "检查代码" --files src/main.ts --allowed-tools workspace.read \
  --preview-hash <reviewed-hash> --project /path/to/app --format json
ohmatecli session list --format json
ohmatecli session show <id> --format json
ohmatecli session resume <id> --format json
ohmatecli session export <id> --format json
ohmatecli rules check --files src/main.ts --project /path/to/app --format json
ohmatecli memory add "保持公开接口兼容" --project /path/to/app
ohmatecli extensions list --format json
```

模型默认关闭。配置保存环境变量名称，密钥只在显式模型调用时解析，不写入
配置或回执。`model.check` 发送小型连通性探测；工具、多模态和推理能力尚未
验证时明确标为 unverified。pi SDK 使用维护中的 `@earendil-works` 1.4.0。
已验证本地 OpenAI-compatible SSE 协议；Anthropic/Gemini 适配代码尚未完成
真实云端认证，不按模型名称推测能力或自动切换 provider。

Agent 请求先审查 `context preview`，发送时绑定哈希。文件变化、模型变化或
历史变化会使授权失效。仅选定的公开文本、适用项目规则、人工记忆与会话关联
证据进入上下文；越界、私有数据、敏感文件、二进制与预算溢出会被拒绝。
模型工具输出也视为不可信数据。对话不能授予审批或配置管理权限；R2/R3 工具
产生独立待审批任务。人工审批后，新请求将实际回执纳入预览。
`context preview` 和 `agent run` 的 `--write-paths` 列出允许提出 Patch 的精确
路径，并绑定旧内容哈希；默认没有写入范围。引用文件不会自动获得写入权限。
Agent 可以调用 `workspace.patch` 提案，不能调用恢复或审批工具；人工执行后
重新选择所需读取文件并预览，才可在下一轮核验真实结果。

`agent.run` 可通过 `task submit` 前台或后台执行；会话独立于终端和 Web。
恢复付费模型请求需要新的显式提交，不自动重放中断请求。轮数、工具调用、
输出 token、每轮输入与超时有限；当前输入以 UTF-8 字节作为保守 token 上界，
费用未知时返回 null。产品事件展示生命周期及完整脱敏内容块，不输出未审查
的逐 token 文本。可执行扩展尚未认证，`extensions enable` 返回 blocked。

## 本地 Web 工作台

```bash
ohc --web
ohc --web --no-open --format json
ohmatecli ui
ohmatecli ui --no-open --format json
ohmatecli ui status --format json
ohmatecli ui stop --format json
ohmatecli debug start --format json
ohmatecli debug status --format json
ohmatecli debug list --format json
ohmatecli debug protocol --format json
ohmatecli debug pair --buildId peer-build --device peer-device --process peer-process --sessionId peer-session
ohmatecli debug pair --buildId peer-build --device peer-device --process peer-process --sessionId peer-session --hdc-device <connected-serial>
ohmatecli debug show <session-id> --format json
ohmatecli debug streams <session-id> --limit 20 --format json
ohmatecli debug events <session-id> --stream <stream-id> --after 0 --limit 100 --format json
ohmatecli debug inspectors --format json
ohmatecli debug inspect <session-id> --stream <stream-id> --channel hidebug --limit 100 --format json
ohmatecli debug stop --format json
ohmatecli project register /absolute/app --format json
ohmatecli project list --format json
ohmatecli ui layout --help
```

`ui` 无子命令打开工作台，`ui layout/find/wait` 等仍保留设备语义。原底座
`ui` 父节点通过 `execute deveco.ui` 保留。HTTP 服务默认绑定 127.0.0.1 随机端口，
后台 worker 独立运行；关闭网页保留任务。启动根目录变化时须停止现有工作台
再启动，网页中切换已登记应用会冻结每个任务的真实工程上下文。

页面含四项导航、六种任务意图、真实命令、持久任务、计划审批/取消/恢复、回执
导出、模型元数据、上下文预览、规则与人工记忆。默认无模型；自然语言生成
需要显式选择模型并确认发送范围。设备状态在用户主动检测前显示“未检测”。
当前不提供伪造性能数据、概念 HAP、MCP Client 或已完成应用生成的承诺。

浏览器链接带一次性片段（60 秒有效），交换为 HttpOnly/SameSite Cookie 后立即
清除地址片段。修改请求校验 Origin、Host 与 CSRF；无 CORS、第三方脚本、字体
或分析服务。服务控制能力只保存在私有 0600 文件，不进入状态回执与任务事件。
协议和生命周期工具由终端专用入口执行，不作为通用后台任务。

`debug start` 无浏览器启动同一服务，`devtools serve` 为兼容别名；它们与 `ui`
复用进程及持久 DebugSession。`debug status/list/show` 与已鉴权的
`GET /api/v1/debug/status`、`GET /api/v1/debug/sessions` 查询同源记录。
停止后保留会话，重新启动生成新 ID。初始状态为 `waiting-pairing`，target 为 null；
当前只提供 loopback WebSocket，未验证真实 Kit/HDC 和构建身份。
`debug protocol` 与 `GET /api/v1/debug/protocol` 提供 1.1/1.0 只读协议 Schema
和通道哈希；共享 Runtime 导出纯握手与接收状态机。已实现连续 ack、重复/冲突、
窗口内重连、显式 gap 和时钟分段。配对使用短期 256-bit 一次性邀请和双向
challenge，事件帧使用 P-256/HKDF-SHA256/AES-GCM；仅落盘后确认。
同一命令的 `writes` 字段提供七项写 scope、命令/回执 Schema 和风险；
当前均为 `available:false / DEVICE_BUILD_UNVERIFIED`，不会启用远程写。
Runtime 的 `WriteSession` 仅管理应用本地逐命令确认、幂等回执、TTL 与撤销：
临时操作先登记回滚，清理失败保留恢复责任；原生任务未返回时不宣称已完成。
查询、复核、确认、执行（含重复）及完成均观察时钟；回拨或非安全整数
永久撤销当前会话，不污染最后有效读数。查询在定时器交付前检查命令与
十分钟会话到期；重复命令保留回执，轮询不重试失败清理，恢复须显式撤销重试。
此 API 不认证设备或 build，也不保证 Console 脚本可被抢占。
`mock validate --input-file request.json` 校验 `{rules}`；
`mock plan --input-file request.json` 对 `{rules,samples}` 做离线命中预览。
规则只匹配精确 target/origin/method/path/header/resourceType，优先级相同
时按输入顺序。最多32条、256 KiB，固定正文每条最多64 KiB，延迟最多3秒。
当前支持固定响应、确定性文本模板、延迟、超时和网络错误；文件、分块和流式未实现。
模板响应使用 `{kind:"template",status,headers,template,variables,delayMs}`，
仅展开 `{{test.name}}` 和显式字符串变量；不读取请求、环境或文件，不执行代码。
模板最多16 KiB、16变量/每值2 KiB、64处引用，正文64 KiB/整表展开256 KiB。
变量必须全部使用，缺失、非法语法和无效UTF-8拒绝；HEAD展开结果必须为空。
dry-run只返回响应与渲染正文hash，模板正文和变量不进入回执。
敏感路径及认证、支付、上传、删除、未知分类请求不可 Mock，仅开放
GET/HEAD/OPTIONS。输入 header 仅允许 accept/content-type/x-ohmate-scenario；
响应仅允许 content-type/content-language/cache-control/x-ohmate-scenario。
输出只含哈希、数量和命中标识；采样只代表用户提供的请求，不能证明设备流量。
Runtime 的 `NetworkMockTable` 只管理内存规则，执行前校验完整 payload/plan
哈希与原规则版本；撤销恢复原状态，冲突保留责任，旧 AbortSignal 和期限
不会因恢复而重新激活。此表不执行 HTTP；示例ArkTS Adapter已接入应用内
独立确认及固定模板场景，平台HTTP/Phone行为仍未验证。
示例 NetworkMock 和 WebResourceOverride 观察到时钟回拨或非安全整数时，
同一 owner 永久失效；取消、时钟追平与重新 review 均不能复活授权。
正常时钟下取消或到期仍可重新 review，且必须独立确认。
`mock apply/revoke` 当前返回 `DEVICE_BUILD_UNVERIFIED`；`mock status` 的
active/hits 为 null。五项 Mock 工具均使用专用终端入口，不进入 Agent 或
持久后台任务，避免原始正文落盘。桌面审批不能开启应用写能力。
示例应用的 Web 资源覆盖支持独立的宿主打包文件清单与
`WebSchemeHandler` 分块响应。仅限 `ohmate-resources/` 的 css/txt、
64 KiB/项和256 KiB总量；读取核对原始字节hash并关闭descriptor后注册。
专用Web实例显式授予handler所有权，应用单独复核/确认；取消阻止后续
分块，native请求停止前保留buffer与清理责任。失败关闭仅显式停止重试。
这不扩展 `mock` 的文件/流格式或远程写权限；真实ArkWeb、请求身份与
device/build仍未验证，响应正文不进入事件或ZIP。
`debug pair` 要求交互终端的输入和输出均为 TTY，且使用 human 格式；JSON、
管道输出与 `--non-interactive` 均拒绝生成邀请。邀请只写入终端，不进入普通
回执或日志；输出失败会尝试撤销。目标参数由对端声明，不认证设备或构建。
可选 `--hdc-device` 要求连接列表中的精确 serial；后台服务创建设备端口到
桌面同端口的 `rport`，记录目标哈希与未认证的传输状态。既有映射不被接管，
过期、断连、撤销和停服清理本次规则；创建后断线或清理失败保留失败状态，
设备恢复后可显式撤销。HDC 表没有所有权令牌，外部并发替换和服务崩溃后的
残留不能靠此检查自动认证或清理；实际设备路径仍待验证。
`debug events` 读取校验过的脱敏记录，返回 nextCursor/through/hasMore，
不恢复设备认证或自动重放。`debug streams` 与
`GET /api/v1/debug/sessions/<id>/streams` 列出全部历史 stream，
以 `--after <stream-uuid>` 分页，默认 20、最多 64 个；每会话超过 1000 个
目录时明确拒绝枚举，损坏档案单独标记且不返回其未校验内容。
Web“调试”页读取同源记录，支持事件流选择、分页与实时跟随，
默认流位于后续索引页时继续定位，加载更多流时保留当前选择，迟到的事件页不覆盖新选择。
实时列表按浏览器帧合并刷新，最多显示最近 100 条；暂停、故障和结束显示最后已接受
记录，刷新或切换选择取消旧渲染。该行为不证明真实 Kit 采集或十分钟性能目标。
明确显示未验证身份、事件缺口和连接失败。“通道摘要”提供 17 个只读通道视图，
保留未采集/未协商状态、字段缺口、接口参考、未知采样率和逐条时钟证据。
支持加密四时间戳测量的 Producer 可提供偏移区间；10 ms 预算、漂移上限假设、
过期与重连分段均可见，旧 mergeable 标志不证明校准。日志与问题包重算测量，
不恢复上一连接的校准。协议及边界见 [debug-clock.md](debug-clock.md)。
`debug inspectors` 描述通道；`debug inspect` 按通道筛选同一份校验日志，
默认 100、最多 256 条。分页使用原始提交游标，首轮返回 `through/snapshotHash`，
后续传入 `--through` 固定截点；末页游标可越过其它通道记录到截点。
CLI、HTTP 和 Agent 均校验当前 cwd/工程范围；仅 `debug.inspect/inspectors`
可作为只读 Agent/后台任务，配对与生命周期仍被拒绝。
网络逐条标为 summary-only，API 参考不证明实际使用拦截器。
完整 UI Inspector、ArkWeb DevTools、Profiler 采集端点尚未关联。
查询合同见 [debug-inspector.md](debug-inspector.md)。
事件与独立提交记录同步后才确认；尾文件丢失、提交不一致和未提交文件均拒绝
读取。日志读写使用每 stream 的跨进程锁，读者等待提交完成后才校验。
Producer 可在加密 ready 协商 `eventBatch:"events-v1"`，每帧最多 64 条且
仍受 maxFrame 限制。manifest 1.3 将整批保存为不可变分段，checkpoint
同步完成后累计确认；未协商客户端与旧日志兼容，满额整批拒绝。
显式同时协商 `retention:"rolling-v1"` 的新流使用 manifest 1.4，
在每流 4096 条/5 MiB 内淘汰最早整段。CLI、SSE 和离线问题包保留原始绝对
序号、缺口及实际保留条数；恢复须再次显式协商，不转换旧档案。
淘汰改变导出前缀时，旧审批失效。十分钟负载与真实 Kit 互操作尚未验证。
详情见 [事件批次](debug-event-batches.md) 和 [滚动历史](debug-retention.md)。
空闲连接按密钥期限清理，状态写失败仍完成停服。工作台代码、资源、
协议或 Node 指纹变化时返回 `WORKBENCH_CODE_CHANGED`，须明确停止后重启。
新日志以 manifest 1.2 保存双方只读协商，以 checkpoint 1.1 保存最多 24 个
连接 epoch；恢复时校验完整提交链、原始事件摘要与时钟分段，并拒绝旧写入者。
必须重新私有配对及应用内确认，在加密 ready 中指定原 stream、previousEpoch
与 resumeFrom；只允许同一 DebugSession、完整身份和协商合同，窗口外报告 gap。
旧 manifest 1.1 可查询，但不猜测缺失的恢复依据。密钥不持久化，服务重启或
撤销后的新指纹不能续写旧 stream，历史查询仍可使用。
详情见 [桥接合同](debug-bridge.md)；真实 Kit 重连和设备身份仍未验证。

已保存的事件流可导出独立问题包，预览和 R2 单次审批绑定固定提交截点：

```bash
ohmatecli debug problem plan <session-id> --stream <stream-id> --through 104 --format json
ohmatecli debug problem export <session-id> --stream <stream-id> --through 104 --format json
ohmatecli debug problem export <session-id> --stream <stream-id> --through 104 --approve-plan <plan-id> --format json
ohmatecli replay import --path /absolute/path/example.ohmate-problem.zip --format json
ohmatecli replay verify --path /absolute/path/example.ohmate-problem.zip --format json
ohmatecli replay plan --path /absolute/path/example.ohmate-problem.zip --steps /absolute/path/example.ohmate-replay.json --format json
ohmatecli replay show --path /absolute/path/example.ohmate-problem.zip --after 0 --limit 100 --format json
ohmatecli replay show --path /absolute/path/example.ohmate-problem.zip --domain memory --after 0 --limit 100 --format json
ohmatecli replay show --path /absolute/path/example.ohmate-problem.zip --domain web-dom --file web-dom/target.json --format json
```

`replay import` 完整校验后返回绝对 `path`、`importStatus:opened` 和
`access:read-only`，可将该路径交给 `replay show` 继续分页。导入不复制、提取
或持久登记问题包；后续读取重新校验原文件。导入回执只返回元数据，
不携带全量事件或时钟数组；其它主版本返回 `importStatus:manifest-only`、退出码 3。
Web“调试”页提供同源导出审批、离线校验、分页与失败恢复；Agent 可调用六个
问题包工具，导出需人工审批。`--build-id <expected-build-id>` 可作精确断言，
不认证构建。文件按位置读取，校验原始 ZIP、Schema、哈希、身份、序列、脱敏
和覆盖；不提取文件或执行重放。同主版本只消费已知 profile 的已知字段，
新增字段明确标记未展示；不同主版本只显示安全 manifest，退出码 3。
`replay plan` 重新校验问题包并绑定 ZIP/步骤文件原始哈希，最多接受
64 条测试语义步骤、64 KiB UTF-8。每条普通步骤必须指定 `test.` 动作和
断言引用、`test:` 数据与预期引用、1–3000 毫秒等待；系统交互只列人工步骤。
未知字段、原始输入、敏感动作和不匹配 buildId 拒绝。缺少 `--steps`
返回空步骤和人工补齐说明，不从事件摘要推断业务操作。当前回执始终为
`manual-only` / `not-performed`；同名构建和离线哈希不能认证应用或准入远端写。
滚动问题包保留原始序号与缺口；较大时钟依据采用 minor 1.3 随事件保存，
不提高解码预算。事件页只返回本页时钟数组及绝对起点，完整校验仍返回全量依据。
Kit minor 1.4 校验 18 领域的非空结构/摘要、来源、采样、丢弃与缺失清单。
`--domain` 返回 Kit 领域页，`--file` 可选定该领域内清单文件；游标是本选择
的记录序号，切换选择需从 0 开始。每页最多 256 条、记录 JSON 最多 48 KiB，
验证所有文件后才返回；附件始终仅元数据。Web 提供同源领域和文件选择。
JSONL 构造与导入预算均为 32 MiB，结构/摘要合计 64 MiB。
Kit 示例可按需读取本页最多 256 个已展开组件的类型、层级、窗口 vp 几何和
visibility 属性，发送节点数量摘要；可见属性不证明遮挡或实际送显。
旧无几何的已知 UI Schema 保持可读，未知约束仍被拒绝。
并包装本页注册的 `HttpRequest.request`，仅观察方法、状态与耗时，不读取 URL、
请求头或正文。请求与 PSS 轮流发送，队列最多 32 条；其它实例和流式请求未接入。
示例还加载已确认工作台的固定网页，使用 API26 `getFullDom` 按需提取最多
256 节点、32 层的结构；默认返回的标题、文字、属性临时丢弃。Console 仅读
级别，导航只记录主页面回调间隔，无 HTTP 状态或完整请求覆盖。
超时不取消原生请求，结束前保留所有者；重建、到期与来源变化使旧快照不可读。
应用内 Console 和正文捕获遇到回拨或非安全整数时钟立即撤销当前授权，
保留最后有效时钟。时间恢复后仍需重新复核、独立确认；旧 plan 与在途 ticket
不能复活。正文重复确认不续期或重置额度，Console 重复执行不再调用原生接口。
Cookie 数量先只在应用内存保留 30 秒；显式发送后，`debug inspect <id>
--stream <stream> --channel arkweb.storage` 可读计数与固定范围说明。名称、值、
属性、其他来源和配额不采集。发送只证明收到摘要，不认证 Cookie API 或设备。
已发送且仍有效的摘要可经应用导出复核进入 `arkweb.jsonl`，终端使用
`replay show --path <zip> --domain arkweb` 读取。取消、来源变化或到期会使未保存的
导出失效；应用清空不会撤回桌面历史或用户已保存文件。local/session 默认关闭；
示例可在配对前显式允许本页两个普通 `ohmate-test-` 键，按需只显示存在项数。
固定页面 Adapter 不枚举其它键，原值只在私有内存保留至原始30秒期限，
不展示、发送或导出；撤权、来源变化、后台、断连和到期清除。应用内单键
写入需逐条复核、确认、单次执行；仅两个测试键及固定值、空值或删除。
取消先撤销许可再尝试条件恢复，不覆盖并发值；失败仅显式重试，超时后
保留原生锁，迟到恢复不能认证成功。原值仍于原始30秒期限清除，漂移
永久撤销恢复资格，未完成责任阻止重配。无原值解锁或远程写入准入。
停止先清空写入授权与原值；若仍有恢复责任，连接关闭后保持
`cleanup-failed/STORAGE_RESTORE_REQUIRED`，重复停止与原生迟到完成不表示恢复成功，
也不向已销毁来源发送恢复脚本。
声明来源不认证实际平台捕获；真实写入/恢复及 Phone UX 仍未验证。
应用内轮廓只标记当前窗口的固定说明区域，宿主默认缺失。
复核、允许、执行、取消和清理重试分别操作；许可最多30秒，轮廓最多3秒。
来源、身份、窗口、断连、到期或回拨会撤销；失败清理责任持续显示并阻止
重配，不能自动重试。仅切换恒定边框颜色，宿主接收状态不证明实际渲染；
不提供远程高亮准入、设备/build认证或物理显示证明。
故障事件需单独启动订阅，只提取系统崩溃/冻屏名称，不读参数或日志；最多暂存
32 条，回调时间不代表故障发生时间。DFX、Web、HTTP 轮转，与 PSS 交替，
自动合计最多 1Hz、单 ACK。CPU 为显式 TaskPool 单次进程百分比读取，
未返回的原生 owner 或失败移除的订阅阻止重配。
显式导出固定 PSS/CPU、DFX、当前 UI/DOM、最近 Console 和 HTTP/主导航摘要；
CPU/PSS 合并唯一内存文件，DFX 独占事件文件；PSS-only 保持原格式。
独立截图复核只允许固定说明节点，最长边 512 px、像素内存 1 MiB、PNG
256 KiB、等待 3 秒；原生未结束或释放失败保留所有者。截图仅内存预览 30 秒，
不进入桌面事件或 ZIP，撤销、后台和到期清空；未提供平台保护截图存储。
两个网络来源合并同一文件并声明联合来源，缺失领域不创建占位文件。
实际平台采集、保存运行和真实设备/build 认证仍未验证。
格式、预算和证据边界见 [问题包合同](problem-package.md)。

静态资源由 `apps/web` 生成到安装包内的 `dist/web`。API 与实际验证边界见
`docs/web-runtime.md`；网页显示与终端同一份 Patch Diff 和审批计划，并提供
明确的修改路径选择。完整工程生成验证、深度调试与 Kit 仍在后续实施范围。

## 官方扫描与项目 API 文档

```bash
ohmatecli scan --files entry/src/main/ets/Api.ts --domains official --config codelinter.json5 --project . --format json
ohmatecli docs generate --modules entry --project . --format json
ohmatecli docs check --modules entry --baseline /private/evidence/docs-ai-json-UUID.json --project . --format json
```

Scan 通过当前 ToolProvider 的官方 Code Linter 入口执行，使用独立 HOME，
逐文件限制在声明模块的源码中；不修改工程、不调用官方 `--fix`。
回执保留原始退出码、输出哈希、原始 JSON 和输入哈希，并归一化去重为
JSON、SARIF 与 HTML。默认请求全部规则域，未接入的域标为 `not-run` 并返回 3；
显式 `--domains official` 的已执行范围无诊断返回 0，有诊断返回 1。
官方空报告只证明该次调用没有诊断，不代表全部 ArkTS/编译器/Compat 规则覆盖。
当前 `--fix`、`--apply` 尚未注册，输入被拒绝。

`docs generate/check` 使用 Studio ArkTSDoc；知识检索的原 `docs search/read/catalog`
仍保留。官方 HTML 中的模型只作为 JSON 解析，不执行脚本。SDK 编译前端的
Program 和 TypeChecker 解析公开导出、相对路径重导出、默认导出及可调用重载，
再关联声明来源的官方文档。HTML、索引和 AI JSON 共用同一模型哈希。
`check` 无 baseline 时报告缺失描述，提供同模块 baseline 时比较增删与签名/描述变化；
按模块检查允许源码文件集合变化，显式 `--files` 必须与 baseline 的文件范围相同。
随机 Producer ID 和生成时间不参与身份，重载签名在同一稳定符号下分组。
编译器文件、版本元数据、读取文件哈希和模块解析结果作为独立证据保存；
无法解析的导出、源码或编译器漂移使结果无法认证。此 Program 不替代真实构建
输入闭包：SDK/OHPM 模块配置、命名空间和跨文件声明合并仍需完善，
Native 导出和 Cloud 契约仍需专用 Producer。报告越界、坏格式、非正常官方退出
保留为失败证据。

## Hvigor 接入与便携 Skill

```bash
ohmatecli integrate runtime --module entry --profile release-none --project . --format json
ohmatecli integrate runtime --module entry --profile release-none --write --project . --format json
ohmatecli config validate --path runtime-profile.json5 --project . --format json
```

`integrate runtime` 默认只预览 Diff。`--write` 通过审批绑定配置及文件哈希，
使用现有 Patch 日志写入并恢复，不覆盖已有目标。模块必须是声明的 Entry，
`src/main/ets` 等父目录必须已存在。生成 `runtime-profile.json5`、模块级
Hvigor 适配、`src/main/ets/OHMateRuntimeEntry.ets` 和模块级 Profile manifest。
宿主仍须手动导入入口；工具不修改 Ability、页面或模块依赖。

Profile 配置为 `schemaVersion:"1.0"`、`release:"none"|"core"`、
`debug:"debug"`、`test:"test"`、`probes:[]`。probe 声明只能包含
唯一 `id`、`kind`（`runtime-aspect/aspect-plugin/abckitts`）、已声明 `module`、
`ruleHash` 和字面量 `runtimeGate:true`；不包含参数或返回值内容。
配置合法仍返回 `valid:null/exit 3`，不能认证已编译 probe 或 Release 消除。
`release-none` 入口无导入、无初始化，Debug 方法返回
`CAPABILITY_NOT_AVAILABLE`。`debug/test` 委托真实 `api/runtime`，要求 Entry
声明 `@ohmate/ohmatekit` 依赖，写入审批绑定该声明的哈希。两个 Profile 均要求
实际 `debug` Build Mode；配置、入口、manifest 或依赖字节漂移会阻断构建。
`release-core` 仍返回 `RUNTIME_ENTRY_UNAVAILABLE/exit 3`；非空 probe 清单缺少
compiler producer 时拒绝生成，不静默丢弃。生成的 Hvigor 适配在
模式不符或缺少 Release 产物纯净证据时明确失败，不提供绕过开关。
manifest 保持 `buildId:null/incomplete`；源码检查拒绝 Debug/Test manifest
或 probe 声明，空清单不能清除 compiler/最终产物证据缺口。

包内 `tools/{doctor,generate-integration,verify-release}.mjs` 是由 CLI 规范源
生成的独立构建期 helper，只需 Node 22。参数为 `--project <工程根>
--data-dir <私有目录> --input <JSON>`；generator 的 input 与 CLI 相同但禁止
write。doctor 检查消费者 SDK/API 声明、模块依赖、Profile、入口/manifest 和
生成 guard 字节；Test manifest 也必须声明 debug Build Mode。静态错误返回 1，
缺 compiler/实际 Hvigor 模式/产物证据返回 3；API26 不是推断的最低版本。
verify-release 复用全部 14 项源码/依赖/显式包字节门禁。其 input 可包含
`format:"json"|"sarif"|"html"`，默认 JSON 事实位于回执 `data`，其他格式位于
`data.content`，`data.reportHash` 绑定相同 JSON 事实。helper 默认不写报告文件；
CLI `release verify/guide` 在私有证据目录保存 JSON、SARIF 与转义 HTML。
报告保留最终包哈希、manifest 声明的工具链版本和 unverified Core-only 基准。
它们不应用 Diff、不执行 producer、不认证 buildId 或最终 Release。
HAR 收录 `tools/**`，不作为应用资源。

```bash
ohmatecli integrate hvigor --project . --format json
ohmatecli integrate hvigor --project . --approve-plan PLAN_ID --format json
ohmatecli skill export --format json
ohmatecli skill verify --path EXPORT_DIRECTORY/ohmate-cli --format json
```

`integrate hvigor` 读取根级 `hvigorfile.ts`，给出现有文件和新增
`ohmate-hvigor.ts` 的 Diff。确认后保留现有插件、注释、BOM 与换行，
写入和恢复复用 Patch 日志；动态默认导出、非字面量插件数组和已有目标文件
需要手动处理，工具不会覆盖。生成插件不保存本机路径，运行时从工程依赖解析
`@ohmate/cli-common`；工程须已安装 `@ohmate/ohmatecli`。

官方 Hvigor 提供四个薄任务：`ohmatecliScan`、`ohmatecliDocs`、
`ohmatecliTest`、`ohmatecliVerifyRelease`。Scan 和 Docs 分别委托原生
`scan` 和 `docs check`；Release 委托现有证据门禁，
缺证据不会通过。Test 创建待审批的持久 Local Test 任务并返回 5，
按原始回执中的 `task approve` 命令在 Hvigor 退出后执行。
内部 `integrate hvigor-task` 入口仅处理固定任务名称，不接受任意工具或进程。
在根级插件调用中可给每个任务提供范围，例如
`ohmatePlugin({ ohmatecliScan: { modules: ['entry'], domains: ['official'] }, ohmatecliDocs: { modules: ['entry'] } })`。
这些输入仍由目标 ToolSpec 校验，不能替换工具 ID 或绕过审批。

`skill export` 从当前公开 Registry 生成 `SKILL.md`、`commands.json` 和
哈希 manifest，放入私有产物目录中的独立 `ohmate-cli` 文件夹；回执给出路径。
每次导出保留之前的文件，供手动复制到 Agent，工具不执行全局安装。
`skill verify` 只读检查文件集合、链接、大小、格式、哈希、入口、版本和
逐命令 Schema 漂移，拒绝机器绝对路径、凭据与任意进程指令。
导出的 Schema 与选项覆盖同一入口中的底座能力；最终参数限制和权限仍由
Runtime 校验，Skill 正文不会授予额外执行权。

## 数据与隐私

默认不启动遥测、不迁移全局 Skill、不查询更新。产品数据根目录为
`~/.local/share/ohmate`，可用 `OHMATE_DATA_DIR` 指定；旧命令仅在隔离子进程中
映射到该目录。`OHMATE_LANG` 支持 `zh-CN` / `en-US`。
凭据不得通过 `--api-key` 输入或写入任务记录。

文档引擎已保留，但指定快照缺少 `docs.zip/index.zip`，官方知识检索需补齐真实
归档；不以示例文档代替官方数据。设备、真机与平台专属能力需要单独验证。

## 开发验证

```bash
env TMPDIR=/private/tmp npm test
npm run build
npm run lint
npm run typecheck
```

macOS 测试使用规范化临时路径，避免 `/var` 与 `/private/var` 的路径别名影响
底座故障注入测试。`typecheck` 覆盖 CLI、docs-engine 和 docs-index-builder
的完整 TypeScript 源码；docs-zh 与 cli-wrapper 的 JavaScript 入口通过构建和
实际入口验证。类型检查不代表 SDK、设备或 GA 验收通过。

源码布局保留五个 workspace；主要新增服务在 `packages/cli/src/runtime`、
`terminal`、`tasks`、`agent`、`workspace`、`web`、`legacy`、`environment`、
`project-model`、`project-create`、`project-config`、`dependency`、`quality`、
`release`、`integrate`、`portable-skill`。上游使用指南保留在
`docs/upstream-README.md`，其遥测、安装和更新流程不作为 OHMate 行为依据。
