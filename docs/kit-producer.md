# ArkTS 只读 Producer

`examples/OHMateKitProducer/` 是官方生成的独立 API 26 Stage Phone 示例工程。
它用于验证真实平台密码库、应用内确认和最小采集链路；不是已发布的
`@ohmate/ohmatekit`，也不代表完整 Kit、M2 或 Release 已验收。

## 应用内语义单步合同

`SemanticReplaySession` 使用显式 `ReplayAdapter` 描述符，只接受普通测试
动作、测试数据引用和命名断言；不反射调用、注入坐标或读取原始输入。
每条 R3 计划绑定 build/source、identity/epoch/代次/window、描述符、
负载及最早期限。三十秒复核、逐条确认与执行、1 Hz、256 次尝试和
不可驱逐墓碑；动作与断言共用最多三秒等待，每条都断言，偏差中止。

准备副作用前登记恢复责任。取消或超时只结束调用端等待，未结束的宿主
动作仍占有责任；结算后尝试一次恢复，失败或结果未知仅显式重试。
来源漂移包括恢复派发前的漂移，永久拒绝向新来源恢复；返回旧来源不能
复活资格。dispose 保留待恢复宿主，成功清理后释放页面引用。
执行清空旧 UI/DOM/Storage/截图及未保存导出，未解决责任阻止新采集、
注册和配对。最新命令、断言和恢复状态只在内存，不进 frames/日志/ZIP。

页面显式注册固定、可逆的 `test.marker`，复核/允许/执行/停止/重试分别
触发。当前 Producer 的 `unverified:` buildId 没有本地产物绑定，入口
保持不可执行并提示人工步骤；邀请重复同一 buildId 不改变资格。
桌面 `replay plan --path <zip> [--steps <file.ohmate-replay.json>]` 校验原包及
有界语义文件，以原始哈希绑定只读计划。缺 Adapter/本地构建证据时每条
是人工步骤；不从事件文本推断动作，不执行文件中的代码。
系统交互仅人工，授权、真实删除、支付、发布、上传、分享、系统设置均拒绝。
所有远端写范围继续 unavailable。实际 Phone、route/业务 Adapter、
宿主异步执行/恢复和 build 认证仍待专属目标验证。

## 应用内 UI 轮廓设计合同

现有 API26 Stage Phone、HdsNavigation/V2 和默认安全区中，宿主通过
`registerUi` 第五参数显式提供 `UiHighlightHost`，默认缺失即不可用。
仅允许当前 `bridge_capture_root` 下的固定说明节点 `bridge_snapshot_target`。
FrameNode 来源检查最多32层祖先、系统 uniqueId、附着、可见和正尺寸；
不读 Inspector/文本，不扩展 lazy 节点或修改原生节点属性。不同查询可返回
不同代理对象；以系统 uniqueId 校验祖先。来源hash不包含可变页面位置。

UiHighlightSession 绑定单条 R2 commandId/idempotencyKey、负载/计划hash、
来源/窗口/identity/epoch/代次和最早连接期限。复核最多30秒，轮廓最多3秒，
256次尝试包含失败，命令墓碑不驱逐；每秒最多执行一次且许可单次使用。
复核、允许、执行、取消、清理重试分别触发，不能自动确认或延长期限。
效果前登记清理责任并撤销旧UI、截图和未保存导出。页面只切换固定2vp
边框的透明/系统强调色，不更改文字、焦点、触摸和业务节点。

有效期内每250ms及同步status检查来源。来源/Debug/身份/epoch/窗口、
后台/断连/到期/回拨使许可失效；观察到的来源漂移不能因返回而复活。
只清理同一commandId；宿主抛错或拒绝保持未完成责任和宿主引用，
禁止新配对/注册/采集且仅显式重试。责任状态在连接区域外持续显示。
宿主接受状态只证明回调返回，不证明原生轮廓渲染、遮挡、paint或设备/build
认证；所有远程写仍不可用。真实Phone原生节点、前后台、窄宽、大字、
读屏和深色需另行运行验证，Node替换平台和HAP构建不能代替。

## 应用本地 Storage 设计合同

沿用 API26 Stage Phone、HdsNavigation/V2 单页、系统语义资源与安全区。
当前固定 Debug loopback Web 保持 incognito，domStorageAccess 默认关闭。
先实现当前精确 URL 的公开 Cookie 元数据读取：应用内显式触发，
WebCookieManager.fetchCookie(url, true, false) 排除普通持久上下文与
分区 Cookie；调用前后核对实际 isIncognitoMode、URL、document revision、
当前 Debug、配对 identity/epoch/代次与协商 channel。原生字符串只在
投影期间临时存在，最多4 KiB有效UTF-8、64个键值对，仅保留项数和固定
掩码；名称、值和原生异常正文不进入状态、frames、journal、ZIP或日志。
不推断 HttpOnly、Secure、SameSite、domain、path、expiry 等字段，
也不将同名 Cookie 合并或把 URL 相关列表宣称为单一页面独占存储。

每秒最多一次读取、连接内累计256次尝试，快照只在内存保留三十秒且不
超过连接期限。失败、取消、导航、后台、断连、到期、回拨、隐私模式或
来源变化清空快照。三秒超时只停止等待，原生操作到 settlement 前仍
占用同一 Web owner，阻止重复读取、Console、DOM、截图、注册和配对。
晚到结果不投影；状态区分空闲、读取、完成（包含0项）、失败和超时，
提供清除/重试，不能自动恢复采集或授权。

读取本身不发送；单独的“发送掩码摘要”只允许本次有效读取发送一次，
共用采集 owner、绝对序号和单 ACK，不重读 Cookie 或延长原始期限。
事件仅有 targetId、entryCount 和同源生成的固定范围说明；0项也构成
一条摘要。终端 `debug inspect <id> --stream <stream> --channel arkweb.storage`
显示数量及未采集范围。发送后桌面可保留摘要历史，清空应用内存不撤回
历史。`webStorageFile()` 只返回当前且发送成功的防御副本，声明
WebCookieManager.fetchCookie / platform-api / peer-reported；不是已确认 ACK
历史或真实 API 调用认证。
应用显式导出复核纳入当前已发送摘要至生成路径 arkweb.jsonl；
`replay show --path <zip> --domain arkweb` 验证全部包后返回领域页。
读取替换、失败、取消、导航、后台、断连、到期、回拨和来源变化清除本地
文件及含 Storage 的未保存 ZIP。Picker 等待与 FileIO 前再核对；已保存
文件归用户所有。无名称、值、属性、其它 origin、配额或原异常正文入包。
本轮不提供原值解锁或保护存储，仅发送和显式导出上述有限元数据。

localStorage/sessionStorage 仅在配对前由宿主显式开启；示例限定普通测试键
`ohmate-test-local` 与 `ohmate-test-session`，允许关闭但不能在已配对时重新
开启。断连/后台清除该页面的许可；读取本身不创建、修改或删除测试项。
注册契约为 `ControlledStorageAccess`，默认缺失，不超过16个不同的
area/key，ordinary 声明及 `ohmate-test-` 前缀，注册时防御复制。
当前宿主 enabled 回调每次重查；许可不是平台设置生效或捕获认证。
固定 getItem 脚本经 `runJavaScriptExt` 只读取当前精确 URL 的这些键；
严格检查返回类型、URL、键顺序、数量、字段、有效UTF-8与空值。
每项值最多1024字符、整个投影最多4 KiB UTF-8；不枚举、搜索其它键或
修改 Storage。缺失 null 与空字符串区分，只显示两个领域的存在项数。
原值仅在同一读取 owner 的私有内存存活至原始三十秒期限，用于后续逐项
复核，不提供原值展示、解锁、发送或导出。清理释放引用，不宣称字符串
物理擦除。Cookie 与页面 Adapter 共用每秒一次/256次尝试预算和原生锁；
撤权/失败/取消/导航/后台/来源漂移/到期/回拨使快照失效，晚到结果不读取。
读取替换会撤销旧 Cookie 摘要及未保存导出；不撤回桌面历史或已保存文件。
Cookie摘要的固定未采集范围不变；仅在测试键权限关闭时读取/发布Cookie。
许可变化使旧Cookie快照失效，不能用该摘要发送页面 Adapter 的计数。
页面 Adapter 的声明来源为受控页面脚本，不使用 Cookie 平台来源代替。
IndexedDB、Cache Storage、WebStorage origin/quota/usage 保持未采集。SDK WebStorage
对象为所有 Web 共享，读取接口没有隐私模式/实例参数，Web SQL 在 M132
后失效；不枚举其他来源或拿旧数据库配额代替当前页面证明。
独立原值逐项复核及逐命令 R3 写入只允许宿主声明的普通测试项，
确认绑定原值/计划/来源与期限；原生副作用发生前登记恢复责任，
冲突或未知执行结果不能自动覆盖新值或清除所有来源。
Cookie 全局清空、Storage/origin 全局清空没有本轮入口。应用本地确认
不提升未知 device/build 认证，也不接通任何远程写 scope。

Text/Button 沿用系统语义字号/颜色、48vp热区、默认安全区与可滚动布局，
常驻展示来源范围、不可采集项和掩码计数，不展示真实 Cookie。
H7-D01/D03/D07、C01/C06/C07、A01/A02/A03、I04/I05/I06、
E01/E06、Q01/Q02/Q03 沿用规则索引来源等级。前置合同已检查状态、
来源、隐私和恢复路径；替换平台TDD、官方ArkTS/Lint、两unsigned HAP
与终端/Runtime回归分别取证。Phone窄宽、大字体、读屏、深色、实际
Cookie返回与ArkWeb生命周期未验证。只读摘要与导出沿用既有公共Schema，
固定来源说明从桌面定义经生成器同步；替换平台测试不能证明设备运行。

## 应用本地 Storage 单键写入设计合同

API26 Stage Phone 的既有 HdsNavigation/V2 页面在读取后提供两个测试键选择，
以及固定字符串 `ohmate-local-test`、空字符串、删除三种操作。读取和页面
选择没有写副作用；独立复核显示键、创建/替换/删除语义、命令、原值/负载/
计划哈希及最早截止时间，再单独确认、单次执行。空字符串保留键，删除使
键缺失，缺失原值恢复时删除键；原值不显示或进入 UI 状态。示例界面不提供
任意键或任意值编辑；宿主接口只接收既有 ordinary allowlist 内的单键。
标准 Select 与纵向 Button 承载选择和每个独立步骤；HdsActionBar 以图标
按钮和固定主按钮宽度为主，不适合此处多段长确认文字及窄屏可滚动操作。
沿用系统文字、语义色、48vp最小热区和默认安全区，关键结果常驻且不依赖
颜色。无新增路由、依赖、权限、存储、动效或自动写入。

StorageWriteSession 按桌面 WriteSession 合同保持单次命令墓碑、256次
复核预算、1Hz执行及绑定原始捕获期限。固定比较/修改/验证脚本只对一个键
操作，恢复仅接受尝试写入值或已恢复原值，不覆盖其他并发值。副作用前登记
责任并清除旧读取/DOM/未保存导出。取消/执行超时先失效，原生锁保留至真实
settlement；允许迟到apply的条件恢复，不允许迟到restore认证为成功。
恢复超时/失败只由用户显式重试；取消不会自动重试失败恢复。

原值、替换值及应用持有的临时投影对象引用于原始30秒期限清除，不延长以
等恢复。PlatformWeb 在原生派发后释放本地脚本引用；原生引擎自己的脚本
及字符串物理擦除无保证。已观察到的来源/identity/epoch/页面/许可漂移和
时钟回拨永久撤销恢复资格，来源回归不能复活。dispose清引用但保留责任。
过期、漂移、停止或未知原生结果后，状态持续显示未完成恢复，阻止新读取、
Console、注册及配对；不能承诺关闭权限或断连后仍可恢复。
页面在connected区外持续显示该责任，并提供取消和显式恢复重试；不可恢复
时提示原值已清除或来源已失效，保留责任状态。恢复前保持当前页面与权限，
关闭权限是撤销而非恢复保证。

H7-D01/D03/D07、C01/C06/C07、A01/A02/A03、I04/I05/I06、
E01/E06、Q01/Q02/Q03沿用规则索引分级。TDD覆盖真实普通页面方法和应用
owner；ArkUI build、官方静态/Lint和两unsigned HAP单独取证。Phone窄宽、
大字、读屏、深色、实际local/session操作与恢复、原生生命周期和完整
设备/build/crypto/transport仍未验证；替换平台不作为真实页面体验通过。

## 应用本地 Console 设计合同

沿用 API26 Stage Phone 单页、HdsNavigation/V2、安全区与系统语义资源。
宿主 `registerWeb` 默认不允许执行；示例仅为固定 loopback 受控测试页显式
允许。任意第三方、账号、支付、凭据和未知页面不能注册；每次复核、确认、
调用前和结果返回后都检查当前 Debug、连接、identity/epoch/代次、页面
revision 与精确 URL。应用内确认不升级远程 device/build 认证。
Console 消息核对 SDK `getSource` 枚举、精确页面或固定脚本 `getSourceId`、
有效行号和级别；原消息、原 URL、参数和异常描述不留存。来源类别、
page/script角色与行号按严格固定语法保留在脱敏摘要，桌面和应用导出
均校验范围，额外字符串和frame声明仍掩码或拒绝。frame、列号和
Promise rejection 归属没有公开证据时保持未验证，不编造来源。

独立输入、复核、逐命令确认、执行、取消，常驻显示阶段、命令和类型摘要。
标准 TextArea 用于多行脚本，HDS 没有对应脚本编辑组件；最多4 KiB UTF-8，
拒绝无效编码。最多256次复核（失败也计数），随机128位命令 ID；计划绑定
原代码哈希、目标、连接/页面与期限，TTL最多十分钟且不超过连接期限。
确认不能续期；同一命令最多调用一次。原生操作占用期间禁止另一项 Console、
DOM、截图、注册和重新配对；取消、导航、后台、到期或回拨先撤销。

`runJavaScriptExt` 三秒超时仅结束等待，保留原生 owner 到实际 settlement；
不宣称中止脚本或回滚页面副作用。字符串结果最多4 KiB、累计64 KiB，只保留
类型/字节和固定掩码；有限数字和布尔只保留类型，数组/ArrayBuffer/对象/
异常保持不支持，不读取其正文或错误描述。迟到/旧页面结果丢弃，异常只用
固定原因。代码、结果和本地回执不进入帧、journal、ZIP、日志或持久存储。
执行前清空旧DOM快照和冻结导出计划，同URL的脚本也可能改变页面。
页面编辑即取消旧计划，离页/断连清空输入；空闲、复核、确认、运行、
完成、失败、超时和撤销均有状态及恢复入口，不自动恢复授权。

H7-D01/D03/D07、C01/C06/C07、A01/A02/A03、I04/I05/I06、
E01/E06、Q01/Q02/Q03沿用既有规则索引分级。前置检查覆盖真实消费者、
状态、48vp热区、资源/标签与内存边界；TDD、官方ArkTS/Lint/两unsigned HAP
分别验证。真实Phone窄宽窗口、大字体、读屏、深色、ArkWeb来源/返回值/
超时与原生脚本副作用未验证，静态/API编译和替换平台测试不能替代。

## 应用本地资源覆盖设计合同

`arkweb.resources.override` 只消费宿主在注册 Web 时提供的固定内存资源
allowlist。默认空表；不读任意文件、凭据或远端内容。每项精确
URL、ordinary 声明、UTF-8 正文和 MIME 在注册时复制，随机128位资源 ID
只在内存中使用。最多32项、单项64 KiB、合计256 KiB；本轮只接非主frame、
非重定向的 GET、text/plain 或 text/css，未知/敏感来源保持透传。SDK
`onInterceptRequest` 不提供发起frame、资源类型或 POST Data，来源保持
registered-allowlist/request-intercepted、frame/type 未验证，不宣称全量网络。
浏览器请求头数组只临时读取名称；认证/Cookie及未知名称拒绝，不读取值。

复核显示目标、资源范围、字节数、预计命中和期限；计划绑定原规则/样本
哈希、资源正文哈希、当前页面revision、identity/epoch/代次和注册owner。
最多256次复核（失败也计数）、128个样本、128次命中、累计响应1 MiB，
TTL最多十分钟且不超过连接。重复确认不续期或重置。撤销、错误复核、
页面重建/跳转、断连、后台、到期和回拨先失效，不恢复旧授权。
一次性响应完整设置状态/原因/MIME/UTF-8、安全响应头和ready；不改宿主
拦截链，未选中时调用原宿主回调并保留原返回与异常。选中后构造失败
抛出固定错误并撤销，原宿主回调不会补发；平台如何处理回调异常仍待运行
验证，不能将此描述为已验证的原生网络阻断。
构造前后重查基本请求字段、全部允许头名称和owner；变更即拒绝旧响应。
撤销只移除未来替换；已经返回的响应不能收回，不把这描述为网页状态回滚。
内存资源仅覆盖响应，不作为stylesheet插入或执行；脚本、HTML、媒体、
延迟与 Network Mock 文件/分块仍未实现。

宿主可通过 `registerWebFiles` 声明显式打包文件清单：仅
`ohmate-resources/` 下单层 css/txt，精确 URL、ordinary、MIME、字节数和
SHA-256。最多32项/单项64 KiB/合计256 KiB，先检查 raw descriptor
长度/偏移，再用 lseek 与最多4 KiB的 readSync 分段读取；正文必须是
无BOM且可往返的UTF-8：解码前拒绝原始EF BB BF文件头，不依赖
解码器默认值，保留正文内U+FEFF；hash由原始字节对应的文本核对。
所有descriptor由原ResourceManager按精确名称关闭，关闭成功才注册；
失败保留该owner并阻止配对，只能显式停止重试，不读取其它路径。

`schemeOwned:true` 由宿主明确授予专用Web实例的全部scheme所有权，
页面在 `onControllerAttached` 注册HTTP handler。未授权宿主保留一次性
回调。流仅选精确GET/当前frame URL/空referrer（工作台no-referrer策略）/
STYLE_SHEET或XHR/null请求body stream/允许头名称。SDK没有redirect
字段，coverage保持scheme-handler/frame-type-checked/redirect-unverified，
不能声称完整代理、请求正文或requestInStream捕获。
最多四个有正文请求、4 KiB分块，沿用128命中/1 MiB响应总额；溢出撤销
授权并结束选中请求。每个native buffer保留至精确request-stop和所有
重入native调用返回后清零；finish/abort/clear成功不替代这个释放信号。
取消、跳转、到期和停止阻止后续分块。失败abort/handler清除保留准确
owner，后台不自动重试；阻止换Web与配对，显式停止可重试。
clearWebSchemeHandler会清掉该实例全部handler，因此只允许专用宿主
实例，不接管其它应用handler。native请求对象身份和释放行为仍待真机。

沿用API26 Stage Phone、HdsNavigation/V2和单页滚动。页面独立复核、
确认、取消，常驻阶段/命中数；固定 `/kit-readonly.css` 使用28字节打包
注释文件，页面核对固定hash后启用流。读取失败关闭准备流程，无明文兜底。
现有受控测试页增加显式fetch按钮，关闭缓存/凭据/重定向，只显示固定
结果并取消未读正文，不修改stylesheet、不记录日志或发送原正文。
应用内确认不认证device/build，也不接远程写入。
Text/Button复用系统语义字号/颜色、48vp热区、默认安全区；范围不可复制。
H7-D01/D03/D07、C01/C06/C07、A01/A02/A03、I04/I05/I06、
E01/E06、Q01/Q02/Q03适用，官必/API、官荐和项目默认等级沿用规则索引。
前置合同完整；替换平台逻辑、官方Lint/ArkTS及两unsigned HAP分别验证。
测试页静态资源变化须重新五包构建/catalog和独立安装入口。真实ArkWeb
回调顺序/请求头、Phone窄宽窗口/大字体/读屏/深色/后台仍未验证。

## 应用本地 Mock 设计合同

本轮范围是已注册 `PlatformNetwork` 的应用本地 `network.mock` owner，
不是远程写准入。沿用 API26 Stage Phone 单页、HdsNavigation、V2 状态与
Text/Button；不增加权限、依赖、路由、文件资源或全局 HTTP 拦截器。
`NetworkMock.ets` 已接入 Controller、注册适配器和单页操作；验证结果
单独记录，合同和 Node 替换平台回归不作为真实平台已通过的证据。

规则沿用桌面 version 1 的精确 target/origin/method/path/header/resourceType、
优先级顺序和固定响应/确定性文本模板/延迟/超时/网络错误子集。文件、分块、
流式、未注册实例与三方客户端仍未支持。最多32规则/128样本、UTF-8规则
与样本各256 KiB、固定正文单条64 KiB，响应与匹配头名称使用既有白名单。
不读取或修改认证、支付、上传、删除、未知分类、query、请求正文、
自定义方法或客户端证书请求。宿主需明确声明普通 fetch/xhr。
本轮固定响应要求显式 STRING 返回类型，并遵守宿主 maxLimit。
模板响应使用 `template` 与 `variables` 代替 `body`；仅展开 `{{test.name}}`
引用的显式字符串变量，不读取请求、环境或文件，不执行代码或递归展开。
模板最多16 KiB、16变量/每值2 KiB、64处引用；正文64 KiB，整表展开
最多256 KiB。变量必须全使用，缺失/非法语法/无效UTF-8/HEAD非空拒绝。
复核计划增加每个响应及渲染正文的hash，只保留hash/标识/计数。

新规则先在应用内 dry-run：显示预计命中、目标、TTL、来源与边界，再逐
scope 确认。计划绑定当前身份/epoch/代次、目标、规则及样本的原文和
规范哈希、表revision、期限；错误哈希不授权，重复确认不重置期限或
计数。最多256次复核、每次最多128命中/8个并发延迟、最长十分钟且不
超过连接期限。新复核、取消、后台、断连、到期、身份变化或时钟回拨
先使旧owner失效并清空规则，不恢复旧授权；延迟期间失效抛固定取消错误，
不返回旧合成响应、不自动补发原生请求。宿主仍负责 native destroy。
JSON 解码后的路径、正文与头值也校验 UTF-8；延迟结束重新核对匹配参数、
全部允许的头值和宿主 maxLimit，发生变化即取消。复核失败也消耗256次
尝试额度；选中后命中/延迟/正文额度错误不补发原生请求。

匹配响应带 application-local-mock 来源和 ruleId，不能被当成平台采集。
不进入原生请求摘要、正文预览、frames、journal或ZIP。SDK强制的
performanceTiming的十个字段使用 NaN 表示没有原生测量；不构造网络耗时。
未命中与不支持的请求按原URL/options调用已有native request，原响应
与抛出对象保持一致；既有 interceptor chain 不被替换或重建。
状态及审计只在内存中保留哈希、计数、阶段与固定原因，不保存正文或头值。

页面提供一个固定loopback普通GET模板场景：查看范围、确认启用、显式
运行测试、核对完整STRING结果、关闭Mock；常驻显示启用/待确认/已关闭/
失败状态与命中数。
与HEAD/正文测试共用本次一次性请求额度，测试完成后需新连接再次测试。
复用系统语义颜色、字号、48vp操作高度、默认安全区与滚动，范围和
结果不允许复制；取消与配对撤销独立，故障不泄露系统错误正文。
H7-D01/D03/D07、C01/C06/C07、A01/A02/A03、I04/I05/I06、
E01/E06、Q01/Q02/Q03适用。前置静态合同完整；逻辑以失败用例及替换
平台回归验证，SDK以ArkTS/Lint和两个unsigned HAP检查。真实平台运行、
手机窄宽窗口/大字体/读屏/深色/后台生命周期尚未验证。

## 临时正文采集设计合同

沿用 API 26 Stage Phone、HdsNavigation 和单页滚动布局。开发者先复核
当前连接中一个宿主声明的普通 GET 请求范围，再明确允许三十秒内的
响应正文采集；取消、后台、断连和到期清空。确认绑定身份、连接 epoch、
目标、规则哈希和当前所有者代次，不扩大为远程写授权。

范围仅为精确 origin/path、JSON 或 plain text、单条最多 64 KiB、
累计最多 256 KiB、32 条；只保留最新一份脱敏预览。所有字符串值、敏感
键值、绝对值至少一千万的数字和 plain text 保守掩码，不额外保留原始报文。
这不保证未知数值字段的语义去标识。非 UTF-8 文本、查询串、敏感或
未分类请求、重定向来源不确定和未知响应类型不采集。业务请求、异常、
原始响应和已有拦截链由宿主所有，不因观察失败而改变。

页面复用当前 Text/Button、系统语义颜色与字号、48 vp 最小操作高度；
展示关闭、待确认、已启用、已清空和失败状态，范围与掩码预览不可复制。
H7-D01/D03/D07、C01/C06/C07、A01/A02/A03、I04/I05/I06、
E01/E06、Q01/Q02/Q03 适用。静态检查合同与资源，替换平台的测试检查
确认/撤销/透传和预算，真实模块检查 API 与编译。手机窄宽窗口、大字体、
读屏、键盘避让、后台与真实 HTTP 响应仍需专属获授权运行目标验证。
正文不进入帧、journal 或 ZIP，缺少保护存储时只驻留内存。

## 当前实现

- `PlatformCrypto.ets` 使用 CryptoArchitectureKit 的 ECC256/SPKI、ECDH、
  HMAC-SHA256、HKDF-SHA256、AES256-GCM，使用平台随机数；密钥仅驻留内存。
  GCM 加密返回值的末尾 16 字节拆为 tag，解密单独传入 tag。
- `Wire.ets` 严格解析邀请、身份、能力和预算，仅接受
  `ws://127.0.0.1:<port>/bridge/v1`；代理显式关闭。此 WebSocket 传输承载
  应用层 AEAD，无 LAN 或明文载荷降级。
- `PairingSession.ets` 完成双向 proof 和方向密钥，验证 counter、AAD、
  connectionId、期限和帧上限；失败关闭，不自动恢复认证。
- `ProducerController.ets` 持有唯一连接和撤销代次。消息串行处理，最多排队
  8 条、单条 100000 UTF-8 字节。确认前不连接；双方加密 ready 完成后才采集。
  ready 显式发送 `eventBatch:events-v1` 与 `retention:rolling-v1`，connected
  必须精确回显模式和 epoch；缺失、错误或额外字段均停止连接，不启动采集。
  个别事件仍逐条发送，频率和 ack 约束不变；示例没有自动续传或透明重连。
- `hidebug.read` 通过 TaskPool 调用 `hidebug.getPss()`，按 SDK 的 KB 单位
  以 bigint 转为字节，拒绝负数及超出安全整数的读数；该指标包含 Pss 与 SwapPss。最多每秒采集一次，等待连续 ack
  后再采样，10 秒未 ack 断开并保留待确认序号。按需 UI 摘要共用单条 ACK
  和绝对序号，但不计为丢弃的 PSS 样本。没有自动正文、日志、Storage、
  截图或重型 DFX 采集；正文、DOM 和显式截图的独立范围见下文。
- `hiappevent.read` 仅在支持 SysCap 且协商后提供独立启动按钮。用户启动
  一个随机唯一合法名称的 Watcher，原生过滤 OS APP_CRASH/APP_FREEZE；
  add 的 null/undefined/异常和同步回调均不算采集。回调只观察白名单名称与
  合法类型，不读取 params、堆栈、日志路径或附件，不发送、不移除订阅。
  每回调最多检查 32 组和 32 条事件，队列最多 32 条，超限、无效和替换
  计入 dropped。`dfxFile()` 只保存最近发送的防御性摘要，时间是回调观察
  时间，不能证明故障发生时间；崩溃通知可能到下一次启动才收到。
  后台、到期、撤销先失效再移除，移除失败保留 owner，阻止重新配对，
  再次撤销可重试。不自动读取旧 faultlog、恢复订阅或认证。
- CPU 通过独立按钮在 TaskPool 调用 `hidebug.getCpuUsage()`，有限非负读数
  乘 100 转为进程百分比；没有默认自动轮询、平均区间或线程用量声明。
  CPU/PSS/UI/Web 共用采集与 ACK owner；迟到、失败和到期结果不保存。
  原生 TaskPool 未返回时即使已撤销仍保留 owner，禁止重配直到结束。
- 页面在邀请复核前注册 `UIContext` 与 `bridge_capture_root`。只有已注册、
  支持 ArkUI.Full 且协商成功时开放 `ui.read`；用户点击后读取本页最多 256
  个已展开节点、深度 32，使用 API26 `ONLY_EXPANDED`/`NOT_EXPAND`，不展开
  LazyForEach，不读取文字、输入值、Inspector 属性或任意应用 ID。
  系统 uniqueId 生成节点别名，组件类型只保留白名单，其余为 `Component`。
  桌面实时摘要只有范围、节点数量和固定说明，本地 `uiFile()` 保存一份
  防御性结构副本，平台来源声明为 peer-reported。下一次读取替换旧树并报告
  丢弃节点数；失败、撤销、后台、到期或注销清空。迟到发送与读取都同步
  检查期限，不依赖到期定时器。窗口坐标是 vp，尺寸从 px 经当前 UIContext
  换算为 vp；字段标明单位与原点。`isVisible()` 仅是 visibility 属性，
  不证明遮挡、变换后的边界、同帧或实际送显。拒绝失效/离树节点和非法数值。
  来源列出实际几何 API；当前 Schema 可选字段与精确旧 UI Schema 均可读。
- `PlatformScreenshot` 仅截取宿主明确允许的固定说明区域，默认禁止截图，
  不截整页或配对信息。已协商 UI、支持 Image Core/Packer 后再单独复核，
  复核有效三十秒；通过 uniqueId 截图并校验所属子树和异步后的来源。
  最长边最多 512 px、PixelMap 最多 1 MiB、PNG 最多 256 KiB，不打包
  Exif/图像属性。三秒停止等待，未结束原生工作仍拥有资源；结束前不能再次
  采集或配对，超时结束后恢复共用摘要调度。释放失败保留 PixelMap/Packer，
  显式撤销可重试，后台后的迟到释放失败仍显示 cleanup-failed。
  PNG base64 只在应用内存预览三十秒，取消、后台、撤销或到期清空；
  不进入事件、journal 或 ZIP。例工程没有平台保护截图存储，因此不提供
  截图写盘或附件导出。真实截图、几何/可见性和 UI 尚未运行验证。
- `registerNetwork` 注册一个宿主拥有的 `HttpRequest`，`PlatformNetwork.request`
  调用真实 `HttpRequest.request`，原样返回响应和异常，不修改项目已有的拦截链。
  默认只观察方法、状态码与 STARTUP uptime 耗时；不读取 URL、请求头、正文、
  cookies 或 performanceTiming。确认和 `app.network.read` 协商后才记录，
  同时保存完成时刻；确认前、撤销后、跨代次和到期的结果不记录。
  最多排队 32 条完成摘要，超限丢弃最早一条；与 PSS 轮流发送，自动事件
  合计最多 1 Hz，共用单条 ACK，避免持续请求使 PSS 饥饿。
  `networkFile()` 是最近发送的一条防御性副本，标为 registered-adapter、
  peer-reported、summary-only；dropped 包含超限、无效采集和替换本地摘要。
  读取同步检查期限；失败、后台、撤销或注销清空队列、文件和请求引用。
  业务请求仍由宿主销毁；没有接入其它实例、requestInStream、RCP 或三方 SDK。
  示例页明确注册单独测试请求，用户可向已确认的 loopback 工作台发送 HEAD，
  正常返回 405；`usingProxy:false`，3 秒连接/读取超时，1024 字节接收上限。
  页面关闭销毁该请求，失败保留对象阻止替换；迟到响应不能更新新请求状态。
- `NetworkBodyCapture` 对同一已注册请求提供独立的应用内范围复核和确认。
  规则绑定当前身份/epoch/代次、`network-main`、规则哈希和到期时刻，
  同一 owner 最多复核 256 次；重复确认不会延长期限或清零预算。
  请求默认 unknown，宿主必须明确标记 ordinary；仅精确 GET、无查询、
  无 body/extraData/queryParams/上传、仅白名单头名称、禁用缓存及重定向可采集。
  原生结束后再次核对请求范围，要求 API24+ redirectCount 明确为零，
  只读 content-type、STRING 与 2xx/4xx/5xx 响应；3xx、401/402/403 拒绝。
  UTF-8 大小先于投影验证，JSON 最多 256 节点、32 层和标识符键名，
  所有字符串、敏感字段及较大数字掩码，plain text 整体掩码。
  原始业务响应与异常不变，临时编码字节清零，最新掩码预览仅在内存。
  后台、撤销、时钟回拨、到期与新复核使旧 ticket 失效，不接远程控制。
  来源仍是宿主注册的局部 Adapter，不保证任意三方拦截链未改写原始 URL。
  页面采用三十秒/1024 字节规则，复核后发送一次已确认 loopback
  `/ohmate-body-sample` GET，缺失静态资源返回固定 404 JSON；与原 HEAD
  测试二选一消费同一一次性原生请求，下一次需新连接。无新资源路由、
  账号、权限或依赖；正文不进入事件、ZIP 或存储。实际 HTTP、redirectCount
  和 Phone 确认/预览尚未运行验证。
- `registerWeb` 绑定一个系统 Web 实例，仅加载已确认 loopback 的固定测试页，
  incognito 模式且关闭 domStorage。API26 `getFullDom` 按需读取，原生结果默认
  仍带 URL/标题/文字/属性；临时白名单提取类型和树关系，限制 65536 字符、
  256 节点与深度 32，不保留原生 ID 或文本。每次快照生成新别名，重建、
  撤销、到期和来源变化使旧文件不可读。3 秒等待超时不取消原生请求，
  实际结束前禁止重读、重新注册和复核；发送失败立即撤销连接。
  Console 核对原生来源类别、固定页面/脚本路径、行号和级别，只保留受限
  来源元数据与掩码；frame/列号未验证。主导航仅主 frame 的
  STARTUP 回调间隔，无 HTTP 状态或完整网络覆盖。确认前开始的导航不记录。
  Web 完成队列最多 32 条，与 HTTP、DFX 轮转，再与 PSS 交替，共用单 ACK 和
  绝对序号，自动合计最多 1 Hz。宿主导航拦截由示例页控制，应用内Console
  逐命令入口见本页合同；Storage显式发布和导出仅包含上述Cookie掩码计数，
  远程DevTools写仍不可用。结构导出
  检查唯一别名、已有父节点与子节点数。
- 本地 `ProducerController.memoryFile()` 返回当前连接每种指标最后一条发送成功的 PSS/CPU
  摘要副本；确认前、首次采样前、采集失败、撤销或同步到期后返回 undefined。
  文件路径来自同源领域定义，两项合并到唯一文件并声明
  `hidebug.getPss.getCpuUsage`；单项保留各自 API 来源。
  provenance 仍是 peer-reported，状态为 summary-only。每种最多一条，替换的
  样本计入 dropped，sampled 明确为 true；不附带 fingerprint、正文或其它
  未采集领域，默认不导出 ZIP 或写盘。发送成功不代表桌面已经持久化确认，
  Node 替换平台 API 的测试不能认证这个来源声明。
- 显式导出先固定 PSS/CPU、DFX、当前 UI/DOM 和最近 HTTP、Console、主导航及当前已发送Cookie摘要，展示
  序号、被替换数、UI/DOM 节点数、各摘要数量、ZIP 大小及实际字段，
  再由用户确认并打开系统 DocumentViewPicker。`KitProblemArchive.ets` 生成
  最多 1 MiB 的 `.ohmate-problem.zip`，包含 manifest、应用内存来源 session、
  全部同源 Schema、profile 和内存文件；DFX/UI/Web/请求已采集时包含对应领域文件，
  HTTP 与主导航合并同一 network-summary 文件并声明联合 adapter 来源。
  缺失领域不生成占位文件。PSS-only 有 17 个缺失领域；每个新增已提供领域
  减少一项缺失，不意味着完整领域覆盖。
  `events.jsonl` 为空，session through 为 0，不冒充桌面持久事件或校准时钟。
  PSS-only 保留 `app-memory-summary`，包含 CPU、DFX、UI、Web 或请求时使用独立生成的
  `app-readonly-summary` 布局，旧桌面 Kit 1.4
  的布局保持，UI Schema 增加可选几何/可见属性并兼容精确旧 Schema。
  ZIP 的 CRC、长度和 SHA-256 可由桌面公开校验器验证；
  哈希不是签名，来源/设备/build 保持未认证。
- `PlatformProblemExport.ets` 独立检查 FileIO/UserFileService/FolderSelection，
  关闭选择器的空文件预创建。只有确认且连接未撤销、未到期时才写所选 URI；
  不覆盖已有非空文件，短写必须持续推进，fsync 与关闭成功后才显示已保存。
  选择取消、后台、撤销或到期清除待导出内存；关闭失败保留句柄并阻止重用，
  再次撤销尝试关闭。失败可能留下部分用户文件，提示检查或自行删除；
  不删除用户已保存的文件。无缓存暂存、额外权限、自动上传或分享。
  实际 Picker URI、生命周期和页面交互仍需专属获授权目标验证。
- 单调时间来自本机 STARTUP uptime，精度为毫秒，换算为纳秒字符串。
  clock/boot 标识仅区分本次 Producer 运行，不认证系统 boot 身份。
  事件中的 peer uncertainty 保持最大安全整数；桌面通过加密四时间戳另行
  生成逐条 alignment，只有模型与预算内记录可映射。平台时钟未认证，
  不凭 peer 字段合并跨设备排序，详见 [debug-clock.md](debug-clock.md)。
- 后台、窗口/Ability 销毁、用户撤销、超时和未知消息都会停止采集、清除受控
  密钥并关闭 Socket。迟到的网络/TaskPool 结果不能恢复连接。
  关闭失败保留对象供再次撤销，阻止新配对。

## 配对路径与身份

1. 应用首屏显示本次 `buildId/device/process/sessionId` 参数。device 是随机
   运行别名，process 来自本进程 PID，sessionId 来自平台随机数。
2. 桌面在同一工程下启动 `ohmatecli debug start`，在 human 双 TTY 中执行
   `ohmatecli debug pair` 并使用应用显示的参数。HDC 转发仍需显式指定
   `--hdc-device`；不能自动选择或占用既有设备。
3. 用户把私有终端的 endpoint/invitation JSON 输入应用。密码输入框关闭自动
   填充和复制；解析后清空原文。邀请不进入日志、文件或全局持久状态。
4. 应用核对本进程/本次会话标识，显示完整服务指纹、目标范围、PSS 与按需
   CPU/故障事件、页面结构与接入请求摘要说明。用户逐字比对后点击“指纹一致，允许只读采集”。
5. 撤销或后台后需新邀请和新确认；没有自动重连。

`buildId` 当前以 `unverified:<bundle>:<versionCode>` 明确标记。
应用内字段校验和配对 proof 不构成设备或构建认证；桌面保持
`deviceProvenance:peer-asserted`、`buildVerification:unverified`。
运行时拒绝非 debug 构建及缺少必需 SysCap 的设备，尚无 Release 零残留证明。

## 页面与设计依据

目标用户为调试开发者，主任务为核对授权、观察确认进度和撤销。沿用已有
最终方案 §8.4/§10.4，不另起产品规划。设计语言为 HarmonyOS 7，实际 SDK
基线仍是工程的 `26.0.0`。

单页表单采用 HdsNavigation 紧凑标题、Scroll、V2 状态、系统语义色与字体。
HDS 无对应安全邀请输入控件，采用标准 TextInput Password；说明和按钮
使用标准 Text/Button。16vp 边距/间距、正文 14–16fp，按钮最小 48vp；
长指纹与范围可换行，滚动区最大宽 640vp。使用系统默认安全区和键盘避让，
不叠加沉浸扩展、模糊或自定义转场。应用跟随系统颜色模式。

| 状态 | 可观察行为 |
| --- | --- |
| 等待邀请 | 展示本次标识，输入和查看范围 |
| 等待确认 | 完整指纹、目标和采集范围；确认/撤销 |
| 配对与加密确认 | 禁止重复确认，可撤销 |
| 已连接 | 显示 PSS、连续 ack、待确认序号，提供显式 CPU/故障订阅、结构读取和 HEAD 测试入口 |
| 已停止/过期/失败 | 固定错误码、重新邀请入口；不展示异常原文 |
| 关闭失败 | 保留清理对象，只允许再次撤销 |
| 不支持 | 显示构建或能力限制；未协商 UI 时禁用结构读取 |

适用规则：H7-D01–D07（基线、颜色、文字、间距、状态线索）及隐私、状态、
安全区、触达和无障碍规则。静态设计已覆盖关键状态、撤销和敏感输入边界。
Phone 窄窗、横向窗口、键盘、大字体、深浅色、读屏焦点的实际渲染与交互
仍需专属获授权目标验证；静态检查和构建均不能替代该矩阵。

## 生成与验证入口

从 OHMate-CLI 根执行：

```sh
npm run generate:kit-contract
node --import tsx scripts/generate-kit-contract.mjs --check
env TMPDIR=/private/tmp npm run test:kit
env TMPDIR=/private/tmp npm test -- packages/cli/src/debug-protocol/arkts-producer.test.ts
```

实时 Schema 和能力哈希来自桌面 `debug-protocol/` 当前源码；公共问题 Schema
来自 `problem-package/` 同源定义，包含 19 个 Kit Schema，生成到 `.ets` 常量
及 `rawfile/ohmate-problem-schemas.json`。`--check` 同时核对两种协议资源，
并核对应用导出布局与领域名常量，拒绝漂移且不覆盖文件。禁止手改生成文件。
`test:kit` 将实际核心与控制器 `.ets`
转译后运行 Node 测试，平台密码库/Socket/TaskPool 使用明确测试替身；
这些结果只证明协议逻辑和生命周期，不能作为 HarmonyOS 平台运行证据。

从示例工程根通过官方 `devecocli` 执行 `check arkts`、`check lint` 和
`build --product default --modules entry@default --build-mode debug`。
不生成签名、不使用用户证书、不安装到既有设备。验证范围以当前命令回执为准。

滚动协商源码的 34 项核心/控制器 Node 替身用例、26 项桌面相关用例通过，
旧实现 11 项失败证据保留。官方 ArkTS 检查无错误，30 条异常/权限提示
沿现有受控失败路径和 INTERNET 声明审查。Lint 空诊断与两条规则负控均
已核对完整报告；CLI 1.3.5 在负控报告有错误时仍退出 0，退出码不能单独
作为质量门禁。`entry:default/ohosTest` 无签名构建通过，私有 daemon 已停止。
证据索引为 `artifacts/validation/m2-kit-retention-validation.json`。
四个平台密码用例未执行；设备采集、UI 和完整 Kit profile 仍未验证。

应用导出切片的当前 54 项核心/控制器替身、87 项问题包相关用例、相关源码
Lint 和完整类型通过。旧控制器同副本负控 12 失败/42 通过，恢复 54/0；
旧来源 Schema 5 失败/7 通过，恢复 12/0。官方 ArkTS 无错误、36 条提示
按受控异常与 INTERNET 声明审查；新文件路径的 eqeqeq/prefer-const 负控
检出 2 错误但 exit0，复原完整报告无 issue。两份无签名 HAP 的 rawfile
与当前源码一致；default 包含保存入口，ohosTest 仅编译测试及同源资源。
没有重跑未改变的 ArkTS 构建，平台密码测试没有执行。

应用来源直接校验原始 session，避免 minor 字段投影剔除禁止的桌面流、
认证、历史或校准声明。新公开验证器拒绝用例 RED 5 失败/8 通过；
修复前验证器同副本 5 失败/14 通过，恢复 19/0。旧桌面 Kit 1.4 仍可读取。
新构建与新独立安装的终端/任务验证实际 `.ets` 生成的 ZIP、内存分页/页尾、
17 缺失领域和错误拒绝；三包离线重装及运行时字节一致通过。
这些检查使用明确的 Node crypto/Picker/FileIO/指标替身，不认证平台采集
或 URI 保存。当时 Registry 尚无 replay.import；现已增加显式只读入口，
终端导入合同以当前 Registry 帮助为准。
内部红绿与失败证据不随公开仓库发布；完整 Kit、平台、Phone UI 与 M2 仍未验收。
