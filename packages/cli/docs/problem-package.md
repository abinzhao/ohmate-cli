# 离线问题包

OHMate CLI 从已校验的桌面事件日志导出 `.ohmate-problem.zip`。
CLI、Web 和 Agent 使用同一 Registry、任务、单次审批和回执。
默认导出 profile 为 `domain-summaries`：领域摘要、覆盖范围、脱敏计数和公开标识；
不含页面/UI 文本、配对材料、请求 body、附件或应用内重放动作。

## 导出与校验

```bash
ohmatecli debug streams <debug-session-id> --format json
ohmatecli debug problem plan <debug-session-id> --stream <stream-id> --through 104 --format json
ohmatecli debug problem export <debug-session-id> --stream <stream-id> --through 104 --format json
ohmatecli debug problem export <debug-session-id> --stream <stream-id> --through 104 --approve-plan <plan-id> --format json
ohmatecli replay import --path /absolute/path/example.ohmate-problem.zip --format json
ohmatecli replay verify --path /absolute/path/example.ohmate-problem.zip --format json
ohmatecli replay verify --path /absolute/path/example.ohmate-problem.zip --build-id <expected-build-id> --format json
ohmatecli replay show --path /absolute/path/example.ohmate-problem.zip --after 0 --limit 100 --format json
ohmatecli replay show --path /absolute/path/example.ohmate-problem.zip --domain memory --after 0 --limit 100 --format json
ohmatecli replay show --path /absolute/path/example.ohmate-problem.zip --domain web-dom --file web-dom/target.json --format json
```

`through` 是固定、包含式绝对提交截点，范围为非负安全整数，不能超过当前尾序号；
滚动流已淘汰的截点拒绝导出。审批预览包含完整文件清单
（含 manifest 的大小与哈希）、字段、覆盖、脱敏、总字节和保留风险。
R2 审批绑定源 manifest、选定记录哈希和归档字节；后续事件不扩大截点。
滚动淘汰改变选定前缀会使审批失效。输出在数据目录的独立私有目录中以排他方式写入，
不会覆盖既有文件；路径和 SHA-256 进入回执。

`replay import` 完整校验已知 profile 后，返回原文件的绝对 `path`、
`importStatus:opened` 和 `access:read-only`。导入不复制或持久登记问题包，
不提取、恢复认证或执行内容。后续 `replay show --path <返回路径>` 每次重新
校验原文件，导入成功不免除后续完整性检查。导入回执返回 manifest、session
元数据、Kit 来源/清单和记录数，不携带全量事件或时钟数组。R0 读取可通过
终端、任务、HTTP 和 Agent 调用；任务会按既有规则保存输入和回执，
不会另存问题包字节。不同主版本保留退出码 3，返回 `importStatus:manifest-only`，
不表示已打开或校验 payload。

Web“调试”页提供“导出选定事件流”，审批在任务页显示。“离线问题包”
接受本机文件路径，校验后每页显示至多 100 条；Kit 页另受字节预算限制。
校验 Kit 包后可选择清单中的领域与文件，缺失领域明确显示 `not-captured`。
读取失败时清空旧结果，可修改路径
重试。命令面板及 Agent 开放五个问题包工具；配对和服务生命周期仍走专属入口。
Agent 导出暂停等待人工审批，不继承先前的审批凭据。

## 包结构与边界

```text
manifest.json
session.json
events.jsonl
schemas/manifest.schema.json
schemas/session.schema.json
schemas/event.schema.json
```

Schema 从当前仓库规范源生成，实时领域事件与离线事件共用定义。
离线信封移除服务 fingerprint。manifest 列出其余文件的规范路径、类型、
大小、SHA-256、敏感级和压缩方式；manifest 不自列，以避免循环哈希。

导入不提取文件或执行内容。原始 ZIP 目录和本地头均先校验，拒绝路径跳转、
绝对路径、脚本、链接/特殊文件、重复及大小写冲突、重叠、加密、额外字段、
ZIP64、描述符、注释和前后夹带数据。支持 store 和 deflate，校验 CRC、
实际展开长度、完整压缩输入消费和 SHA-256。

包上限 2 GiB、单文件上限 1 GiB、最多 10000 个文件、解压倍率不超过 100。
文件导入按位置读取目录和内容，不把整个归档分配进内存。
当前摘要 profile 另有解码预算：manifest 与每个 Schema 4 MiB、
session 1 MiB、events 32 MiB；内容解码超限返回 `PROBLEM_SUMMARY_LIMIT`，
manifest 超限返回 `PROBLEM_MANIFEST_INVALID`。
默认摘要文件集保持不变；Kit 只读文件集的额外约束见下文。
文件必须是单链接的普通文件，读取前后核对身份、大小及修改状态。

同主版本支持已知 profile 的 minor 版本和对象字段新增，保持已有约束、
可选字段及领域联合不变。新增字段不展示或执行，回执以 `ignoredFields`
和 `fieldCoverage:known-fields-only` 明示；改变已知约束或在已知 Schema 节点
增加远程引用会被拒绝。接受已知摘要与 Kit 只读文件集；未知通道、文件集和
profile 拒绝导入。
不同主版本仅返回安全 manifest，`payloadIntegrity:not-checked`，退出码 3；
不读取事件页。哈希、Schema、身份、序列、脱敏总计或覆盖不一致会失败。

## 证据含义

`buildId` 精确匹配只是可选断言，不认证构建。所有导入结果保持
`authentication:not-restored`、`buildVerification:unverified`、
`deviceProvenance:peer-asserted`、`clockCalibration:not-verified`。
SHA-256 证明字节一致性，不是签名或身份认证。
`summary-only` 仅表示保存过领域摘要；`not-captured` 不能证明该通道没有问题。
`replay:not-performed` 表示没有执行应用动作。

minor 1.1 的摘要包可包含 `session.clockEvidence`，与事件按原序号一一对应。
导入重算测量区间、误差、epoch 和段号，拒绝哈希正确但推导伪造的记录。
`clockCalibration:not-verified` 仍表示未认证平台时钟；逐条测量不改变设备/build
身份结论。旧 1.0 Schema 和无测量包继续兼容，详见 [debug-clock.md](debug-clock.md)。

滚动摘要包使用 minor 1.2：`session.history` 保存保留起点、实际条数、
完整 epoch 列表、公共提交锚点和精确配额缺口。事件保留绝对序号，
逐条时钟以 `sequence - history.from` 定位；不会包含内部 source/resume 摘要。
读取在同一个日志读锁内取得记录、锚点与时钟，导入重算连续序列、
epoch、时钟段、脱敏总计和覆盖范围。CLI、Agent 与 Web 分页使用绝对排他游标；
缺失历史明确显示，不重新编号或恢复认证。详见 [debug-retention.md](debug-retention.md)。

完整逐条时钟导致 session 超过 1 MiB 时，导出采用 minor 1.3：
`session.clockEvidenceLocation:"events.jsonl"`，时钟依据随各事件保存，
不提高 session 或 events 的解码预算。导入验证规范 Schema 和每条依据后
还原完整 `session.clockEvidence`。`replay verify` 保留完整依据；
`replay show` 只返回本页 `clockEvidence` 与绝对 `clockEvidenceFrom`，
移除 session 中的全量数组，避免一条事件页超过 Agent 输出预算。
Web 根据页起点定位时钟，同时兼容旧全量数组响应。
该布局需要支持 1.3 的读取器；旧读取器不会猜测或降级处理布局。
小包继续采用 1.2，非滚动 1.0/1.1 布局与超预算拒绝保持。

## Kit 只读文件集

minor 1.4 的 `content:kit-readonly` 支持合同中的 18 个领域：
环境、动作、导航、ArkWeb、Web targets/DOM/Console、网络摘要/抓包 metadata、
Mock 规则 metadata、插桩、DFX、内存、UI 树 metadata、错误、分诊、faultlog 和快照。
`profile.json` 与 19 个 Kit Schema 同源生成；原 session/event/manifest Schema
也随包保存，旧 1.0–1.3 摘要布局继续兼容。

提供的 JSON 文件是非空记录数组，JSONL 每行一条。缺失领域仅在 profile
中记为 `not-captured`，不生成空数据文件。每个文件声明来源 ID、来源类别、
记录数、丢弃数、采样标记及 `representation`；平台来源必须注明采集 API。
实时摘要复用领域定义、校验公开身份并检查二次脱敏；结构记录不接受 UI
文本、请求正文、脚本、选择器或动作执行参数。结构记录有时钟，但不证明时钟校准。
导入核对所有清单、领域汇总、记录数、类型及规范 Schema，回执包含 `kit`
来源与缺失清单。`captured` 只描述来源声称提供过记录，不证明完整平台采集。

来源始终为 `peer-reported`，允许 `platform-api`、`registered-adapter`、
`manual-import`，拒绝把 SDK 声明或 reference-only 目录作为采集来源。
结构和摘要文件导入解码总预算为 64 MiB，JSON 4 MiB、JSONL 32 MiB，
session 1 MiB、Schema/profile 4 MiB；原归档总配额不变。
内存构造器与导入器共用 JSONL 32 MiB 上限，原 session/events/Schema
及归档预算保持不变。

`replay show --domain <domain>` 返回 `kitPage`，不附带旧 `events` 页。
`--file <listed-path>` 可进一步选择该领域内的一个文件，不能脱离领域使用。
`after` 是本选择内从 1 起算的排他记录序号，按 profile 文件顺序连接记录；
切换领域或文件必须从 0 开始。`count` 不计附件，`nextCursor` 与 `hasMore`
用于继续读取。每页最多 256 条，`records` 的 UTF-8 JSON 最多 48 KiB；
字节预算不足时提前结束该页，游标连续推进，不跳过记录。
记录包含文件路径、角色与已验证的结构/摘要，新增未知字段先剔除再返回。
所有文件的 CRC、长度、哈希、Schema、身份及清单均须验证通过，
未选定文件或页尾后的损坏也会阻止输出。读取不缓存第二份全量 Kit 记录。
选定附件返回空记录页和已验证元数据；缺失领域返回空页与缺失状态。
非 Kit 包不能使用领域选择。未指定领域时保持旧事件和时钟分页。

附件只接受 `faultlog/<id>.txt/.log` 和 `snapshots/<id>.png/.jpg/.jpeg`。
附件必须带 `review:explicit-export`，profile 声明
`attachmentPolicy:user-reviewed`，manifest 使用 `reviewed-attachment` 敏感级。
这是不可信的审查声明，不是认证或自动脱敏证明；桌面默认导出不加入附件。
导入核对 UTF-8/零字节或图片头尾类型标记，附件仍为惰性数据，不解码图片、
提取文件、执行或向回执返回原文。图片标记检查不认证完整图片格式。

终端文件导入逐块核对附件的 SHA-256、ZIP CRC、完整展开长度及压缩输入消费；
每次读取最多 65536 字节，不调用收集完整附件的 `read`。同步 Buffer 校验器
对超过 4 MiB 的 deflate 附件返回 `PROBLEM_ATTACHMENT_ASYNC_REQUIRED`，
公共终端导入使用异步位置读取，不受该同步接口限制。

当前源码支持文件集校验、来源清单、领域分页、显式只读导入和工作台领域/文件选择。
公开 Schema 已由生成器嵌入示例；示例实现固定 PSS/CPU 摘要的应用内复核与系统保存，
并可加入已显式读取的本页 UI/DOM、最近已发送的注册 HTTP、Console 与主导航摘要。
显式启动的 HiAppEvent 只导出系统崩溃/冻屏名称与回调观察时间，不包含 params、
堆栈、日志路径或附件；未收到回调保持未采集。CPU/PSS 共用唯一内存文件，
每种最多最新一条并声明联合 API 来源；DFX 独占事件文件，跨会话/错误来源/
额外字段与重复指标被拒绝。`app-memory-summary` 保持原 PSS-only 布局，
`app-readonly-summary` 为 CPU、DFX、UI、Web 和网络文件提供独立来源布局；两者均无桌面 stream、
认证、历史或校准声明，原始 session 在 minor 兼容投影之前检查。
UI 文件最多 256 个已展开节点，可含类型、层级、窗口 vp 几何、visibility
属性和采集时间；属性不证明遮挡、变换后边界或同帧。精确旧无几何 Schema
继续可读，其他约束保持。没有文字、输入值、
源码映射或附件。网络来自注册 `HttpRequest.request` 包装器，只有方法、状态与耗时，
不包括 URL/请求头/正文；registered-adapter/peer-reported 不认证实际来源。
DOM 的系统 getFullDom 默认私有字段临时丢弃，只导出 256 节点内的类型和树关系；
Console 仅读级别并保存固定摘要。主导航仅回调间隔，无 HTTP 状态；与 HTTP
共用唯一 network-summary 文件，文件来源明确声明联合 adapter，记录保留各自通道。
各文件来自各自采样，不表示同帧或完整历史；缺失领域不创建空文件。
示例的固定节点截图经独立复核后仅内存预览三十秒，受 512 px/1 MiB 像素/
256 KiB PNG/三秒等待预算约束；未提供平台保护截图存储，不包含于该 ZIP。
实际 `.ets` 编码器与桌面构建/独立安装的互操作验证以当前命令回执为准；
内部交接记录不随公开仓库发布。
这些检查不认证平台采集或保存运行。真实 Kit、设备/build 认证、
动作重放与更多平台仍需验证。
