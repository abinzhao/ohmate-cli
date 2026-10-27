# 本地只读桥接合同

此合同适用于 OHMate 0.1.0 的桌面侧桥接。`ui`、`debug start` 和兼容
`devtools serve` 使用同一后台 worker、HTTP/WebSocket 和持久 DebugSession。
ArkTS 示例 Producer 已实现并通过无签名构建，平台运行仍未验证；HDC 设备
身份和已认证 buildId 尚未接入。对端提供的设备与构建
字段不能作为设备或编译产物的认证证明；所有能力仍为只读，LAN 禁用。

## 接口与状态

| 入口 | 行为 |
| --- | --- |
| `GET /api/v1/debug/bridge` | 浏览器认证后读取当前桥接状态 |
| `POST /api/v1/debug/pairing` | Cookie、Origin、Host、CSRF 校验后生成短期邀请；目标 project 必须匹配启动工作区 |
| `POST /api/v1/debug/revoke` | 撤销连接并清理会话密钥；保留已落盘证据 |
| `WS /bridge/v1` | 仅 loopback、指定 Host、允许 Origin 和 `ohmate-readonly-v1` 子协议 |
| `debug status/list/show` | 查询同一持久会话；不返回邀请或密钥 |
| `debug streams <id>`、`GET /api/v1/debug/sessions/:id/streams` | 全部历史 stream 的同源索引；after 为 UUID，limit 默认 20、最多 64；损坏档案单独标记 |
| `debug events <id> --stream <id>` | 校验 manifest、事件哈希与连续序列后，按 `after/limit` 读取脱敏证据 |
| `debug pair --buildId ... --device ... --process ... --sessionId ...` | 仅 human/双 TTY/非任务上下文写出邀请；检查启动根与代码指纹 |
| 同入口 `--hdc-device <connected-serial>` | 私有控制路由要求精确连接 serial；worker 创建并管理设备到主机的同端口映射 |
| `POST /_ohmate/pair`、`/_ohmate/revoke` | 私有控制能力、Host、无 Origin、启动根与代码指纹校验；不经通用任务 |
| `GET /api/v1/debug/sessions/:id/streams/:stream/events` | 同源校验后分页；after 为排他游标，limit 为 1–256，默认 100 |
| 同路径 `/live` | 已鉴权的只读 SSE，支持 Last-Event-ID；结束/损坏为独立 end/fault 控制消息 |

桥接状态为 `waiting-pairing → pairing → connected`，断连、撤销、过期和
持久化失败分别显示明确状态与原因。浏览器退出不终止 worker。服务退出会
关闭 WebSocket 并清理密钥，已收到的证据仍可查询。

工作台复用校验源码或 worker bundle、静态资源、协议与 Node 版本指纹。
旧记录缺少指纹或指纹变化时返回 `WORKBENCH_CODE_CHANGED`，须显式停止后
重启；停止入口仍按进程所有权工作。此指纹不认证设备、构建或外部依赖。
连接关闭后的异步写入结果不能重新发布 connected 或发送 ack。
空闲连接也在密钥期限到达时释放；发出帧采用 512 KiB 队列预算。
状态写失败不阻断后续写入队列，停服仍关闭 HTTP 并执行清理；直接关闭调用
保留最后的持久化错误，失败事件不获得 ack。

## 配对与密码格式

邀请含一次性随机 256-bit 值、120 秒有效期、工作区和目标身份、服务指纹、
P-256 临时 SPKI DER 公钥、32-byte challenge 及只读 handshake。
邀请只经本地认证接口返回，不写入 DebugSession、任务日志或普通错误。
终端通过私有 TTY sink 显示包含 endpoint/invitation 的 JSON；普通回执只含
公开状态。管道、JSON 输出和 non-interactive 模式拒绝生成邀请。TTY 写失败
尝试撤销，回执明确返回 revoked 成功与否，不返回异常中的邀请内容。
应用必须先确认服务指纹与目标范围；桌面验证 proof 不能代替实际应用 UI
确认的验收。当前 Node 客户端是互操作测试 Producer。

采用高熵邀请以避免短数字码在可观察 HMAC transcript 中遭离线穷举；
未实现 PAKE，不能把邀请截短为六位数字。代码、challenge 和 DER 使用标准
Base64；Schema/proof/transcript 哈希使用小写十六进制。

1. 对端生成 P-256 临时密钥和 challenge，发送只读 handshake 与 kit-role
   HMAC-SHA256 proof，消息不含一次性值。
2. transcript 固定域、算法、双方 key/challenge、身份、协商结果和有效期；
   验证失败也消费邀请。身份或能力变化需新邀请。
3. CLI 返回绑定连接 ID、期限和帧预算的 cli-role proof。
4. ECDH 原始 32-byte secret 使用 HKDF-SHA256，salt 为 transcript 的
   32-byte 哈希，info 为 `ohmate/debug/1/kit-to-cli` 或
   `ohmate/debug/1/cli-to-kit`，分别派生 32-byte 密钥。
5. AES-256-GCM 使用 16-byte tag。96-bit nonce 的前四字节为方向
   （kit→CLI 为 1，CLI→kit 为 2），后八字节为递增 counter，均为大端。
   AAD 为帧头的规范 JSON。帧头绑定 connectionId、direction、counter。
6. 加密 ready 双向确认后才接收事件；同一 key 最多 65536 帧、最长十分钟。
   当前轮换要求重新配对，不支持自动降级或持久恢复认证。

规范 JSON 来自 `debug-protocol/canonical-hash.ts`：对象键按字典序排列，
数组保持顺序。密钥只驻留内存；关闭会话清零受控 Buffer。JavaScript 字符串
和 OpenSSL KeyObject 的释放由运行时管理，不宣称可靠物理擦除。

本机 API 26 的声明支持 `cryptoFramework` 的 ECC/ECDH、HKDF 和 GCM；
Node WebCrypto 已独立核验 DER、ECDH、HKDF、nonce/AAD/tag 格式。
这些证据不能代替 HarmonyOS 密码库的真机执行。

## HDC 转发

本机 HDC 帮助定义 `rport remotenode localnode`；`fport ls` 列出正向和反向
任务，`fport rm` 删除精确任务。后台服务只在显式指定连接 serial 时创建
`hdc -t <serial> rport tcp:<workbench-port> tcp:<workbench-port>`。两端使用
同一端口，保持 WebSocket Host 与桌面服务一致；所有事件仍经过现有 AEAD。
浏览器配对接口不接受 HDC 字段，Agent、任务和非私有终端均不能创建该映射。

创建前拒绝已有的选中设备反向入口；创建后校验设备、方向和完整端点。
删除前再次核对同一映射，删除后查询确认消失；其它设备或已变更的规则保留。
每个产品数据目录通过锁串行创建，连接、邀请和 worker 管理映射生命周期。
邀请过期、断连、显式撤销或停服触发清理。停服先保存释放状态再结束会话。
创建后观察失败保留清理对象和锁；清理失败显示 `cleanup-failed`，不能生成
新配对，设备恢复后由显式撤销重试。取消请求在收到邀请前也尝试撤销。

`hdcForward` 仅保存目标哈希、端口、方向和清理状态，
`authentication:unverified`。精确匹配是本次操作的观察证据，不是设备认证。
HDC 没有所有权令牌或原子条件删除；数据目录外的操作仍可能在复核与删除间
替换映射，不能证明相同端点的外部重建。worker 崩溃不自动接管旧规则；
设备端监听地址和真实传输尚未验证，不宣称 HDC 设备端只监听 loopback。

## 持久化与隐私

每条事件先通过领域 Schema、身份、channel、epoch、连续序列与时钟检查，
再执行二次脱敏，排他创建私有事件文件并同步，再原子更新并同步提交记录，
成功后返回加密 ack。
重复事件不重复写入。发生写失败时关闭连接，不确认该事件；
旧模式达到配额时展示未确认 sequence 范围；显式滚动模式淘汰最早整段，
历史查询显示精确缺口，不把淘汰计为未确认的新事件。

文件位于产品数据目录的 `debug-events/<debug-session>/<stream>/`。
manifest 和事件只保存公共来源；构建标记为 `unverified`，设备来源为
`peer-asserted`。每个 stream 默认最多 5 MiB/4096 条，事件有前序哈希。
新 manifest 版本为 1.2，保存双方只读 handshake；旧 1.1 档案仍可查询。
批次模式采用 1.3，显式 events-v1 + rolling-v1 采用 1.4/checkpoint 1.2，
同一配额内保留连续后缀和清理锚点。详见 [debug-retention.md](debug-retention.md)。
`checkpoint.json` 保存 manifest 哈希、已提交序号、
尾哈希和字节数；预算为提交记录预留 4 KiB。缺提交记录、尾文件丢失或事件与
提交记录不一致均拒绝读取。旧 1.0 日志缺少此证明，不猜测已确认前缀；
读写通过每 stream 的跨进程锁协调，最多等待五秒；锁超时不绕过校验。
中断写入留下的未提交文件也不自动修复。读取循环处理短读，检查文件身份、
大小和修改时间；这些检查不能提供对抗同用户恶意目录替换的事务隔离。
目录拒绝链接或异常权限，文件拒绝链接、FIFO、超预算和序列/哈希不一致。
哈希与提交记录用于损坏和尾记录丢失检测，不是设备数字签名；
拥有数据目录写权限的攻击者可同时改写文件与提交记录。

新 checkpoint 1.1 同时保存最多 24 个已使用连接 epoch。事件保存排除 epoch
后的原始摘要，用于重放冲突检测，不保存 memory-only 文本原文。
恢复在每 stream 的锁内完整验证提交链、协商和时钟段，然后同步新 epoch；
没有新事件的重连也会提交 epoch。旧写入者的检查点不一致时拒绝追加。
旧 manifest 1.1 不具备双方协商和恢复摘要，只读查询可用，续写返回
`JOURNAL_RESUME_UNAVAILABLE`，不自动升级。

续传要求新的私有邀请、应用确认、双向 proof 和 AEAD 密钥。对端在加密 ready
中附加 `resume: {streamId, previousEpoch, resumeFrom}`；服务端生成本连接 epoch，
仅允许同一 DebugSession、完整身份与只读协商合同，返回加密 resumed 和
ackThrough。保留窗口内的重放只确认、不重复落盘；窗口外返回准确 gap。
达到 24 个 epoch 时返回 `JOURNAL_EPOCH_LIMIT`，须明确开启新 stream。
密钥和认证不落盘；服务重启或显式撤销会改变指纹，拒绝续写旧身份 stream，
旧证据仍可查询。恢复的时钟 mergeable 仅表示误差预算资格，未完成跨端校时。

请求正文和截图不在当前 Schema 中。DOM/Storage/Console/UI 的文本默认
替换为 `[MEMORY_ONLY]`，仅保存数量、target 等元数据；尚无受保护静态存储
和敏感正文持久化授权。其它已脱敏摘要仍执行凭据、Cookie、URL query、
手机号、邮箱和身份证字段规则，不能把正则脱敏当作任意业务隐私分类器。

## 未完成的接入

HDC 真实设备路径与认证绑定、独立 Kit 包、ArkTS 平台运行、
完整时钟校准、各通道专用 Inspector 和问题包尚未完成。Web 只读调试页已
提供当前/历史会话、全部历史 stream 索引、分页与实时跟随。
默认 stream 不在第一页时继续读取索引；额外索引读取与事件流选择分别失效，
避免切换流时丢弃索引结果或让迟到事件页覆盖当前选择。
每会话超过 1000 个 stream 目录时明确拒绝枚举，不静默截断。
每次分页完整校验有界日志；实时跟随每秒复核，尚未验证高并发采集吞吐。
Mock、Console/Storage 写、高亮、Override 与 Replay 均未由此桥接开放。
状态写失败、关闭竞态、空闲过期、尾记录丢失、短读、发出帧背压和旧 worker
代码漂移已有故障注入；Windows 目录同步和权限边界仍需在目标平台实测。

`examples/OHMateKitProducer/` 使用平台密码库、应用确认与只读 PSS，
仅声明 `hidebug.read`，支持明确撤销和前后台生命周期。Schema 从本协议源码
生成，未知写命令直接关闭。详见 `kit-producer.md`；Node 替身协议测试与
应用/测试 HAP 的无签名构建不能代替真实平台密码、UI 或设备验证。
