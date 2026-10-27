# 有界滚动历史

Producer 在加密 ready 中同时声明 `eventBatch:"events-v1"` 和
`retention:"rolling-v1"`，connected/resumed 回显选定模式。
新流采用 manifest 1.4、segments-v1 与 checkpoint 1.2。
每批仍最多 64 条，受原 maxFrame、512 KiB 分段和接收队列预算约束。
每流最多 4096 条/5 MiB；保留最新的连续后缀，绝对序号为安全整数。
未声明 rolling-v1 的旧客户端保持原配额拒绝行为。

## 提交与恢复

追加整批前按条数和实际字节预算选择最早整段淘汰；不拆分旧段或扩大配额。
淘汰锚点保存最后移除记录的序号、哈希、原始摘要、epoch 与时钟。
先同步含 cleanupPending 的 checkpoint，再核对目标段字节并删除，
最后同步完成清理的 checkpoint。失败保留证据；没有受提交锚点授权的
旧段不删除，未提交尾段拒绝读取。新事件仍须分段和 checkpoint 同步、
会话状态发布都成功后才获得累计 ack。

恢复必须重新私有配对、应用内确认，指定原 stream、previousEpoch、
resumeFrom，且再次显式协商 events-v1/rolling-v1。只允许完整身份、
协商和 DebugSession 一致；不转换旧档案。已淘汰窗口返回精确 gap，
保留窗口内相同摘要回放不重复落盘；新增事件进入新 epoch。
最多 24 个 epoch，密钥仍有期限和帧数限制，不自动恢复认证或轮换 nonce。

写入和查询共用有界验证缓存：每次安全重读并哈希全部文件字节、校验
manifest/checkpoint/epochs/锚点，只有完全匹配的前缀才跳过解析与时钟重算。
安全读取每组最多4个文件，同时分配的字节预算之和不超过剩余总配额；
剩余不足时减小组大小。所有组内读取与关闭完成后才报错和释放流锁，
按原文件顺序校验返回内容，不以完成顺序拼接事件。
写入消费前缀后仅校验新记录，同步新 checkpoint 成功后保存新状态；
失败不保存部分验证。整段淘汰同时移除缓存记录和过期重放摘要。
缓存仍最多 16 流/4096 条/5 MiB，返回值为独立副本，不删除磁盘证据。
同进程的每流读写请求按进入顺序排队，再取得原跨进程磁盘锁。
五秒预算包含本地排队，只有外部持锁者采用 25 ms 有界重试；
超时队尾仍等待前一个持锁者结束，失败取得或释放会清理自己的队位。

## 查询与导出

CLI/HTTP 事件页返回 `retainedFrom`、`retainedCount`、绝对 `through`、
`nextCursor` 和配额 `gap`。`after` 为绝对排他游标。流索引分别展示
实际保留条数与已提交尾序号；through 不能作为条数。
分页在读锁内验证全部文件与提交锚点后，才选择并防御复制返回页；
页外文件不因未返回而跳过完整性校验。保留条数和尾序号来自完整提交。

SSE 在缺失游标时先发送 `event:gap`，ID 为 missingThrough，再发送
同次校验读取中的保留事件，每条保留原始 ID。没有游标缺口但窗口变化时
发送无 ID 的 retention 通知，不能隐式跳游标。Last-Event-ID 优先于 URL after。
发送受 drain/abort 约束；所属 bridge 仅在提交完成后唤醒读取，
仍保留一个唤醒标记和一秒外部变更校验。

Web 严格校验缺口、窗口与连续序列，显示保留条数和绝对尾序号。
实时列表最多 100 行、一个待执行帧；重复 gap 不清空已接受记录，
暂停、结束和故障文案不覆盖历史缺口。最后进入 DOM 的尾序号用于判断
淘汰边界；即将裁掉未展示记录时先刷新现有列表，retention/gap 同样先
展示已接受记录再删除。普通批次仍按帧合并，取消的旧帧不能覆盖新页面。

滚动离线问题包采用摘要 profile minor 1.2，以同一次读锁结果保存保留后缀、
公共锚点、完整 epochs 和逐条 clockEvidence。逐条依据使 session 超过 1 MiB 时，
minor 1.3 将时钟依据随事件存入 events.jsonl，读取后还原公共时钟数组；
原解码预算保持，旧读取器拒绝不认识的布局。公共锚点不暴露内部摘要。
导出 R2 审批绑定固定截点和保留前缀；后续追加不扩大截点，前缀淘汰使审批失效。
已淘汰截点和未来截点拒绝导出。离线分页及 Agent 保留绝对游标与可见缺口，
导入重算时钟和完整序列。格式见 [problem-package.md](problem-package.md)。

## 验证边界

`scripts/measure-debug-sustained.mjs <cli> <label> [seconds=15] [reconfirmSeconds=300]`
以私有 HOME、双 TTY 和明确的浏览器 session 测量真实 AEAD/SSE。
时长 10–600 秒，原始 ack、浏览器到达/DOM/下一帧、缺口、内存快照分别归档；
有界观察缓冲溢出会失败。重新配对间隔 10–300 秒，验证程序明确应用确认，
不取消密钥期限、帧数或产品认证门禁。样本缓冲不属于产品事件留存。
下一帧回调不能证明物理屏幕绘制，Node不能证明真实 Kit 或设备。
服务端采样观察到 100 条 SSE 页最多落后已提交位置 768 条；
完整读取持锁 P95 约 11 ms，竞争等待 P95 约 53 ms。
本地顺序排队修复后，30 秒短测含两次明确确认重新配对，21632 条全部
到达 SSE/DOM、无缺口，下一帧 P95 106 ms。确认停顿计入均速约 720 events/s；
首个十秒区间约 1073 events/s。证据为 `m2-sustained-io-r2/`、
`m2-sustained-lock-smoke-r1/`。
旧独立安装入口随后运行600.059秒，含一次明确应用确认续传，
601664条全SSE、零缺口、平均1002.675 events/s，下一帧P95 104.8 ms。
但1660条未进入DOM观察，全部桌面预算仍未通过；P95仅覆盖观察到的记录。
突发裁掉未展示记录的问题已修复。旧源码19项负控3失败/16通过，
新源码19项、相关69项、整仓2558/30及Lint/类型/构建通过。
真实浏览器128条负控和新构建10项检查保留，30秒19456条全SSE/DOM，
零缺口、下一帧P95 122 ms。新安装600.046秒、300秒明确确认续传，
585408条全SSE/DOM、零缺口/观察溢出、下一帧P95 104.4 ms，
服务/浏览器清理完成；均速975.605 events/s未达1K，全部桌面预算未通过。
样本为 `m2-render-overflow-installed-600-r1/`，不代表实际Kit或物理绘制。
原始长测在 `m2-sustained-lock-installed-600-r1/`，
修复证据为 `m2-render-overflow-r1/`。配额、密钥和单帧约束没有放宽。

有限并发安全读取的新独立安装长测600.059秒，300秒新邀请与明确确认续传，
642240条全SSE/DOM、零缺口/观察溢出，平均1070.295 events/s、
下一帧P95 96.600 ms，桌面预算通过。原始样本独立逐行对账，
5源码/17安装文件/6执行期文件哈希匹配，390/1280截图无水平溢出；
服务/浏览器清理完成，进程退出0。保留2624条和5159707字节，
4096条/5 MiB、100行/单待执行帧、密钥期限/65536帧限制保持。
证据为 `m2-parallel-read-installed-600-r1/` 和
`m2-parallel-read-r1/long-run-audit.json`。实际Kit、物理绘制、
设备/build认证和GA未验证，不由桌面预算提升可信等级。

`scripts/verify-debug-retention.mjs <built-or-installed-cli> <label> --browser`
在独立私有 HOME、空 npm 配置、双 TTY 和明确浏览器 session 中验证真实
Node 加密网络、超过 4096 条的淘汰、SSE、审批、恢复、任务及 Agent。
生产配额不调整。Node Producer 和桌面浏览器不证明实际 ArkTS Kit、
设备/build 身份、物理绘制或 1K events/s 十分钟负载。

`scripts/measure-debug-rolling.mjs <output> [batchSize=64] [count=8320]`
要求私有 `/private/tmp/ohmate-rolling-measure-*` 根、对应 HOME 和
`OHMATE_MEASURE_ROOT`；不读取用户配置。超过 4096 条、并发读取、重复淘汰、
最终序列/缺口/字节配额均为显式断言，原测量脚本保留。
8320 条同类 Node 加密负载从约 159 提升到 1098 events/s，读取 P95
从约 674 降到 105 ms；属于短测，不含 SSE 持续消费或浏览器延迟证明。
源码哈希、原始样本和失败负控在 `artifacts/validation/m2-rolling-perf-r1/`。
