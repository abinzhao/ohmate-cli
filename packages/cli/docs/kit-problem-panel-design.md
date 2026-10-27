# 单包问题详情与归档保存合同

目标读者是已通过应用内入口查看本地 Core 问题的开发者。默认 Core、公共
Index 和应用启动保持无 UI、Picker 或用户文件副作用。工程为私有 API26
消费者；设计继承 HarmonyOS 7 基线和既有 HDS/V2 面板。

## 详情与确认

问题列表选择明确 ID，在同一面板中展示事件数量、loss envelope、分诊及
证据边界。默认不显示事件字段值、路径、原始日志或附件内容。没有对应问题
时返回不可用状态，不能沿用另一个问题的摘要。

导出分为查看文件/字段清单、独立确认、系统 Picker 保存。Core
reviewArchive 的哈希绑定最终 ZIP 字节，exportArchive 再次校验已注册字段、
loss、分诊与清单。界面确认只对当前窗口、问题 ID、reviewHash 和有效期生效；
更换问题、后台、关闭、失效、取消或删除撤销旧确认。Picker 返回后和文件
副作用前再次校验同一批准；不能把 JSON review 或另一个窗口的确认代入。

删除分为查看目标与影响、独立确认删除。操作通过原 Core deleteProblem；
uncertain 结果保留原问题容量与不可导出状态，不能报告删除完成。已保存的
用户文件不属于删除范围，删除问题不能撤回它们。

确认区留在同一可滚动面板中，使用明确的取消和确认按钮，不叠加第二个
自绘系统弹窗。所有动作重查 live/busy 门禁，关闭和取消仍可终止等待。文案
使用资源，系统颜色和标准按钮继承当前主题。适用规则为 H7-D01 基线分离、
H7-D07 状态多线索，以及默认设计的状态、隐私、系统 Picker 与弹窗层级要求。
实际字号、读屏、焦点、返回、大字体和多窗需目标设备证据。

## 保存 owner

ArchiveSaveOwner 接收由上层完成两阶段批准的不可变字节副本；它本身不
认证 ZIP、设备或 build。构造无 I/O。最多 256 次 lifetime 保存尝试，
包括失败；取消不能重置预算。单次等待 100–30000 ms，共享当前尝试的
时钟/到期/取消门禁，时钟回拨或非安全整数永久关闭新保存。

超时和取消立即终止等待，原 Picker/open/write/close 未结束时保留原 owner。
迟到完成不续写、不自动清理或恢复批准。retryCleanup 只关闭原宿主资源，
有独立的 256 次 lifetime 清理预算和 100–3000 ms 等待；迟到清理仍需要
下一次显式重试确认。状态查询和新的保存不替代清理。

HarmonyArchiveSaveHost 使用当前 UIAbility context 和对应原生窗口实例。
DocumentViewPicker 的 autoCreateEmptyFile=false 避免在选择时预创建文件；
UserFileService、FolderSelection 或 FileIO SysCap 缺失保持 unavailable。
临时 URI 仅保存在原宿主私有字段，取消后的迟到 URI 不打开文件，不申请
跨重启授权，不使用 DOWNLOAD 模式。

原 URI 通过异步 READ_WRITE/CREATE/NOFOLLOW/NONBLOCK 打开；只接受空普通
文件，不 TRUNC、不覆盖非空文件。最多 256 次写，每块至多 64 KiB，ZIP
总量沿用 Core 256 KiB 上限，处理短写并在每个副作用前后重查批准。
原 fd fsync 和 close 全部接受才返回 SAVE_HOST_REPORTED。close 失败保留
原 fd；取消或写失败后部分用户文件继续保留，清理不删除或续写它。

平台回执不是原子发布、并发文件完整性、跨应用隔离、加密、物理耐久性或
安全擦除证明；用户保存文件也不能由撤回确认自动移除。

## 当前证据与剩余范围

保存 owner 12/12、私有真实文件加 SDK 替身 7/7。负例已证明关闭完成时的
过期保存不能被报告为成功，清理等待也必须有界。官方 API26 两个 ETS 检查
无 errors，保留五条 native write 异常传播 warnings，外层 owner 捕获并由
短写/异常/close 失败用例验证。

ProblemPanelModel 已接入既有 HDS/V2 面板，只展示数量、loss envelope、分诊
和固定文件/字段名。导出/删除各需独立确认，确认绑定原窗口、问题和30秒有效期。
保存每个门禁重新委托 Core exportArchive 验证原 ZIP 哈希；Core 删除或时钟
撤销后，迟到 Picker 不得写文件。复核临时字节在使用后清空，不证明物理擦除。

Runtime 保留原 UIAbility context 与原生窗口，后台、关闭、配置失败、销毁
和 dispose 均撤销批准。生命周期 detach 只查询保存责任，不能重试已失败的
close。显式 retryArchiveSaveCleanup(windowId) 关闭原 owner，失败/pending
阻止窗口、context 和稳定逻辑键释放，清理后再显式 retryWindowCleanup。
旧窗口捕获的操作不能影响相同 ID 的新挂载。

模型 15/15、Runtime 30/30、窗口 23/23、位置 13/13；RED 保留 Core 删除后
Picker 仍写、旧窗口回调影响新挂载及销毁自动重试失败 close 的证据。实际
官方 API26 五文件检查无 errors/40异常传播 warnings，最终两文件复检
无 errors/5 warnings；Lint 独立报告0 errors/7既有 warnings。
当前第02组Debug HAP/HAR编译、源码/资源hash、新字节码与声明核对通过。
最终双fresh、compiled-HAR消费、Release、包安装、真机Picker与设备体验
继续验证；局部SDK/shim证据不证明paint、物理耐久性或GA。
