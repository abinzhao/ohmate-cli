# 调试时钟测量

事件内的 `wallTimeUtc` 仅供显示；设备内排序使用同一 `clockId/bootId` 的
uint64 单调纳秒。旧日志的 `mergeable` 只是对端误差预算资格，不能证明校准。
CLI、Web、Agent 和问题包都以逐条 `clock.alignment` 的证据为准。

应用内确认后，Producer 在加密 ready 中声明
`clockSync:four-timestamp-v1`。桌面发送加密 `clock-probe`，Producer 回应
`clock-reply`；两者绑定 probeId、epoch 和原 t0，不允许重放或未知字段。
未声明支持的旧 Producer 不收到探针，新日志记录 `not-calibrated`。
探针十秒无回应会关闭连接，事件 ack 仍只在日志和独立 checkpoint 同步后发送。

| 时间 | 来源 |
| --- | --- |
| t0 | 桌面发送探针前的 `process.hrtime.bigint()` |
| t1 | Producer 收到帧时的系统 STARTUP uptime，包含深度睡眠 |
| t2 | Producer 构造回复时的同一单调时钟 |
| t3 | 桌面收到回复帧时的单调时钟 |
| receivedNs | 桌面收到事件帧时的单调时钟，排队前捕获 |

ArkTS 使用 `systemDateTime.getUptime(STARTUP, false)`，先检查安全整数，
再用 BigInt 转为纳秒。`precisionNs:1000000` 声明毫秒量化，不能因为输出
纳秒字符串就宣称纳秒采集精度。clock/boot 标识是应用本次运行别名，不认证硬件。

偏移定义为“桌面减 Producer”。在非负传输延迟模型下，原偏移区间为
`[t0-t1, t3-t2]`，不假定上下行对称。区间两端各加入
`2*precisionNs + ceil((receivedNs-t0)/1000)`，中心为 offsetNs，
半宽向上取整为 uncertaintyNs。后者明确采用相对漂移不超过 1000 ppm 的
视图假设，未测得硬件振荡器精度；假设不成立时不能作因果先后证明。

当前视图预算为 10 ms；五秒后请求新测量，十秒到期。changed epoch、
desktop clock、peer clock/boot、设备单调回退、桌面到达回退、事件早于测量、
过期、快于传输区间的明显漂移及超预算分别拒绝或返回不可合并状态。
新的 probe 和状态变化建立新段；墙钟跳变不改变设备内排序。
未知事件传输延迟不能用于检测任意慢漂移，导出的 assumptions 字段保留该模型边界。

日志保存原始测量和推导字段，读链和恢复重新计算。重配对只恢复历史记录，
不复用上一 epoch 的校准。离线摘要 minor 1.1 可包含 `session.clockEvidence`，
导入验证每条 clock、epoch、段号、offset、uncertainty 和映射；哈希重算不能绕过
推导验证。没有测量的 1.0 包仍保持未校准。

`calibrated` 只说明当前记录在上述模型与预算内有往返测量。
配对 proof、clock 测量、HDC 映射和 SHA-256 均不认证真实设备/build，
也不证明官方采集端点、采样率或平台密码互操作。重叠误差区间不代表严格因果顺序。
