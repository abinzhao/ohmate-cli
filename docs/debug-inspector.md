# 只读通道摘要查询

`debug inspectors` 描述协议的 17 个通道视图、支持字段、缺失字段和参考接口。
`debug inspect` 查询当前 cwd/工程所属的已保存 stream；无需设备、模型或浏览器。
Web“调试 → 通道摘要”和 Agent 使用相同查询。两项工具为 R0/read，
可以进入持久任务；配对、生命周期和其它 debug 管理工具仍走专用入口。

```bash
ohmatecli debug inspectors --format json
ohmatecli debug inspect <session-id> --stream <stream-id> --channel app.network --limit 100 --format json
ohmatecli debug inspect <session-id> --stream <stream-id> --channel app.network --after <nextCursor> --through <through> --format json
```

`id/stream` 必须为 UUID，channel 必须属于当前只读协议。`after/through`
范围为 0–4096，limit 默认为 100、最多 256。通过 `execute debug.inspect`
传 JSON 时字段同名；未知字段、重复 HTTP 查询参数及越界游标均拒绝。
HTTP GET 为 `/api/v1/debug/inspectors` 和
`/api/v1/debug/sessions/<id>/streams/<stream>/inspect/<channel>`，
后者仅接受 after、limit、through，要求工作台 Cookie 和相同工程范围。

读取先校验完整日志与独立 checkpoint，再筛选通道；截点外的损坏尾记录也会拒绝
整次查询。首轮解析当前提交数为 through，snapshotHash 是该位置的原日志哈希
（空截点为 null）。后续携带 through 固定范围；新事件不进入旧截点。
nextCursor 保持原日志位置，末页跳过无关通道到截点。count 是截点内此通道总数，
events 是本页原始已脱敏日志记录；records 以 index 关联逐条视图元数据。
视图元数据不参与原日志 hash 的计算，也不修改档案。

| 字段 | 含义 |
| --- | --- |
| availability | recorded / not-captured / not-negotiated；有握手不等于有采集 |
| coverageLevel | 逐条 summary-only；不提升为 request-intercepted 或 adapter-full |
| source / observation | peer-reported / registered；未验证实际平台调用 |
| referenceRole | reference-only；接口参考不证明本次调用或安装版本 |
| supportedFields | 摘要 Schema 支持的字段；可选字段可能未上报 |
| unavailableFields | 不能从现有摘要补出的树、正文、堆栈、时序或符号等字段 |
| samplingRate | null；未知采样率，不据记录间隔猜测 |
| clockCalibration | not-calibrated / per-record；records 与 clock.alignment 给出逐条状态，不以墙钟或旧 mergeable 标志强制跨端排序 |
| authentication | not-restored；历史查询不恢复设备配对 |

UI、ArkWeb DOM/Storage/Console 原文仍为 memory-only，查询只返回
`[MEMORY_ONLY]` 与计数等元数据。无指标时返回空页和未采集状态，不用 0
代替缺数据。设备与构建身份继续 peer-asserted/unverified。
API 参考按本机 SDK 声明核对，关联如下；没有证据证明这些接口生成了当前事件。

| 通道 | 参考来源 |
| --- | --- |
| app.network | @ohos.net.http · HttpRequest.request |
| arkweb.* | @ohos.web.webview · WebviewController.executeAIPageCommand / setWebDebuggingAccess |
| ui | @ohos.arkui.UIContext · UIContext.getUIInspector |
| hilog | @ohos.hilog · info |
| hiappevent / faultlog | @ohos.hiviewdfx.hiAppEvent · addWatcher |
| hitrace | @ohos.hiTraceChain · begin |
| hichecker | @ohos.hichecker · addRule |
| hidebug | @ohos.hidebug · getCpuUsage / getPss / getNativeHeapSize |
| instrumentation | @ohos.util · Aspect |
| jsleak | DevEco Studio Profiler；当前仅疑似计数摘要 |
| session / health / problems | 注册协议摘要；无官方 Producer 关联证据 |

完整 UI Inspector、ArkWeb DevTools、Profiler 仍由官方工具承担；当前视图
提供来源指引，尚未取得并关联官方采集端点。不生成模拟树、waterfall、火焰图
或根因结论。时钟测量与误差模型见 [debug-clock.md](debug-clock.md)。
后续需要真实来源接入、完整通道字段与专属设备互操作验证。
