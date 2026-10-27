# 单包窗口与面板合同

目标是让已启动的 Core 在宿主显式提供当前 UIContext 后获得应用内入口。
依据 Kit 最终合同 2.2、4.1、8 和 17；API 依据私有 API26 SDK。

- `HarmonyDebugWindowHost` 只查 UIContext 明确提供的窗口名，并核对窗口 ID；
  不枚举窗口、不回退主窗、不创建系统窗口。构造不获取资源。
- 当前窗口的尺寸、避让区、生命周期使用稳定回调。注册前保留注销责任；
  注销、overlay 移除、dialog 关闭或节点释放失败时保留原对象供显式重试。
  失效或销毁的上下文永久关闭显示授权；后台隐藏后只有显式显示可恢复。
- 浮动入口与面板通过当前 UIContext 的 ComponentContent 创建，分别按显示、
  打开动作延迟建立。单包 DebugWindows 继续负责有界等待、取消和迟到清理；
  平台宿主不建立第二套 timer、协议或 consent。
- 按钮是 48vp 圆形工具 Symbol，具有可访问名称和键盘焦点。单指拖动使用
  8vp 阈值与点击分离，松手吸附左右边缘；布局只保存相对边缘比例和侧别。
  不保存轨迹。窗口、键盘、系统区与至多 16 个业务避让矩形变化后重新约束；
  无可用空间时隐藏，错误几何不沿用旧可点击位置。
- 面板采用 V2 状态与 HDS 导航，Overview / Problems / Settings 按需显示。
  标准 ArkUI Button 承担圆形浮动入口，HDS 无对应拖动 overlay 控件。
  原生 dialog 提供模态、返回与焦点恢复；不构建独立系统窗口。使用系统
  深浅色、资源文案、可滚动内容及可换行按钮；不增加持续动效或高频轮询。
- 面板只展示 Core 摘要、问题 ID 和当前能力；暂停、恢复、标记、刷新、
  隐藏及关闭委托既有 Debug。ZIP 仍需两阶段 review/export，由宿主显式
  保存返回字节；没有保存宿主时不提供无效“保存成功”。破坏性操作不在
  这批新增 UI 中开放。缺 Provider/Bridge/Replay 时不推断已接入。
- context 门面组合原 OHMateCore、HarmonySandboxHost、OHMateDebug 和
  TestBridge。默认 Index/Core 不反向导入 UI。显式应用 Profile 始终是
  application-reported；编译/最终产物门禁缺失时不能授权 Release 或自动重放。
- `api/runtime` 的 OHMateRuntime 是 Debug/Test 的应用 context 门面。
  它与默认 OHMateKit 共用内部 ContextCoreOwner；不创建第二个 recorder。
  schema 在首次启动前登记，options/context/Profile 冲突不产生副作用；
  start 不找窗口。dispose 先撤销 UI 动作，再按原 owner 清理窗口、Provider、
  Test Adapter、Core 和文件宿主。失败清理只能显式重试，迟到启动不建立 UI。
- 原生宿主将 hidden/destroy/blocked 事件交给同一 DebugWindows owner。
  隐藏同步清除可见缓存；pending show/open 的后台完成不得恢复状态。destroy
  取消等待并保留原生责任至完成。UI 动作仅绑定当前挂载，busy 拒绝并发，
  解绑/销毁后异步结果不得更新旧模型；失败只显示受限回执码。

完成标准是实际 ETS 的窗口身份、几何、迟到/失败释放测试，以及官方 ETS、
源码 HAP/HAR 与 compiled HAR 消费。测试 shim 只证明宿主调用与责任状态；
真实 paint、触摸、返回/焦点、深浅色、大字体、读屏、键盘、横竖屏和多窗
体验分别保持 unverified，必须由目标设备验证。

## 快捷菜单、取消与配置更新

- 长按、右键与菜单键共用受控标准 Menu；只包含按当前状态选择的暂停/恢复、
  标记、隐藏。菜单没有预览截图，也不提供未接入的桌面发送或重放。
  拖动和长按互斥，菜单出现抑制同次点击；取消拖动恢复原位置，不提交侧别或比例。
- 菜单显示必须满足当前入口可见、几何有效、非 busy。菜单项重新检查此门禁，
  后台、解绑或迟到菜单不能调用 Core 动作。菜单“隐藏”先撤销菜单显示，
  原生消失后才执行这一次用户动作；后台、几何失效或解绑取消未执行动作。
  消失通知不重试失败清理；直接隐藏/解绑在通知前保留原浮动节点供显式重试。
- 宿主显式 `updateConfiguration` 在原 UIContext 的 scoped task 中通知原
  ComponentContent，再重算避让几何。Runtime 使用窗口 ID 定向调用，不读取
  应用配置正文、不枚举窗口；失败保留节点和注销责任，不恢复隐藏表面。
  更新共用 DebugWindows 的 256 次 effect 预算；配置通知重入控制返回 busy，
  detach 在原通知返回后才清理，不能释放正在更新的节点。
- SDK 配置通知不代表主题渲染或真实输入证据。

## 归一化位置与 Preferences

- `OHMateRuntime.attachWindow(uiContext, timeoutMs, positionKey)` 的第三参数是
  应用提供的稳定逻辑窗口键，限制为 1–32 位 ASCII 小写字母、数字和连字符，
  首位为字母。省略时只保留内存位置，`getPositionState(windowId)` 返回
  `memory-only`；原生窗口 ID 或名称不被当成跨启动稳定身份。
  不同活动窗口不能复用同一键，未完成清理的旧窗口仍占有该键。
- 每窗以纵向/横向/正方形和短边、长边的 `<600`、`600–839`、`≥840` vp
  尺寸桶隔离位置；每桶只有左右侧别和 0–1 边缘比例。切换桶先取消拖动，
  新桶使用默认位置，返回旧桶恢复其归一化位置并按当前避让区约束。
- Runtime 在首次键控挂载时获取自己的 Preferences XML 缓存，不订阅事件，
  不使用 dataGroupId。单一固定表最多 32 个逻辑窗口键、每键 27 个桶，
  ASCII 编码小于 64 KiB；宿主与每窗模型各有 256 次 lifetime I/O 尝试上限。
  默认 Core/Index 没有新增位置、Preferences 或 UI 反向依赖。
- 只有成功完成的实际拖动提交位置；点击、取消、无效拖动与布局调整不保存。
  用户操作、桶切换、后台、错误几何/配置或解绑使迟到读取失效；后台初次
  挂载不读位置，恢复前台后必须显式显示。恢复位置不恢复表面可见性。
- `put` 或 `flush` 失败保留原待写表，阻止竞争写入；`retryPosition(windowId)`
  是显式重试入口。较新的拖动保留脏值，较旧写入或重试不能覆盖它。
  后台后再次前台也不能让旧重试获取新的写操作。
  Runtime dispose 遇未完成 I/O 或失败 cache removal 返回
  `POSITION_CLEANUP_REQUIRED`，原缓存责任保持到显式 dispose 重试；不删除
  Preferences 文件，不将迟到完成当作释放证据。
- Preferences 接口依据 API26 `@ohos.data.preferences.d.ts` 的 Options、
  get/put/flush/removePreferencesFromCache Promise 签名及 Core SysCap。
  XML 的平台回执不证明物理耐久性、多进程互斥或跨设备恢复。
