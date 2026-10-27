# Dependency Runtime

`deps.analyze/why/audit/sbom` 使用同一 Registry，均为 R0 只读工具。
确定性分析不调用模型、安装工具、registry、CMake 或设备。

## 输入与证据

独立 Cloud/Native 与混合工程通过只读 `project.inspect` 模型进入分析，
不要求先通过 ArkTS 工程校验。ArkTS 位置仍来自真实 `build-profile.json5`
和模块配置；Cloud 支持显式 `function-config.json` handler 与唯一同目录
非空 `.ts/.js` 入口，或 npm 清单声明 `@hw-agconnect/cloud-server` 并由
`main` 指向范围内源码；Native 要求字面量 CMake 声明与实际引用源码
或 `IMPORTED_LOCATION` 库。未支持的云侧描述保留缺口；普通 npm 清单不能
单独证明 Cloud。分析收集公开工程内的 OHPM/npm 清单与锁文件、CMake、
ArkTS/JS 和 Native 源文件，以及工程元数据和库的原始哈希。
`inputs` 记录实际文件 SHA-256；relationship 和 finding 保留文件与可用行号。
原始内容不进入报告，不修改源码或锁文件。

本机 Cloud Toolkit 16.6.1.302 的 `function-config-schema.json` 与
`cloud_function_config.json.ft` 定义 `handler:文件名.方法名` 和
`functionType:0/1`；官方 package 模板没有 SDK 或 main。只读识别要求显式
handler，最多64字符，两个名称只支持ASCII字母、数字、下划线和连字符；
缺失 functionType 不补值。`basis:function-descriptor-entry` 保留配置和
源码原始hash；双入口、缺失源码和不支持的值诊断为未完成，不推测编译选择。
不读取 `cloud-config.json` 或账号凭据，不确认导出存在或执行入口有效。
模板 `enableUrlDecode` 与 schema `enableUriDecode` 拼写不同，当前不解释
trigger配置或据此宣称运行、认证或部署有效。

拒绝越界、秘密内容、符号/硬链接、二进制文本、重复 JSON5 键、读取期间变化和超限文件。
`.a/.so` 从同一次有界安全读取取得原始哈希与 ELF 元数据，不作为文本解码，
不验证 ABI 兼容或产物归属。ELF 区段名搜索最多 257 字节，累计 note 解析
不超过文件字节数；不支持的区段格式保持元数据缺口，原始哈希仍有效。
私有状态、隐藏目录、`oh_modules/node_modules`、构建与产物目录不参与分析。
预算为 10,000 目录条目、2,000 文件、8 MiB/文件、32 MiB 总原始字节；
字面量 CMake 每文件最多 2,000 命令，截断保持不完整。
无法读取的输入产生明确的 `DEPENDENCY_INPUT_UNAVAILABLE`，不能默认为空且完整。

## 锁文件语义

| 来源 | 已支持 | 未执行或不支持 |
| --- | --- | --- |
| OHPM | v3 `specifiers/packages`；具名 scoped 包；直接/传递版本；独立模块锁；显式 `meta.enableUnifiedLockfile` | 其它锁版本、实际包缓存和归档验证 |
| npm | v2/v3 `packages`；最近祖先锁；workspace 源节点和 link；nested node_modules 解析；scope 与脚本标记 | npm v1、pnpm/yarn、实际安装目录、生命周期脚本执行 |
| Native | 字面量 CMake target、link、实际本地引用库和 JS/ArkTS `lib*.so` 桥；同次读取的 ELF 元数据 | 条件/循环/函数、configure-time 变量、include、find_package、子目录、ABI 兼容和头文件实际暴露范围 |

OHPM 首先使用 specifier 映射，无映射时只有唯一候选可以关联；仍报告声明漂移。
存在多个候选时不选择“最高版本”。根锁未启用统一锁时不替代模块锁。
npm 子清单在祖先锁中没有 source locator 时标为 `NPM_WORKSPACE_NOT_LOCKED`，
不继承另一个 workspace 的包版本。

本地模块与 npm workspace 的 `version` 优先绑定可解析的锁元数据，
`declaredVersion` 保留源码清单版本，`versionSource:lock` 明确来源。
声明变化产生 `LOCK_MANIFEST_DRIFT`；不同锁上下文冲突产生
`LOCAL_LOCK_VERSION_CONFLICT` 和 `incomplete`。

实际库组件为 `origin:binary`，按安全文件路径生成独立稳定 ID，保留库文件
证据。字面量 `IMPORTED_LOCATION` 将 target 关联到唯一非空本地库；
`target_link_libraries` 中的相对路径或准确同目录文件也可关联。没有准确文件
的普通库名仍是 CMake 声明，不推测 `lib` 前缀、搜索目录或外部系统库。
同一文件被多次引用时复用组件和边，未引用库不加入二进制组件。

动态/条件配置、`set_property`、include/子目录、debug/optimized 选择阻止
实际库绑定；多重 imported 位置保持歧义。链接路径的越界、私有、空文件、
不可读或超限产生不完整诊断。未知 ELF machine 不从目录名推断 ABI；
相同 basename 的不同引用字节
产生推断级冲突候选，不断言运行时加载冲突。`binary.elf.abiHint/buildId/stripped`
只记录 ELF 声明，`checks.nativeAbi` 仍为 `not-run`。

普通 GNU/BSD `.a` 保留兼容的 `format:ar-header`，在 `binary.archive`
记录 `status/gaps/members`。成员包括原始顺序 index、headerOffset、
有效数据 offset/byteLength、SHA-256、可公开名称、role 和 ELF 声明；
BSD `#1/` 名称及其 NUL 填充不计入成员数据哈希，偶数字节对齐填充也不计入。
GNU `/offset` 只解析已出现的唯一 `//` 表内条目，拒绝落在名称中间的偏移。
符号表与名称表仅记录各自范围和哈希，不解码符号、验证引用或证明链接有效。
重复名称保留不同 index/范围，不生成成员依赖节点，不推测链接选择。

每库最多256个成员（含表）、64 KiB GNU名称表、256字节名称；预算在成员
入列前检查。名称只作为声明，非法UTF-8、秘密/越界路径和控制字符名称
不进入报告，范围及哈希仍保留；不读取任何成员命名的外部文件。
thin 使用 `format:ar-thin`，成员不展开，固定缺口 `thin-external-members`。
坏头/大小/填充、缺失或重复名称表、超限、无对象、未知格式/机器、
非可重定位ELF或不支持的节表均保留 `incomplete` 与
`NATIVE_ARCHIVE_MEMBERS_UNINSPECTED`，不递归解析嵌套归档。
完整成员元数据只表示当前支持的静态声明可读；ABI兼容、归属和实际链接/
运行仍未验证，两种SBOM沿用整库标准checksum并附相同成员扩展元数据。

## 报告与退出码

`deps analyze` 返回：

- `components`：稳定 ID、生态、种类、来源、路径、版本与证据。
- `relationships`：`depends-on/imports/native-bridge/links`、scope 和证据。
- `findings`：规则码、观测或推断置信度、严重度和输入证据。
- `completeness`：当前支持输入范围的 `complete/incomplete`。
- `project`：facet、输入证据、模块/云入口/Native 引用及独立识别诊断。
- `usage.unused:not-evaluated`：动态加载、资源与构建使用尚未全部排除。
- `checks`：漏洞、LICENSE 实物验证、Native ABI 为 `not-run`；
  安装目录为 `not-read`。

模块/包循环和重复版本为观测证据；深层字面量导入为推断候选。
没有使用未知源码或运行时数据证明依赖未使用、许可证有效或不存在漏洞。

退出码 3 优先表示证据不完整；完整输入中有 warning 返回 1；无 warning 返回 0。
工程识别诊断保留在 `project`，不自动改变字面量依赖图的完成状态；不安全、
超限或不可读取的实际输入仍使依赖分析退出 3。工程 facet 为 `unknown` 时
可分析已读入的依赖清单，报告 `PROJECT_FACETS_UNKNOWN`，不据此确认工程类型。
`why --name` 接受包、target、库名或组件 ID，返回有界的全部已记录入边链，
包含 imports、native-bridge 和 links。按记录顺序广度优先遍历，首次入队
总量最多 2,000 个状态（包括起始匹配），返回最多 100 条链，每条最多
32 条边；额度在入队或加入结果前检查，不因单个节点大量入边而突破。
循环或预算截断提供 `truncated:true`；32 条边恰好抵达根时仍完整，
超过深度时只保留已记录的连续后缀。扩展额度耗尽时不把尚未遍历的
前驱视为根，可能返回空链列表。截断是解释范围状态，独立于依赖库存
`completeness` 和原有退出码，不意味着缺失依赖或已完成全部路径分析。
无匹配项返回 4。`audit` 是本地元数据检查，不调用在线漏洞服务。

## SBOM

`deps sbom --standard cyclonedx|spdx` 在 `data.document` 输出 CycloneDX 1.6
或 SPDX 2.3，在 `data.relationships` 保留带证据的跨生态关系。
两种标准的扩展属性/注释保留工程 kind、facet 与来源哈希。
同一稳定组件 ID 生成引用，缺失版本不补值，未知许可证不宣称验证通过。
SHA-256/384/512 SRI 可生成包标准 checksum；实际二进制库的原始 SHA-256
生成标准 hash/checksum。CMake 文件哈希只作为声明证据，不充当库 checksum。
扩展元数据保留 ELF 来源、ABI 未验证与产物归属未认证；二进制版本和 purl
不从文件名推测。未提供完整性时明确报告。
SPDX 对无法确定的许可证和下载来源使用 `NOASSERTION`。

清单不读取 HAP/HAR/HSP、符号包或云部署包；Native 库哈希与 ELF 声明不证明 ABI、符号、
产物归属或完整二进制库存。SBOM 成功不等于
Release 依赖闭包或产物洁净校验成功。

## 验证依据

`dependency.test.ts` 的 23 个用例覆盖锁语义、漂移、循环、workspace、Native
桥、SBOM 引用、安全读取和安装目录排除。原缺失注册项、重复键、祖先锁误用
及本地版本漂移均有失败证据。

`native-binary.test.ts` 覆盖实际引用、SBOM 原始哈希、跨生态 why 链、
条件/动态/配置覆盖、同名冲突及非法/空/超限/链接文件；`elf.test.ts`
覆盖 ELF 解析与累计 note 预算。合成 ELF 验证解析边界，不证明真实编译库、
ABI 兼容、官方 CMake 配置或设备运行。

`graph-audit.test.ts` 覆盖入队/返回/深度预算、单层与多层分叉、循环、
恰好额度与菱形共用祖先，保留关系顺序和证据；Registry 深链用例检查
完整库存与截断解释分离，原始锁文件保持不变。

`cloud-descriptor.test.ts` 覆盖官方模板形状、无SDK/main的入口、云对象类型、
缺失类型、handler边界、双入口、缺失/空/类型声明/异目录源码、链接/超限/
秘密内容拒绝、原始hash与两SBOM。输入是私有合成工程，源码与npm脚本
未执行；这些结果不证明真实Cloud编译、调试、触发或部署。

`scripts/verify-deps.mjs` 使用临时 HOME、空 npm 配置和私有工程，
由官方 OHPM 生成本地依赖锁，由 npm 生成离线 workspace 锁。
本机观测为 `@ohos/ohpm@26.0.0.630`；没有 `--offline` 参数，
验证使用帮助中真实的 `--registry` 隔离入口，记录 0 次 registry 请求。
Producer 记录实际脚本/可执行文件哈希、包版本、帮助哈希和退出码。
随后验证构建/安装入口、持久任务、Web/CLI 相同回执与原始锁哈希。

`scripts/verify-patch-browser.mjs <bin> <label> --deps` 在测试独占 Chrome
选择已登记工程和依赖工具，执行后台 SPDX 任务，检查回执及 1440/390
宽度布局。设备与付费模型未参与验证。
