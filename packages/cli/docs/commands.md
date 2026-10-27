# OHMate 完整命令参考

此文件由 `npm run catalog` 从已构建 Runtime 自动生成。修改命令后先构建，再生成；
`npm run check:catalog` 检查漂移。登记、风险等级与可取消声明不等于功能或平台验收通过。
已知限制以命令帮助和实际回执为准，操作流程见 [使用说明](usage.md)。

产品版本：0.1.0；公开 ToolSpec：221；隔离底座入口：118。
JSON Schema、选项默认值及完整合同见 [command-catalog.json](command-catalog.json)。

## 通用入口

所有条目都可用 `ohmatecli <命令> --help` 查看实时帮助。
`execute <toolId> --input <JSON>` 或 `--input-file <公共JSON文件>` 使用完整 Schema；
两种输入方式互斥，不能混入该工具的专用参数。底座工具的结构化输入为 `{"argv":[...]}`。
带默认值的字段可省略；Schema 序列化中的 required 不改变运行时默认值。
选项中 `<value>` 表示选项出现时须带值，只有 mandatory=true 才表示必须提供该选项。

| 全局选项 | 用途 |
| --- | --- |
| `--project <path>` | 明确工程根；设备与构建操作仍检查能力和目标 |
| `--format json` | 单个统一回执；协议入口保留原协议流 |
| `--lang zh-CN` / `--lang en-US` | 输出语言，稳定字段与枚举不翻译 |
| `--non-interactive` | 不等待交互，待审批返回 5 |
| `--approve-plan <id>` | 在原参数、工程与文件指纹不变时消费审批计划 |
| `--raw` | 底座原始输出流 |

## 命令索引

| Tool ID | CLI 命令 | 风险 | 实现入口 |
| --- | --- | --- | --- |
| [agent.chat](#agent-chat) | `agent chat` | R0 | native |
| [agent.run](#agent-run) | `agent run` | R0 | native |
| [analyze.api](#analyze-api) | `analyze api` | R0 | native |
| [analyze.auto](#analyze-auto) | `analyze auto` | R0 | native |
| [analyze.cppcrash](#analyze-cppcrash) | `analyze cppcrash` | R0 | native |
| [analyze.fdleak](#analyze-fdleak) | `analyze fdleak` | R0 | native |
| [analyze.freeze](#analyze-freeze) | `analyze freeze` | R0 | native |
| [analyze.gc](#analyze-gc) | `analyze gc` | R0 | native |
| [analyze.jscrash](#analyze-jscrash) | `analyze jscrash` | R0 | native |
| [analyze.jsleak](#analyze-jsleak) | `analyze jsleak` | R0 | native |
| [analyze.nativeleak](#analyze-nativeleak) | `analyze nativeleak` | R0 | native |
| [analyze.ui](#analyze-ui) | `analyze ui` | R0 | native |
| [build.cache.inspect](#build-cache-inspect) | `build cache inspect` | R0 | native |
| [build.cache.restore](#build-cache-restore) | `build cache restore` | R2 | native |
| [build.plan](#build-plan) | `build plan` | R0 | native |
| [build.run](#build-run) | `build run` | R2 | native |
| [build.signing.inspect](#build-signing-inspect) | `build signing inspect` | R0 | native |
| [build.signing.restore](#build-signing-restore) | `build signing restore` | R3 | native |
| [capabilities](#capabilities) | `capabilities` | R0 | native |
| [config.edit](#config-edit) | `config edit` | R2 | native |
| [config.inspect](#config-inspect) | `config inspect` | R0 | native |
| [config.validate](#config-validate) | `config validate` | R0 | native |
| [context.inspect](#context-inspect) | `context inspect` | R0 | native |
| [context.preview](#context-preview) | `context preview` | R0 | native |
| [debug.events](#debug-events) | `debug events` | R0 | native |
| [debug.inspect](#debug-inspect) | `debug inspect` | R0 | native |
| [debug.inspectors](#debug-inspectors) | `debug inspectors` | R0 | native |
| [debug.list](#debug-list) | `debug list` | R0 | native |
| [debug.pair](#debug-pair) | `debug pair` | R0 | native |
| [debug.problem.export](#debug-problem-export) | `debug problem export` | R2 | native |
| [debug.problem.plan](#debug-problem-plan) | `debug problem plan` | R0 | native |
| [debug.protocol](#debug-protocol) | `debug protocol` | R0 | native |
| [debug.show](#debug-show) | `debug show` | R0 | native |
| [debug.start](#debug-start) | `debug start` | R0 | native |
| [debug.status](#debug-status) | `debug status` | R0 | native |
| [debug.stop](#debug-stop) | `debug stop` | R0 | native |
| [debug.streams](#debug-streams) | `debug streams` | R0 | native |
| [deps.analyze](#deps-analyze) | `deps analyze` | R0 | native |
| [deps.audit](#deps-audit) | `deps audit` | R0 | native |
| [deps.sbom](#deps-sbom) | `deps sbom` | R0 | native |
| [deps.why](#deps-why) | `deps why` | R0 | native |
| [deveco.auth](#deveco-auth) | `auth` | R3 | legacy-child |
| [deveco.auth.login](#deveco-auth-login) | `auth login` | R3 | legacy-child |
| [deveco.auth.logout](#deveco-auth-logout) | `auth logout` | R3 | legacy-child |
| [deveco.auth.status](#deveco-auth-status) | `auth status` | R0 | legacy-child |
| [deveco.auth.team](#deveco-auth-team) | `auth team` | R3 | legacy-child |
| [deveco.auth.team.list](#deveco-auth-team-list) | `auth team list` | R0 | legacy-child |
| [deveco.build](#deveco-build) | `build` | R2 | native |
| [deveco.build.clean](#deveco-build-clean) | `build clean` | R3 | legacy-child |
| [deveco.check](#deveco-check) | `check` | R3 | legacy-child |
| [deveco.check.arkts](#deveco-check-arkts) | `check arkts` | R3 | legacy-child |
| [deveco.check.compat](#deveco-check-compat) | `check compat` | R1 | legacy-child |
| [deveco.check.compat.versions](#deveco-check-compat-versions) | `check compat versions` | R3 | legacy-child |
| [deveco.check.lint](#deveco-check-lint) | `check lint` | R3 | legacy-child |
| [deveco.create](#deveco-create) | `create` | R2 | native |
| [deveco.device](#deveco-device) | `device` | R3 | legacy-child |
| [deveco.device.app](#deveco-device-app) | `device app` | R3 | legacy-child |
| [deveco.device.app.clearcache](#deveco-device-app-clearcache) | `device app clearcache` | R3 | legacy-child |
| [deveco.device.app.cleardata](#deveco-device-app-cleardata) | `device app cleardata` | R3 | legacy-child |
| [deveco.device.app.foreground](#deveco-device-app-foreground) | `device app foreground` | R3 | legacy-child |
| [deveco.device.app.info](#deveco-device-app-info) | `device app info` | R3 | legacy-child |
| [deveco.device.app.install](#deveco-device-app-install) | `device app install` | R3 | legacy-child |
| [deveco.device.app.list](#deveco-device-app-list) | `device app list` | R3 | legacy-child |
| [deveco.device.app.start](#deveco-device-app-start) | `device app start` | R3 | legacy-child |
| [deveco.device.app.stop](#deveco-device-app-stop) | `device app stop` | R3 | legacy-child |
| [deveco.device.app.uninstall](#deveco-device-app-uninstall) | `device app uninstall` | R3 | legacy-child |
| [deveco.device.clipboard](#deveco-device-clipboard) | `device clipboard` | R3 | legacy-child |
| [deveco.device.clipboard.clear](#deveco-device-clipboard-clear) | `device clipboard clear` | R3 | legacy-child |
| [deveco.device.clipboard.read](#deveco-device-clipboard-read) | `device clipboard read` | R3 | legacy-child |
| [deveco.device.clipboard.write](#deveco-device-clipboard-write) | `device clipboard write` | R3 | legacy-child |
| [deveco.device.file](#deveco-device-file) | `device file` | R3 | legacy-child |
| [deveco.device.file.delete](#deveco-device-file-delete) | `device file delete` | R3 | legacy-child |
| [deveco.device.file.exist](#deveco-device-file-exist) | `device file exist` | R3 | legacy-child |
| [deveco.device.file.recv](#deveco-device-file-recv) | `device file recv` | R3 | legacy-child |
| [deveco.device.file.send](#deveco-device-file-send) | `device file send` | R3 | legacy-child |
| [deveco.device.font](#deveco-device-font) | `device font` | R3 | legacy-child |
| [deveco.device.font.info](#deveco-device-font-info) | `device font info` | R3 | legacy-child |
| [deveco.device.font.install](#deveco-device-font-install) | `device font install` | R3 | legacy-child |
| [deveco.device.font.uninstall](#deveco-device-font-uninstall) | `device font uninstall` | R3 | legacy-child |
| [deveco.device.list](#deveco-device-list) | `device list` | R0 | legacy-child |
| [deveco.device.open-control-center](#deveco-device-open-control-center) | `device open-control-center` | R3 | legacy-child |
| [deveco.device.open-notification-center](#deveco-device-open-notification-center) | `device open-notification-center` | R3 | legacy-child |
| [deveco.device.screen](#deveco-device-screen) | `device screen` | R3 | legacy-child |
| [deveco.device.screen.rotate](#deveco-device-screen-rotate) | `device screen rotate` | R3 | legacy-child |
| [deveco.device.screen.rotation](#deveco-device-screen-rotation) | `device screen rotation` | R3 | legacy-child |
| [deveco.device.screen.rotation-lock](#deveco-device-screen-rotation-lock) | `device screen rotation-lock` | R3 | legacy-child |
| [deveco.device.screen.size](#deveco-device-screen-size) | `device screen size` | R3 | legacy-child |
| [deveco.device.screen.sleeptime](#deveco-device-screen-sleeptime) | `device screen sleeptime` | R3 | legacy-child |
| [deveco.device.sleep](#deveco-device-sleep) | `device sleep` | R3 | legacy-child |
| [deveco.device.sqlite3](#deveco-device-sqlite3) | `device sqlite3` | R3 | legacy-child |
| [deveco.device.status](#deveco-device-status) | `device status` | R3 | legacy-child |
| [deveco.device.time](#deveco-device-time) | `device time` | R3 | legacy-child |
| [deveco.device.timezone](#deveco-device-timezone) | `device timezone` | R3 | legacy-child |
| [deveco.device.unlock](#deveco-device-unlock) | `device unlock` | R3 | legacy-child |
| [deveco.device.view](#deveco-device-view) | `device view` | R0 | legacy-child |
| [deveco.device.viewmode](#deveco-device-viewmode) | `device viewmode` | R3 | legacy-child |
| [deveco.device.wake](#deveco-device-wake) | `device wake` | R3 | legacy-child |
| [deveco.docs](#deveco-docs) | `docs` | R3 | legacy-child |
| [deveco.docs.catalog](#deveco-docs-catalog) | `docs catalog` | R0 | legacy-child |
| [deveco.docs.read](#deveco-docs-read) | `docs read` | R0 | legacy-child |
| [deveco.docs.search](#deveco-docs-search) | `docs search` | R0 | legacy-child |
| [deveco.docs.update](#deveco-docs-update) | `docs update` | R3 | legacy-child |
| [deveco.emulator](#deveco-emulator) | `emulator` | R3 | legacy-child |
| [deveco.emulator.battery](#deveco-emulator-battery) | `emulator battery` | R3 | legacy-child |
| [deveco.emulator.create](#deveco-emulator-create) | `emulator create` | R2 | legacy-child |
| [deveco.emulator.delete](#deveco-emulator-delete) | `emulator delete` | R3 | legacy-child |
| [deveco.emulator.fold](#deveco-emulator-fold) | `emulator fold` | R3 | legacy-child |
| [deveco.emulator.geolocation](#deveco-emulator-geolocation) | `emulator geolocation` | R3 | legacy-child |
| [deveco.emulator.image](#deveco-emulator-image) | `emulator image` | R3 | legacy-child |
| [deveco.emulator.image.download](#deveco-emulator-image-download) | `emulator image download` | R3 | legacy-child |
| [deveco.emulator.image.list](#deveco-emulator-image-list) | `emulator image list` | R0 | legacy-child |
| [deveco.emulator.image.remove](#deveco-emulator-image-remove) | `emulator image remove` | R3 | legacy-child |
| [deveco.emulator.license](#deveco-emulator-license) | `emulator license` | R3 | legacy-child |
| [deveco.emulator.license.accept](#deveco-emulator-license-accept) | `emulator license accept` | R3 | legacy-child |
| [deveco.emulator.license.view](#deveco-emulator-license-view) | `emulator license view` | R0 | legacy-child |
| [deveco.emulator.list](#deveco-emulator-list) | `emulator list` | R0 | legacy-child |
| [deveco.emulator.power](#deveco-emulator-power) | `emulator power` | R3 | legacy-child |
| [deveco.emulator.rotate](#deveco-emulator-rotate) | `emulator rotate` | R3 | legacy-child |
| [deveco.emulator.scene](#deveco-emulator-scene) | `emulator scene` | R3 | legacy-child |
| [deveco.emulator.sensor](#deveco-emulator-sensor) | `emulator sensor` | R3 | legacy-child |
| [deveco.emulator.shake](#deveco-emulator-shake) | `emulator shake` | R3 | legacy-child |
| [deveco.emulator.start](#deveco-emulator-start) | `emulator start` | R2 | legacy-child |
| [deveco.emulator.stop](#deveco-emulator-stop) | `emulator stop` | R2 | legacy-child |
| [deveco.emulator.volume](#deveco-emulator-volume) | `emulator volume` | R3 | legacy-child |
| [deveco.init](#deveco-init) | `init` | R2 | legacy-child |
| [deveco.log](#deveco-log) | `log` | R1 | legacy-child |
| [deveco.run](#deveco-run) | `run` | R2 | legacy-child |
| [deveco.serve](#deveco-serve) | `serve` | R3 | legacy-child |
| [deveco.serve.lsp](#deveco-serve-lsp) | `serve lsp` | R1 | legacy-child |
| [deveco.serve.mcp](#deveco-serve-mcp) | `serve mcp` | R1 | legacy-child |
| [deveco.signature](#deveco-signature) | `signature` | R3 | legacy-child |
| [deveco.signature.generate](#deveco-signature-generate) | `signature generate` | R3 | legacy-child |
| [deveco.skills](#deveco-skills) | `skills` | R3 | legacy-child |
| [deveco.skills.add](#deveco-skills-add) | `skills add` | R2 | legacy-child |
| [deveco.skills.find](#deveco-skills-find) | `skills find` | R0 | legacy-child |
| [deveco.skills.list](#deveco-skills-list) | `skills list` | R0 | legacy-child |
| [deveco.skills.remove](#deveco-skills-remove) | `skills remove` | R3 | legacy-child |
| [deveco.ui](#deveco-ui) | `ui` | R2 | legacy-child |
| [deveco.ui.click](#deveco-ui-click) | `ui click` | R2 | legacy-child |
| [deveco.ui.dircfling](#deveco-ui-dircfling) | `ui dircfling` | R2 | legacy-child |
| [deveco.ui.doubleclick](#deveco-ui-doubleclick) | `ui doubleclick` | R2 | legacy-child |
| [deveco.ui.drag](#deveco-ui-drag) | `ui drag` | R2 | legacy-child |
| [deveco.ui.find](#deveco-ui-find) | `ui find` | R0 | legacy-child |
| [deveco.ui.fling](#deveco-ui-fling) | `ui fling` | R2 | legacy-child |
| [deveco.ui.layout](#deveco-ui-layout) | `ui layout` | R0 | legacy-child |
| [deveco.ui.longclick](#deveco-ui-longclick) | `ui longclick` | R2 | legacy-child |
| [deveco.ui.screenrecord](#deveco-ui-screenrecord) | `ui screenrecord` | R1 | legacy-child |
| [deveco.ui.screenrecord.start](#deveco-ui-screenrecord-start) | `ui screenrecord start` | R2 | legacy-child |
| [deveco.ui.screenrecord.status](#deveco-ui-screenrecord-status) | `ui screenrecord status` | R2 | legacy-child |
| [deveco.ui.screenrecord.stop](#deveco-ui-screenrecord-stop) | `ui screenrecord stop` | R2 | legacy-child |
| [deveco.ui.screenshot](#deveco-ui-screenshot) | `ui screenshot` | R1 | legacy-child |
| [deveco.ui.swipe](#deveco-ui-swipe) | `ui swipe` | R2 | legacy-child |
| [deveco.ui.text](#deveco-ui-text) | `ui text` | R2 | legacy-child |
| [deveco.ui.wait](#deveco-ui-wait) | `ui wait` | R0 | legacy-child |
| [deveco.ui.window](#deveco-ui-window) | `ui window` | R2 | legacy-child |
| [deveco.ui.window.list](#deveco-ui-window-list) | `ui window list` | R0 | legacy-child |
| [deveco.update](#deveco-update) | `update` | R3 | legacy-child |
| [deveco.verify](#deveco-verify) | `verify` | R3 | legacy-child |
| [deveco.verify.init](#deveco-verify-init) | `verify init` | R3 | legacy-child |
| [deveco.verify.log](#deveco-verify-log) | `verify log` | R3 | legacy-child |
| [deveco.verify.screenshot](#deveco-verify-screenshot) | `verify screenshot` | R3 | legacy-child |
| [devtools.serve](#devtools-serve) | `devtools serve` | R0 | native |
| [docs.check](#docs-check) | `docs check` | R1 | native |
| [docs.generate](#docs-generate) | `docs generate` | R1 | native |
| [doctor](#doctor) | `doctor` | R0 | native |
| [extensions.disable](#extensions-disable) | `extensions disable` | R0 | native |
| [extensions.enable](#extensions-enable) | `extensions enable` | R0 | native |
| [extensions.list](#extensions-list) | `extensions list` | R0 | native |
| [integrate.hvigor](#integrate-hvigor) | `integrate hvigor` | R2 | native |
| [integrate.runtime](#integrate-runtime) | `integrate runtime` | R0 | native |
| [memory.add](#memory-add) | `memory add` | R0 | native |
| [memory.list](#memory-list) | `memory list` | R0 | native |
| [memory.remove](#memory-remove) | `memory remove` | R0 | native |
| [mock.apply](#mock-apply) | `mock apply` | R2 | native |
| [mock.plan](#mock-plan) | `mock plan` | R0 | native |
| [mock.revoke](#mock-revoke) | `mock revoke` | R2 | native |
| [mock.status](#mock-status) | `mock status` | R0 | native |
| [mock.validate](#mock-validate) | `mock validate` | R0 | native |
| [model.add](#model-add) | `model add` | R0 | native |
| [model.check](#model-check) | `model check` | R0 | native |
| [model.list](#model-list) | `model list` | R0 | native |
| [model.remove](#model-remove) | `model remove` | R0 | native |
| [model.select](#model-select) | `model select` | R0 | native |
| [model.trae](#model-trae) | `model trae` | R0 | native |
| [model.trae-cli](#model-trae-cli) | `model trae-cli` | R0 | native |
| [project.inspect](#project-inspect) | `project inspect` | R0 | native |
| [project.list](#project-list) | `project list` | R0 | native |
| [project.register](#project-register) | `project register` | R0 | native |
| [release.artifacts](#release-artifacts) | `release artifacts` | R1 | native |
| [release.guide](#release-guide) | `release guide` | R1 | native |
| [release.verify](#release-verify) | `release verify` | R1 | native |
| [replay.import](#replay-import) | `replay import` | R0 | native |
| [replay.plan](#replay-plan) | `replay plan` | R0 | native |
| [replay.show](#replay-show) | `replay show` | R0 | native |
| [replay.verify](#replay-verify) | `replay verify` | R0 | native |
| [rules.check](#rules-check) | `rules check` | R0 | native |
| [rules.list](#rules-list) | `rules list` | R0 | native |
| [scan](#scan) | `scan` | R1 | native |
| [session.export](#session-export) | `session export` | R0 | native |
| [session.list](#session-list) | `session list` | R0 | native |
| [session.resume](#session-resume) | `session resume` | R0 | native |
| [session.show](#session-show) | `session show` | R0 | native |
| [skill.export](#skill-export) | `skill export` | R1 | native |
| [skill.verify](#skill-verify) | `skill verify` | R0 | native |
| [task.approve](#task-approve) | `task approve` | R0 | native |
| [task.cancel](#task-cancel) | `task cancel` | R0 | native |
| [task.events](#task-events) | `task events` | R0 | native |
| [task.list](#task-list) | `task list` | R0 | native |
| [task.resume](#task-resume) | `task resume` | R0 | native |
| [task.show](#task-show) | `task show` | R0 | native |
| [task.submit](#task-submit) | `task submit` | R0 | native |
| [test.instrument](#test-instrument) | `test instrument` | R2 | native |
| [test.local](#test-local) | `test local` | R2 | native |
| [test.plan](#test-plan) | `test plan` | R0 | native |
| [ui.open](#ui-open) | `ui` | R0 | native |
| [ui.status](#ui-status) | `ui status` | R0 | native |
| [ui.stop](#ui-stop) | `ui stop` | R0 | native |
| [workspace.patch](#workspace-patch) | `workspace patch` | R2 | native |
| [workspace.read](#workspace-read) | `workspace read` | R0 | native |
| [workspace.recovery.inspect](#workspace-recovery-inspect) | `workspace recovery inspect` | R0 | native |
| [workspace.recovery.restore](#workspace-recovery-restore) | `workspace recovery restore` | R2 | native |

<a id="agent-chat"></a>
## agent.chat

Open the interactive terminal console

```bash
ohmatecli agent chat --help
```

风险 R0；前提 无声明前提；超时 0 ms；可取消 是；恢复 manual。

此入口输出原协议流，错误写入 stderr。

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="agent-run"></a>
## agent.run

Execute a bounded BYOK Agent task with preview-bound context

```bash
ohmatecli agent run --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 manual。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `prompt` | 是 | 否 |

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--files <value...>` | Explicit context files | 未声明 | 否 |
| `--allowed-tools <value...>` | Tool IDs approved for this run | 未声明 | 否 |
| `--write-paths <value...>` | Exact public paths the Agent may propose to change | 未声明 | 否 |
| `--session-id <value>` | session-id | 未声明 | 否 |
| `--model-id <value>` | model-id | 未声明 | 否 |
| `--preview-hash <value>` | preview-hash | 未声明 | 否 |
| `--max-turns <value>` | max-turns | 未声明 | 否 |
| `--max-tool-calls <value>` | max-tool-calls | 未声明 | 否 |
| `--max-bytes <value>` | max-bytes | 未声明 | 否 |

<a id="analyze-api"></a>
## analyze.api

Analyze the bounded HiLog explicit error-code subset offline; API association, capture and root cause remain unverified

```bash
ohmatecli analyze api --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 verify-and-retry。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--log <value>` | Explicit public UTF-8 .log/.txt input; E/F lines with explicit error code fields | 未声明 | 否 |
| `--sdk-module <value>` | Optional exact @ohos module in the current toolchain SDK; declaration candidates only | 未声明 | 否 |

<a id="analyze-auto"></a>
## analyze.auto

Triage a bounded public log subset offline; validate a sole candidate, leave ambiguous domains manual and capture or root cause unverified

```bash
ohmatecli analyze auto --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 verify-and-retry。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--log <value>` | Explicit public UTF-8 .log/.txt input; no snapshot, SDK, attachment or device discovery | 未声明 | 否 |

<a id="analyze-cppcrash"></a>
## analyze.cppcrash

Analyze the bounded Native faultlog/signal and primary frame subset offline; symbols, build identity and root cause remain unverified

```bash
ohmatecli analyze cppcrash --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 verify-and-retry。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--log <value>` | Explicit public UTF-8 .log/.txt input; declared Native signal and fault-thread frames only | 未声明 | 否 |

<a id="analyze-fdleak"></a>
## analyze.fdleak

Analyze the bounded FD snapshot/allocation log subset offline; symbols, detail association and leak diagnosis remain unverified

```bash
ohmatecli analyze fdleak --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 verify-and-retry。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--log <value>` | Explicit public UTF-8 .log/.txt input; declared FD stock and allocation fields only | 未声明 | 否 |

<a id="analyze-freeze"></a>
## analyze.freeze

Analyze the bounded AppFreeze event and thread-stack subset offline; system factors, sample association and root cause remain unverified

```bash
ohmatecli analyze freeze --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 verify-and-retry。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--log <value>` | Explicit public UTF-8 .log/.txt input; declared Freeze events and thread frames only | 未声明 | 否 |

<a id="analyze-gc"></a>
## analyze.gc

Analyze the bounded Ark GC summary log subset offline; capture identity, verbose association and root cause remain unverified

```bash
ohmatecli analyze gc --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 verify-and-retry。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--log <value>` | Explicit public UTF-8 .log/.txt input; only known Ark GC summary fields | 未声明 | 否 |

<a id="analyze-jscrash"></a>
## analyze.jscrash

Analyze the bounded JS faultlog/JS primary stack subset offline; SourceMap, build identity and root cause remain unverified

```bash
ohmatecli analyze jscrash --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 verify-and-retry。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--log <value>` | Explicit public UTF-8 .log/.txt input; declared JS error and primary JS frames only | 未声明 | 否 |

<a id="analyze-jsleak"></a>
## analyze.jsleak

Analyze a bounded V8 JSON layout subset offline; Ark capture, rawheap, retained size and leak diagnosis remain unverified

```bash
ohmatecli analyze jsleak --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 verify-and-retry。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--snapshots <value...>` | One snapshot, or before/after in explicit order; .heapsnapshot files only | 未声明 | 否 |

<a id="analyze-nativeleak"></a>
## analyze.nativeleak

Analyze the bounded Native memory sample and smaps table subset offline; capture, allocation lifetime and leak diagnosis remain unverified

```bash
ohmatecli analyze nativeleak --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 verify-and-retry。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--sample <value>` | Explicit public UTF-8 .log/.txt sample; OpenHarmony 5.0.3 fields only | 未声明 | 否 |
| `--smaps <value>` | Optional explicit public UTF-8 .log/.txt hidumper smaps table; no companion discovery or input association | 未声明 | 否 |

<a id="analyze-ui"></a>
## analyze.ui

Analyze the bounded Ace window lifecycle log subset offline; layout, rendering, capture and root cause remain unverified

```bash
ohmatecli analyze ui --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 verify-and-retry。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--log <value>` | Explicit public UTF-8 .log/.txt input; known Ace window notifications and context fields only | 未声明 | 否 |

<a id="build-cache-inspect"></a>
## build.cache.inspect

Inspect reviewed quickfix compiler cache removals

```bash
ohmatecli build cache inspect --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--journal-id <value>` | Scoped quickfix-cache recovery journal | 未声明 | 否 |

<a id="build-cache-restore"></a>
## build.cache.restore

Restore reviewed quickfix cache bytes without overwriting subsequent files

```bash
ohmatecli build cache restore --help
```

风险 R2；前提 无声明前提；超时 300000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--journal-id <value>` | Scoped quickfix-cache recovery journal | 未声明 | 否 |

<a id="build-plan"></a>
## build.plan

Read build targets, inputs and tool fingerprints without executing project scripts

```bash
ohmatecli build plan --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--product <value>` | Declared product | 未声明 | 否 |
| `--modules <value...>` | module@target selections | 未声明 | 否 |
| `--build-mode <value>` | Declared build mode | 未声明 | 否 |
| `--assemble-type <value>` | Observed official assemble task | 未声明 | 否 |
| `--signing-config <value>` | Declared signing reference; requires R3 and is restored after the build | 未声明 | 否 |
| `--install` | Approve OHPM dependency installation before sync/build | 未声明 | 否 |

<a id="build-run"></a>
## build.run

Build through bundled DevEco adapters with approval and immutable provenance

```bash
ohmatecli build run --help
```

风险 R2；前提 project, toolchain；超时 1800000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--product <value>` | Declared product | 未声明 | 否 |
| `--modules <value...>` | module@target selections | 未声明 | 否 |
| `--build-mode <value>` | Declared build mode | 未声明 | 否 |
| `--assemble-type <value>` | Observed official assemble task | 未声明 | 否 |
| `--signing-config <value>` | Declared signing reference; requires R3 and is restored after the build | 未声明 | 否 |
| `--install` | Approve OHPM dependency installation before sync/build | 未声明 | 否 |

<a id="build-signing-inspect"></a>
## build.signing.inspect

Inspect outstanding signing-reference changes without modifying a profile

```bash
ohmatecli build signing inspect --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--journal-id <value>` | Scoped signing-reference recovery journal | 未声明 | 否 |

<a id="build-signing-restore"></a>
## build.signing.restore

Restore the exact profile bytes only when its applied hash still matches

```bash
ohmatecli build signing restore --help
```

风险 R3；前提 无声明前提；超时 300000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--journal-id <value>` | Scoped signing-reference recovery journal | 未声明 | 否 |

<a id="capabilities"></a>
## capabilities

Registered commands, schemas and execution contracts

```bash
ohmatecli capabilities --help
```

风险 R0；前提 无声明前提；超时 60000 ms；可取消 是；恢复 verify-and-retry。

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="config-edit"></a>
## config.edit

Review configuration field add/remove/replace or supported ArkGuard rule edits

```bash
ohmatecli config edit --help
```

风险 R2；前提 无声明前提；超时 300000 ms；可取消 是；恢复 manual。

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="config-inspect"></a>
## config.inspect

Read public configuration and its input hash

```bash
ohmatecli config inspect --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--path <value>` | Relative public configuration path | 未声明 | 否 |

<a id="config-validate"></a>
## config.validate

Validate JSON5 syntax and lossless edit support; official checks reported separately

```bash
ohmatecli config validate --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--path <value>` | Relative public configuration path | 未声明 | 否 |

<a id="context-inspect"></a>
## context.inspect

Preview exact context material, sources, hashes and sending budget

```bash
ohmatecli context inspect --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--prompt <value>` | User intent included in the sending preview | 未声明 | 否 |
| `--files <value...>` | Explicit project-relative files | 未声明 | 否 |
| `--write-paths <value...>` | Exact public paths the Agent may propose to change; parent directories must exist | 未声明 | 否 |
| `--session-id <value>` | Conversation to resume | 未声明 | 否 |
| `--model-id <value>` | Explicit model endpoint | 未声明 | 否 |
| `--allowed-tools <value...>` | Explicit tool IDs whose results may be sent | 未声明 | 否 |
| `--max-bytes <value>` | Maximum preview size | 未声明 | 否 |

<a id="context-preview"></a>
## context.preview

Preview exact context material, sources, hashes and sending budget

```bash
ohmatecli context preview --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--prompt <value>` | User intent included in the sending preview | 未声明 | 否 |
| `--files <value...>` | Explicit project-relative files | 未声明 | 否 |
| `--write-paths <value...>` | Exact public paths the Agent may propose to change; parent directories must exist | 未声明 | 否 |
| `--session-id <value>` | Conversation to resume | 未声明 | 否 |
| `--model-id <value>` | Explicit model endpoint | 未声明 | 否 |
| `--allowed-tools <value...>` | Explicit tool IDs whose results may be sent | 未声明 | 否 |
| `--max-bytes <value>` | Maximum preview size | 未声明 | 否 |

<a id="debug-events"></a>
## debug.events

Read verified, redacted durable events without resuming a device connection

```bash
ohmatecli debug events --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 manual。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `id` | 是 | 否 |

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--stream <value>` | Saved event stream identifier | 未声明 | 否 |
| `--after <value>` | Exclusive persisted event cursor | 未声明 | 否 |
| `--limit <value>` | Maximum records returned (1–256) | 未声明 | 否 |

<a id="debug-inspect"></a>
## debug.inspect

Inspect a verified channel summary at a fixed committed cut without probing devices

```bash
ohmatecli debug inspect --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 manual。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `id` | 是 | 否 |

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--stream <value>` | Saved event stream UUID | 未声明 | 否 |
| `--channel <value>` | Read-only protocol channel | 未声明 | 否 |
| `--after <value>` | Exclusive committed event cursor | 未声明 | 否 |
| `--limit <value>` | Maximum matching records (1–256) | 未声明 | 否 |
| `--through <value>` | Fixed inclusive committed cut (defaults to the current tail) | 未声明 | 否 |

<a id="debug-inspectors"></a>
## debug.inspectors

Describe read-only channel views, missing fields and official API references

```bash
ohmatecli debug inspectors --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 manual。

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="debug-list"></a>
## debug.list

List saved debug sessions, including stopped and disconnected services

```bash
ohmatecli debug list --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 manual。

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="debug-pair"></a>
## debug.pair

Issue a short-lived invitation only to a private interactive terminal

```bash
ohmatecli debug pair --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--buildId <value>` | Peer build identifier (unverified) | 未声明 | 否 |
| `--device <value>` | Peer device identifier (unverified) | 未声明 | 否 |
| `--process <value>` | Peer process identifier | 未声明 | 否 |
| `--sessionId <value>` | Peer recorder session identifier | 未声明 | 否 |
| `--hdc-device <value>` | Exact connected HDC serial for an owned reverse mapping | 未声明 | 否 |

<a id="debug-problem-export"></a>
## debug.problem.export

Export an approved fixed redacted snapshot into private immutable artifacts

```bash
ohmatecli debug problem export --help
```

风险 R2；前提 无声明前提；超时 300000 ms；可取消 是；恢复 manual。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `id` | 是 | 否 |

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--stream <value>` | Saved event stream UUID | 未声明 | 否 |
| `--through <value>` | Fixed inclusive committed sequence (safe integer); retained count stays bounded | 未声明 | 否 |

<a id="debug-problem-plan"></a>
## debug.problem.plan

Preview the exact redacted fields, files, bytes and risks of a fixed event cut

```bash
ohmatecli debug problem plan --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 manual。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `id` | 是 | 否 |

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--stream <value>` | Saved event stream UUID | 未声明 | 否 |
| `--through <value>` | Fixed inclusive committed sequence (safe integer); retained count stays bounded | 未声明 | 否 |

<a id="debug-protocol"></a>
## debug.protocol

Describe supported read-only protocol schemas without claiming device capture

```bash
ohmatecli debug protocol --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 manual。

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="debug-show"></a>
## debug.show

Read a saved debug session without probing devices

```bash
ohmatecli debug show --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 manual。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `id` | 是 | 否 |

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="debug-start"></a>
## debug.start

Start the shared local workbench without opening a browser or probing devices

```bash
ohmatecli debug start --help
```

风险 R0；前提 无声明前提；超时 30000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--port <value>` | Bind an explicit loopback port (default: random) | 未声明 | 否 |
| `--dev-auto-pair` | Development only: serve one-time invitations to a loopback peer without a TTY | 未声明 | 否 |

<a id="debug-status"></a>
## debug.status

Read shared workbench and debug session status

```bash
ohmatecli debug status --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 manual。

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="debug-stop"></a>
## debug.stop

Stop the shared workbench and retain debug records

```bash
ohmatecli debug stop --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 manual。

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="debug-streams"></a>
## debug.streams

List all saved event streams with committed integrity and no authentication recovery

```bash
ohmatecli debug streams --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 manual。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `id` | 是 | 否 |

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--after <value>` | Exclusive stream UUID cursor | 未声明 | 否 |
| `--limit <value>` | Maximum streams returned (1–64) | 未声明 | 否 |

<a id="deps-analyze"></a>
## deps.analyze

Read OHPM, npm and literal Native dependency evidence without installation

```bash
ohmatecli deps analyze --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 verify-and-retry。

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="deps-audit"></a>
## deps.audit

Audit local dependency evidence; no online vulnerability scan

```bash
ohmatecli deps audit --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 verify-and-retry。

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="deps-sbom"></a>
## deps.sbom

Export the observed three-ecosystem inventory as CycloneDX 1.6 or SPDX 2.3

```bash
ohmatecli deps sbom --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 verify-and-retry。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--standard <value>` | cyclonedx (default) or spdx | 未声明 | 否 |

<a id="deps-why"></a>
## deps.why

Explain a package through recorded incoming dependency chains

```bash
ohmatecli deps why --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 verify-and-retry。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--name <value>` | Package name or component identity | 未声明 | 否 |

<a id="deveco-auth"></a>
## deveco.auth

Authentication commands (login, logout, status, team)

```bash
ohmatecli auth --help
```

风险 R3；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 manual。

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="deveco-auth-login"></a>
## deveco.auth.login

Log in to your Huawei Developer account

```bash
ohmatecli auth login --help
```

风险 R3；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--no-prompt` | Open the browser immediately without the interactive Enter confirmation (agents and non-interactive terminals) | 未声明 | 否 |

<a id="deveco-auth-logout"></a>
## deveco.auth.logout

Log out of your Huawei Developer account

```bash
ohmatecli auth logout --help
```

风险 R3；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 manual。

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="deveco-auth-status"></a>
## deveco.auth.status

Show the currently logged-in user

```bash
ohmatecli auth status --help
```

风险 R0；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 verify-and-retry。

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="deveco-auth-team"></a>
## deveco.auth.team

Team-related commands

```bash
ohmatecli auth team --help
```

风险 R3；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 manual。

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="deveco-auth-team-list"></a>
## deveco.auth.team.list

List team accounts the current user has joined

```bash
ohmatecli auth team list --help
```

风险 R0；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 verify-and-retry。

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="deveco-build"></a>
## deveco.build

Build through bundled DevEco adapters with approval and immutable provenance

```bash
ohmatecli build --help
```

风险 R2；前提 project, toolchain；超时 1800000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--product <value>` | Declared product | 未声明 | 否 |
| `--modules <value...>` | module@target selections | 未声明 | 否 |
| `--build-mode <value>` | Declared build mode | 未声明 | 否 |
| `--assemble-type <value>` | Observed official assemble task | 未声明 | 否 |
| `--signing-config <value>` | Declared signing reference; requires R3 and is restored after the build | 未声明 | 否 |

<a id="deveco-build-clean"></a>
## deveco.build.clean

Clean HarmonyOS project build outputs

```bash
ohmatecli build clean --help
```

风险 R3；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--mode <mode>` | hvigor --mode value (default: module) | 未声明 | 否 |
| `--modules <modules...>` | Scope clean to specific modules | 未声明 | 否 |

<a id="deveco-check"></a>
## deveco.check

Run DevEco project checks

```bash
ohmatecli check --help
```

风险 R3；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 manual。

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="deveco-check-arkts"></a>
## deveco.check.arkts

Run ArkTS static checks on .ets source files

```bash
ohmatecli check arkts --help
```

风险 R3；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 manual。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `files` | 否 | 是 |

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--fix` | Auto-fix high-confidence errors before reporting | 未声明 | 否 |
| `--project <path>` | Project root directory (default: auto-detected from cwd) | 未声明 | 否 |

<a id="deveco-check-compat"></a>
## deveco.check.compat

Check source code compatibility against a target SDK version. By default, performs a project-level scan; pass positional `files...` for file-level scanning; pass `--modules` for module-level scanning.

```bash
ohmatecli check compat --help
```

风险 R1；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 manual。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `files` | 否 | 是 |

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--source-version <version>` | Current project SDK version (required; use `compat versions` to list available versions). On zsh, quote the value because version strings contain parentheses; run `compat versions` first to copy a real example. | 未声明 | 否 |
| `--target-version <version>` | Target SDK version (required; use `compat versions` to list available versions). On zsh, quote the value because version strings contain parentheses; run `compat versions` first to copy a real example. | 未声明 | 否 |
| `--modules <modules...>` | Modules to check (default: all modules in the project). Mutually exclusive with positional file arguments. | 未声明 | 否 |
| `--format <format>` | Output format: "json" or "default" (text) for console; "csv", "json", or "default" for file output (--output-path). "csv" requires --output-path. | `"default"` | 否 |
| `--output-path <path>` | Directory to write the detailed report CSV to (default: ./compat-output) | 未声明 | 否 |
| `--limit <num>` | Maximum number of change records to display (default: 100) | `100` | 否 |

<a id="deveco-check-compat-versions"></a>
## deveco.check.compat.versions

List all available target SDK versions for compatibility checking

```bash
ohmatecli check compat versions --help
```

风险 R3；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--format <format>` | Output format: default or json | 未声明 | 否 |

<a id="deveco-check-lint"></a>
## deveco.check.lint

Run DevEco Code Linter checks for TS/ArkTS code

```bash
ohmatecli check lint --help
```

风险 R3；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 manual。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `path` | 否 | 否 |

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--fix` | Auto-fix fixable code issues | 未声明 | 否 |
| `--incremental` | Only check uncommitted files | 未声明 | 否 |
| `--config-path <path>` | Path to lint configuration file | 未声明 | 否 |
| `--product <product>` | Product name defined in build-profile.json5 | `"default"` | 否 |
| `--format <format>` | Report format (choices: default, json) | `"default"` | 否 |
| `--output-path <path>` | Complete report file or directory | 未声明 | 否 |
| `--limit <number>` | Maximum terminal issues to display when --output-path is omitted | 未声明 | 否 |

<a id="deveco-create"></a>
## deveco.create

Review bundled DevEco template files and create an application in an empty target

```bash
ohmatecli create --help
```

风险 R2；前提 无声明前提；超时 300000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--app-name <value>` | ASCII project/application name | 未声明 | 否 |
| `--project-path <value>` | Target below the current project/cwd; real parent must exist | 未声明 | 否 |
| `--bundle-name <value>` | Application bundle name | 未声明 | 否 |
| `--api-level <value>` | Supported template API, or observed SDK API if omitted | 未声明 | 否 |
| `--device-types <value...>` | Supported device types | 未声明 | 否 |

<a id="deveco-device"></a>
## deveco.device

Manage connected devices

```bash
ohmatecli device --help
```

风险 R3；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 manual。

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="deveco-device-app"></a>
## deveco.device.app

Manage apps on a connected device

```bash
ohmatecli device app --help
```

风险 R3；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 manual。

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="deveco-device-app-clearcache"></a>
## deveco.device.app.clearcache

Clear app cache on the device

```bash
ohmatecli device app clearcache --help
```

风险 R3；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--device <name\|serial>` | Target device (name or serial) | 未声明 | 否 |
| `--bundle <name>` | Bundle name | 未声明 | 是 |

<a id="deveco-device-app-cleardata"></a>
## deveco.device.app.cleardata

Clear app data on the device

```bash
ohmatecli device app cleardata --help
```

风险 R3；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--device <name\|serial>` | Target device (name or serial) | 未声明 | 否 |
| `--bundle <name>` | Bundle name | 未声明 | 是 |

<a id="deveco-device-app-foreground"></a>
## deveco.device.app.foreground

Show current foreground app info

```bash
ohmatecli device app foreground --help
```

风险 R3；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--device <name\|serial>` | Target device (name or serial) | 未声明 | 否 |
| `--format <format>` | Output format；取值：`default`, `json` | `"default"` | 否 |

<a id="deveco-device-app-info"></a>
## deveco.device.app.info

Show app info

```bash
ohmatecli device app info --help
```

风险 R3；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 manual。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `bundleName` | 是 | 否 |

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--device <name\|serial>` | Target device (name or serial) | 未声明 | 否 |
| `--format <format>` | Output format；取值：`default`, `json` | `"default"` | 否 |

<a id="deveco-device-app-install"></a>
## deveco.device.app.install

Install package(s) on the device

```bash
ohmatecli device app install --help
```

风险 R3；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 manual。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `files` | 否 | 是 |

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--device <name\|serial>` | Target device (name or serial) | 未声明 | 否 |
| `--replace` | Override install | 未声明 | 否 |
| `--shared <path>` | Inter-app shared HSP path (repeatable) | `[]` | 否 |
| `--wait <seconds>` | Install wait time in seconds | 未声明 | 否 |
| `--user <userId>` | Target user ID | 未声明 | 否 |

<a id="deveco-device-app-list"></a>
## deveco.device.app.list

List installed apps

```bash
ohmatecli device app list --help
```

风险 R3；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--device <name\|serial>` | Target device (name or serial) | 未声明 | 否 |
| `--format <format>` | Output format；取值：`default`, `json` | `"default"` | 否 |

<a id="deveco-device-app-start"></a>
## deveco.device.app.start

Start an app on the device

```bash
ohmatecli device app start --help
```

风险 R3；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--device <name\|serial>` | Target device (name or serial) | 未声明 | 否 |
| `--bundle <name>` | Bundle name (e.g. com.example.app) | 未声明 | 否 |
| `--ability <name>` | Ability to start (-a) | 未声明 | 否 |
| `--action <action>` | Action to send (-A) | 未声明 | 否 |
| `--uri <uri>` | URI to start with (-U) | 未声明 | 否 |

<a id="deveco-device-app-stop"></a>
## deveco.device.app.stop

Stop an app on the device

```bash
ohmatecli device app stop --help
```

风险 R3；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--device <name\|serial>` | Target device (name or serial) | 未声明 | 否 |
| `--bundle <name>` | Bundle name | 未声明 | 是 |

<a id="deveco-device-app-uninstall"></a>
## deveco.device.app.uninstall

Uninstall an app from the device

```bash
ohmatecli device app uninstall --help
```

风险 R3；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--device <name\|serial>` | Target device (name or serial) | 未声明 | 否 |
| `--bundle <name>` | Bundle name | 未声明 | 是 |

<a id="deveco-device-clipboard"></a>
## deveco.device.clipboard

Read, write, or clear the device clipboard

```bash
ohmatecli device clipboard --help
```

风险 R3；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 manual。

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="deveco-device-clipboard-clear"></a>
## deveco.device.clipboard.clear

Clear the device clipboard

```bash
ohmatecli device clipboard clear --help
```

风险 R3；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--device <name\|serial>` | Target device (name or serial) | 未声明 | 否 |

<a id="deveco-device-clipboard-read"></a>
## deveco.device.clipboard.read

Read current clipboard text from the device

```bash
ohmatecli device clipboard read --help
```

风险 R3；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--device <name\|serial>` | Target device (name or serial) | 未声明 | 否 |

<a id="deveco-device-clipboard-write"></a>
## deveco.device.clipboard.write

Write text to the device clipboard

```bash
ohmatecli device clipboard write --help
```

风险 R3；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 manual。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `text` | 是 | 否 |

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--device <name\|serial>` | Target device (name or serial) | 未声明 | 否 |

<a id="deveco-device-file"></a>
## deveco.device.file

Transfer files between the host and a connected device

```bash
ohmatecli device file --help
```

风险 R3；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 manual。

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="deveco-device-file-delete"></a>
## deveco.device.file.delete

Delete a file on the device

```bash
ohmatecli device file delete --help
```

风险 R3；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 manual。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `path` | 是 | 否 |

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--device <name\|serial>` | Target device (name or serial) | 未声明 | 否 |

<a id="deveco-device-file-exist"></a>
## deveco.device.file.exist

Check if a file exists on the device

```bash
ohmatecli device file exist --help
```

风险 R3；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 manual。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `path` | 是 | 否 |

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--device <name\|serial>` | Target device (name or serial) | 未声明 | 否 |

<a id="deveco-device-file-recv"></a>
## deveco.device.file.recv

Receive a file from a device to the host

```bash
ohmatecli device file recv --help
```

风险 R3；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 manual。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `src` | 是 | 否 |
| `dst` | 是 | 否 |

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--device <name\|serial>` | Target device (name or serial) | 未声明 | 否 |

<a id="deveco-device-file-send"></a>
## deveco.device.file.send

Send a local file to a device

```bash
ohmatecli device file send --help
```

风险 R3；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 manual。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `src` | 是 | 否 |
| `dst` | 是 | 否 |

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--device <name\|serial>` | Target device (name or serial) | 未声明 | 否 |

<a id="deveco-device-font"></a>
## deveco.device.font

Manage device fonts

```bash
ohmatecli device font --help
```

风险 R3；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 manual。

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="deveco-device-font-info"></a>
## deveco.device.font.info

Get font name from a font file

```bash
ohmatecli device font info --help
```

风险 R3；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 manual。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `fontpath` | 是 | 否 |

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--device <name\|serial>` | Target device (name or serial) | 未声明 | 否 |

<a id="deveco-device-font-install"></a>
## deveco.device.font.install

Install a font on the device

```bash
ohmatecli device font install --help
```

风险 R3；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 manual。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `fontpath` | 是 | 否 |

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--device <name\|serial>` | Target device (name or serial) | 未声明 | 否 |

<a id="deveco-device-font-uninstall"></a>
## deveco.device.font.uninstall

Uninstall a font from the device

```bash
ohmatecli device font uninstall --help
```

风险 R3；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 manual。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `name` | 是 | 否 |

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--device <name\|serial>` | Target device (name or serial) | 未声明 | 否 |

<a id="deveco-device-list"></a>
## deveco.device.list

List all connected devices

```bash
ohmatecli device list --help
```

风险 R0；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 verify-and-retry。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--format <format>` | Output format；取值：`table`, `json` | `"table"` | 否 |

<a id="deveco-device-open-control-center"></a>
## deveco.device.open-control-center

Open the control center

```bash
ohmatecli device open-control-center --help
```

风险 R3；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--device <name\|serial>` | Target device (name or serial) | 未声明 | 否 |

<a id="deveco-device-open-notification-center"></a>
## deveco.device.open-notification-center

Open the notification center

```bash
ohmatecli device open-notification-center --help
```

风险 R3；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--device <name\|serial>` | Target device (name or serial) | 未声明 | 否 |

<a id="deveco-device-screen"></a>
## deveco.device.screen

Query and manage screen properties

```bash
ohmatecli device screen --help
```

风险 R3；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 manual。

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="deveco-device-screen-rotate"></a>
## deveco.device.screen.rotate

Set screen rotation (clockwise)

```bash
ohmatecli device screen rotate --help
```

风险 R3；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 manual。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `rotation` | 是 | 否 |

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--device <name\|serial>` | Target device (name or serial) | 未声明 | 否 |

<a id="deveco-device-screen-rotation"></a>
## deveco.device.screen.rotation

Query current screen rotation

```bash
ohmatecli device screen rotation --help
```

风险 R3；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--device <name\|serial>` | Target device (name or serial) | 未声明 | 否 |

<a id="deveco-device-screen-rotation-lock"></a>
## deveco.device.screen.rotation-lock

Lock or unlock screen rotation (on=lock/disable auto-rotation, off=unlock/enable auto-rotation)

```bash
ohmatecli device screen rotation-lock --help
```

风险 R3；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 manual。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `state` | 是 | 否 |

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--device <name\|serial>` | Target device (name or serial) | 未声明 | 否 |

<a id="deveco-device-screen-size"></a>
## deveco.device.screen.size

Query screen resolution

```bash
ohmatecli device screen size --help
```

风险 R3；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--device <name\|serial>` | Target device (name or serial) | 未声明 | 否 |
| `--format <format>` | Output format；取值：`default`, `json` | `"default"` | 否 |

<a id="deveco-device-screen-sleeptime"></a>
## deveco.device.screen.sleeptime

Set screen-off timeout in milliseconds; use -1 for never

```bash
ohmatecli device screen sleeptime --help
```

风险 R3；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 manual。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `ms` | 是 | 否 |

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--device <name\|serial>` | Target device (name or serial) | 未声明 | 否 |

<a id="deveco-device-sleep"></a>
## deveco.device.sleep

Turn off the device screen

```bash
ohmatecli device sleep --help
```

风险 R3；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--device <name\|serial>` | Target device (name or serial) | 未声明 | 否 |

<a id="deveco-device-sqlite3"></a>
## deveco.device.sqlite3

Run sqlite3 on a connected device

```bash
ohmatecli device sqlite3 --help
```

风险 R3；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 manual。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `db-path` | 是 | 否 |
| `args` | 否 | 是 |

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--device <name\|serial>` | Target device (name or serial) | 未声明 | 否 |

<a id="deveco-device-status"></a>
## deveco.device.status

Query screen power state

```bash
ohmatecli device status --help
```

风险 R3；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--device <name\|serial>` | Target device (name or serial) | 未声明 | 否 |

<a id="deveco-device-time"></a>
## deveco.device.time

Get or set the device time

```bash
ohmatecli device time --help
```

风险 R3；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 manual。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `datetime` | 否 | 否 |

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--device <name\|serial>` | Target device (name or serial) | 未声明 | 否 |

<a id="deveco-device-timezone"></a>
## deveco.device.timezone

Get or set the device timezone

```bash
ohmatecli device timezone --help
```

风险 R3；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 manual。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `timezone` | 否 | 否 |

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--device <name\|serial>` | Target device (name or serial) | 未声明 | 否 |

<a id="deveco-device-unlock"></a>
## deveco.device.unlock

Unlock the screen

```bash
ohmatecli device unlock --help
```

风险 R3；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--device <name\|serial>` | Target device (name or serial) | 未声明 | 否 |

<a id="deveco-device-view"></a>
## deveco.device.view

Show detailed device information

```bash
ohmatecli device view --help
```

风险 R0；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 verify-and-retry。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `-t, --target <serialOrName>` | Target device serial or device name | 未声明 | 否 |
| `--format <format>` | Output format；取值：`table`, `json` | `"table"` | 否 |

<a id="deveco-device-viewmode"></a>
## deveco.device.viewmode

Get or set the device view mode

```bash
ohmatecli device viewmode --help
```

风险 R3；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 manual。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `mode` | 否 | 否 |

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--device <name\|serial>` | Target device (name or serial) | 未声明 | 否 |

<a id="deveco-device-wake"></a>
## deveco.device.wake

Wake up the device screen

```bash
ohmatecli device wake --help
```

风险 R3；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--device <name\|serial>` | Target device (name or serial) | 未声明 | 否 |

<a id="deveco-docs"></a>
## deveco.docs

HarmonyOS documentation commands (search, read, catalog, update)

```bash
ohmatecli docs --help
```

风险 R3；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 manual。

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="deveco-docs-catalog"></a>
## deveco.docs.catalog

List all available catalogs

```bash
ohmatecli docs catalog --help
```

风险 R0；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 verify-and-retry。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--format <fmt>` | Output format (default, json) | `"default"` | 否 |

<a id="deveco-docs-read"></a>
## deveco.docs.read

Read full content of a document by document ID

```bash
ohmatecli docs read --help
```

风险 R0；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 verify-and-retry。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `documentId` | 是 | 否 |

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="deveco-docs-search"></a>
## deveco.docs.search

Search documentation by keywords

```bash
ohmatecli docs search --help
```

风险 R0；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 verify-and-retry。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `keywords` | 是 | 是 |

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--catalog <name>` | Catalog name (all for all catalogs) | `"all"` | 否 |
| `--format <fmt>` | Output format (default, json) | `"default"` | 否 |
| `--limit <n>` | Max number of results | `10` | 否 |

<a id="deveco-docs-update"></a>
## deveco.docs.update

Update documentation to the latest compatible version

```bash
ohmatecli docs update --help
```

风险 R3；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--force` | Force re-download even if up to date | 未声明 | 否 |
| `--check` | Check for updates without installing | 未声明 | 否 |

<a id="deveco-emulator"></a>
## deveco.emulator

Manage emulator instances

```bash
ohmatecli emulator --help
```

风险 R3；前提 device；超时 1800000 ms；可取消 是；恢复 manual。

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="deveco-emulator-battery"></a>
## deveco.emulator.battery

Set battery level and/or charging status

```bash
ohmatecli emulator battery --help
```

风险 R3；前提 device；超时 1800000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--target <nameOrSerial>` | Target emulator name or serial | 未声明 | 是 |
| `--level <0-100>` | Battery level, SOC (charging: 0-100; not charging: 1-100) | 未声明 | 否 |
| `--status <status>` | Charging status；取值：`charging`, `discharging` | 未声明 | 否 |

<a id="deveco-emulator-create"></a>
## deveco.emulator.create

Create a local emulator instance.

```bash
ohmatecli emulator create --help
```

风险 R2；前提 device；超时 1800000 ms；可取消 是；恢复 manual。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `name` | 是 | 否 |

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--device-type <type>` | Emulator device type (case-insensitive) | 未声明 | 是 |
| `--os-version <version>` | Downloaded image label. which will be quoted in PowerShell (e.g. "HarmonyOS 6.0.1(21)") or be used in the format --os-version="…";For details, run`devecocli emulator image list` | 未声明 | 是 |
| `--path, --instance-path <path>` | Emulator instance path | 未声明 | 否 |
| `--image-root <path>` | Emulator image path | 未声明 | 否 |
| `--screen-profile <model>` | Emulator screen profile | 未声明 | 否 |
| `--screen <config...>` | Screen: "width(px) height(px) DPI screen-diagonal-length(inch)" (720-3500, 720-3500, 240-640, 3.5-9); pass two values for a foldable device | 未声明 | 否 |
| `--storage <size>` | Storage size in GB (2-1023) | 未声明 | 否 |
| `--memory <size>` | Memory size in GB (2-32) | 未声明 | 否 |
| `--hot-boot <boolean>` | Enable or disable hot boot；取值：`true`, `false` | 未声明 | 否 |
| `--force` | Overwrite an existing emulator instance | 未声明 | 否 |

<a id="deveco-emulator-delete"></a>
## deveco.emulator.delete

Delete a local emulator instance

```bash
ohmatecli emulator delete --help
```

风险 R3；前提 device；超时 1800000 ms；可取消 是；恢复 manual。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `name` | 是 | 否 |

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--path, --instance-path <path>` | Emulator instance path | 未声明 | 否 |

<a id="deveco-emulator-fold"></a>
## deveco.emulator.fold

Set foldable display state

```bash
ohmatecli emulator fold --help
```

风险 R3；前提 device；超时 1800000 ms；可取消 是；恢复 manual。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `state` | 是 | 否 |

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--target <nameOrSerial>` | Target emulator name or serial | 未声明 | 是 |

<a id="deveco-emulator-geolocation"></a>
## deveco.emulator.geolocation

Inject geographic coordinates and direction

```bash
ohmatecli emulator geolocation --help
```

风险 R3；前提 device；超时 1800000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--target <nameOrSerial>` | Target emulator name or serial | 未声明 | 是 |
| `--longitude <value>` | Longitude (-180.0 to 180.0) | 未声明 | 否 |
| `--latitude <value>` | Latitude (-90.0 to 90.0) | 未声明 | 否 |
| `--altitude <value>` | Altitude (-10000.0 to 10000.0) | 未声明 | 否 |
| `--direction <value>` | Heading direction in degrees (0.00 to 359.99) | 未声明 | 否 |

<a id="deveco-emulator-image"></a>
## deveco.emulator.image

HarmonyOS emulator system images (download, list, remove)

```bash
ohmatecli emulator image --help
```

风险 R3；前提 device；超时 1800000 ms；可取消 是；恢复 manual。

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="deveco-emulator-image-download"></a>
## deveco.emulator.image.download

Download system image

```bash
ohmatecli emulator image download --help
```

风险 R3；前提 device；超时 1800000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--device-type <type>` | Emulator device type；取值：`phone`, `foldable`, `widefold`, `triplefold`, `tablet`, `2in1`, `2in1 foldable`, `wearable`, `tv` | 未声明 | 否 |
| `--os-version <version>` | Example: HarmonyOS 5.1.1(19) or HarmonyOS 6.0.1(21) (required) | 未声明 | 否 |
| `--force` | Overwrite an existing image | 未声明 | 否 |

<a id="deveco-emulator-image-list"></a>
## deveco.emulator.image.list

List system images

```bash
ohmatecli emulator image list --help
```

风险 R0；前提 device；超时 1800000 ms；可取消 是；恢复 verify-and-retry。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--device-type <type>` | Emulator device type；取值：`phone`, `foldable`, `widefold`, `triplefold`, `tablet`, `2in1`, `2in1 foldable`, `wearable`, `tv` | 未声明 | 否 |
| `--all` | List all images (local and remote) | 未声明 | 否 |
| `--format <format>` | Output format；取值：`table`, `json` | `"table"` | 否 |

<a id="deveco-emulator-image-remove"></a>
## deveco.emulator.image.remove

Remove a downloaded system image

```bash
ohmatecli emulator image remove --help
```

风险 R3；前提 device；超时 1800000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--device-type <type>` | Emulator device type；取值：`phone`, `foldable`, `widefold`, `triplefold`, `tablet`, `2in1`, `2in1 foldable`, `wearable`, `tv` | 未声明 | 是 |
| `--os-version <version>` | Supports both image label (HarmonyOS x.y.z(n)) and softwareVersion | 未声明 | 是 |

<a id="deveco-emulator-license"></a>
## deveco.emulator.license

Review and accept emulator license agreements interactively (prints full text + y/N prompt)

```bash
ohmatecli emulator license --help
```

风险 R3；前提 device；超时 1800000 ms；可取消 是；恢复 manual。

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="deveco-emulator-license-accept"></a>
## deveco.emulator.license.accept

Accept all emulator license agreements non-interactively (skips review and prompt)

```bash
ohmatecli emulator license accept --help
```

风险 R3；前提 device；超时 1800000 ms；可取消 是；恢复 manual。

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="deveco-emulator-license-view"></a>
## deveco.emulator.license.view

Review agreement text (read-only, no changes)

```bash
ohmatecli emulator license view --help
```

风险 R0；前提 device；超时 1800000 ms；可取消 是；恢复 verify-and-retry。

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="deveco-emulator-list"></a>
## deveco.emulator.list

List all emulator instances

```bash
ohmatecli emulator list --help
```

风险 R0；前提 device；超时 1800000 ms；可取消 是；恢复 verify-and-retry。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--details` | Output the raw JSON of `Emulator -list -details` without transformation | 未声明 | 否 |
| `--format <format>` | Output format；取值：`table`, `json` | `"table"` | 否 |

<a id="deveco-emulator-power"></a>
## deveco.emulator.power

Press power button (toggle screen on/off)

```bash
ohmatecli emulator power --help
```

风险 R3；前提 device；超时 1800000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--target <nameOrSerial>` | Target emulator name or serial | 未声明 | 是 |

<a id="deveco-emulator-rotate"></a>
## deveco.emulator.rotate

Rotate emulator

```bash
ohmatecli emulator rotate --help
```

风险 R3；前提 device；超时 1800000 ms；可取消 是；恢复 manual。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `direction` | 是 | 否 |

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--target <nameOrSerial>` | Target emulator name or serial | 未声明 | 是 |

<a id="deveco-emulator-scene"></a>
## deveco.emulator.scene

Start motion simulation scene

```bash
ohmatecli emulator scene --help
```

风险 R3；前提 device；超时 1800000 ms；可取消 是；恢复 manual。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `type` | 是 | 否 |

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--target <nameOrSerial>` | Target emulator name or serial | 未声明 | 是 |

<a id="deveco-emulator-sensor"></a>
## deveco.emulator.sensor

Inject sensor data

```bash
ohmatecli emulator sensor --help
```

风险 R3；前提 device；超时 1800000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--target <nameOrSerial>` | Target emulator name or serial | 未声明 | 是 |
| `--light-intensity <value>` | Light sensor (0 to 100000) | 未声明 | 否 |
| `--humidity <value>` | Humidity sensor (0 to 100) | 未声明 | 否 |
| `--temperature <value>` | Temperature sensor (-273.1 to 100) | 未声明 | 否 |
| `--steps <value>` | Steps sensor (integer 0 to 10000) | 未声明 | 否 |
| `--heartrate <value>` | Heart rate sensor (integer 0 to 255) | 未声明 | 否 |

<a id="deveco-emulator-shake"></a>
## deveco.emulator.shake

Trigger shake event

```bash
ohmatecli emulator shake --help
```

风险 R3；前提 device；超时 1800000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--target <nameOrSerial>` | Target emulator name or serial | 未声明 | 是 |

<a id="deveco-emulator-start"></a>
## deveco.emulator.start

Start one or more emulator instances

```bash
ohmatecli emulator start --help
```

风险 R2；前提 device；超时 1800000 ms；可取消 是；恢复 manual。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `names` | 否 | 是 |

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--hdcport <port>` | hdc port of the emulator, 10000-16555 (Emulator -hdcport) | 未声明 | 否 |
| `--boot-mode <mode>` | Boot mode (Emulator -bootMode): coldboot = cold start keeping user data, snapshot = hot start restoring the last snapshot (needs Quick Boot), reset = wipe data then cold start; overrides the mode chosen when the instance was created；取值：`coldboot`, `snapshot`, `reset` | 未声明 | 否 |
| `--no-window` | Start the emulator without a window (Emulator -noWindow); required on Linux hosts without a GUI | 未声明 | 否 |

<a id="deveco-emulator-stop"></a>
## deveco.emulator.stop

Stop one or more emulator instances (by name or serial,e.g.,127.0.0.1:<port>)

```bash
ohmatecli emulator stop --help
```

风险 R2；前提 device；超时 1800000 ms；可取消 是；恢复 manual。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `names` | 是 | 是 |

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="deveco-emulator-volume"></a>
## deveco.emulator.volume

Change volume

```bash
ohmatecli emulator volume --help
```

风险 R3；前提 device；超时 1800000 ms；可取消 是；恢复 manual。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `direction` | 是 | 否 |

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--target <nameOrSerial>` | Target emulator name or serial | 未声明 | 是 |

<a id="deveco-init"></a>
## deveco.init

Install the deveco-cli skill or configure the deveco-mcp server into AI agents

```bash
ohmatecli init --help
```

风险 R2；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--agent <agents>` | Target agents, comma-separated; installs to all available agents if omitted | 未声明 | 否 |
| `--project <path>` | Project root directory for skill or MCP configuration | 未声明 | 否 |
| `--path <path>` | Path to install the skill directly (cannot be used with --project or --agent) | 未声明 | 否 |
| `--skill` | Install the deveco-cli skill only (same as default behavior; explicit for symmetry with --mcp) | 未声明 | 否 |
| `--mcp` | Configure the deveco-mcp server (syntax checking for .ets and C/C++) only; no skill installation | 未声明 | 否 |
| `-f, --force` | Replace existing Skill content or MCP configuration; create missing target directories | 未声明 | 否 |

<a id="deveco-log"></a>
## deveco.log

Obtain device application logs

```bash
ohmatecli log --help
```

风险 R1；前提 device；超时 0 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--device <device>` | Target device (name or serial) | 未声明 | 否 |
| `--crash` | Only obtain crash logs | 未声明 | 否 |
| `--stack` | Analyze a local sample stack file (requires --path) | 未声明 | 否 |
| `--path <path>` | Local fault log file or directory to analyze (requires --crash or --stack) | 未声明 | 否 |
| `--format <format>` | Output format: default, json, report (plus hilog with --crash) | 未声明 | 否 |
| `--limit <num>` | Max hotspots shown by --stack | 未声明 | 否 |
| `--level <level>` | Log level filter: D, I, W, E, F | 未声明 | 否 |
| `--bundle-name <bundle-name>` | Filter by application bundle name | 未声明 | 否 |
| `--keyword <keyword>` | Keyword filter | 未声明 | 否 |
| `--tail <num>` | Show only the latest N log lines | 未声明 | 否 |
| `--from <start>` | Start offset from now, e.g. 30s, 5m, 2.5m, or 120 | 未声明 | 否 |
| `--to <end>` | End offset from now, e.g. 30s, 5m, 2.5m, or 120 | 未声明 | 否 |
| `--follow` | Follow the log stream in real-time. | 未声明 | 否 |

<a id="deveco-run"></a>
## deveco.run

Build and run the project on a connected device

```bash
ohmatecli run --help
```

风险 R2；前提 device；超时 1800000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--module <modules...>` | Module(s) to run (format: module or module@target) | 未声明 | 否 |
| `--device <device>` | Target device name or serial | 未声明 | 否 |
| `--product <product>` | Product name (default: default) | 未声明 | 否 |
| `--build-mode <mode>` | Build mode (options: debug, release; default: debug) | 未声明 | 否 |
| `--ability <ability>` | Ability name to launch | 未声明 | 否 |
| `--uninstall` | Uninstall existing app before installation | 未声明 | 否 |
| `--skip-build` | Skip build step and deploy existing artifacts | 未声明 | 否 |
| `--apply <fileName>` | Quick-apply changed files via quickfix (incremental hqf) and restart. <fileName> under project .hvigor/ | 未声明 | 否 |
| `--hotreload [action]` | Start hot-reload mode (build+deploy with daemon, then exit). Use "stop" to shut down the hvigor daemon. | 未声明 | 否 |
| `--hotreload-apply <fileName>` | Hot-reload changed files (.hvigor/<fileName> list) via daemon hot compile + signed hqf + quickfix, without restarting the app. | 未声明 | 否 |

<a id="deveco-serve"></a>
## deveco.serve

Host bundled auxiliary protocol servers

```bash
ohmatecli serve --help
```

风险 R3；前提 toolchain；超时 0 ms；可取消 是；恢复 manual。

此入口输出原协议流，错误写入 stderr。

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="deveco-serve-lsp"></a>
## deveco.serve.lsp

Start a bundled LSP language server

```bash
ohmatecli serve lsp --help
```

风险 R1；前提 toolchain；超时 0 ms；可取消 是；恢复 manual。

此入口输出原协议流，错误写入 stderr。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--arkts` | Start the ArkTS language server (ace-server) | 未声明 | 否 |
| `--cpp` | Start the C/C++ language server (clangd) | 未声明 | 否 |
| `--project-path <path>` | project root path (used as-is, no search) | 未声明 | 否 |
| `--auto-detect` | When --project-path is not specified, search the current directory and its subdirectories for the project root (no upward search) | 未声明 | 否 |

<a id="deveco-serve-mcp"></a>
## deveco.serve.mcp

Start a local stdio-based MCP server

```bash
ohmatecli serve mcp --help
```

风险 R1；前提 toolchain；超时 0 ms；可取消 是；恢复 manual。

此入口输出原协议流，错误写入 stderr。

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="deveco-signature"></a>
## deveco.signature

Generate application signature.

```bash
ohmatecli signature --help
```

风险 R3；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 manual。

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="deveco-signature-generate"></a>
## deveco.signature.generate

Automatically generate signing materials and write them to the project configuration.

```bash
ohmatecli signature generate --help
```

风险 R3；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--force` | Force overwrite existing local signing materials. | 未声明 | 否 |
| `--team-id <team-id>` | Specify the team ID to use. | 未声明 | 否 |
| `--product <product>` | Specify the product. The default value is default. | 未声明 | 否 |
| `--type <type>` | Signing type: debug or release (default: debug) | 未声明 | 否 |

<a id="deveco-skills"></a>
## deveco.skills

Manage HarmonyOS skills

```bash
ohmatecli skills --help
```

风险 R3；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 manual。

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="deveco-skills-add"></a>
## deveco.skills.add

Install skills to AI agents

```bash
ohmatecli skills add --help
```

风险 R2；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--all` | Install all available skills | 未声明 | 否 |
| `--agent <agents>` | Target agents, comma-separated; Omit to install to all available agents | 未声明 | 否 |
| `--skill <skill-name>` | Name of the skill to install | 未声明 | 否 |
| `-f, --force` | Replace existing Skill content; create missing project or custom target directories | 未声明 | 否 |
| `--project <path>` | Project root directory for skill installation | 未声明 | 否 |
| `--path <path>` | Path to install the skill directly (cannot be used with --project or --agent) | 未声明 | 否 |

<a id="deveco-skills-find"></a>
## deveco.skills.find

Search skills by keyword

```bash
ohmatecli skills find --help
```

风险 R0；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 verify-and-retry。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `keyword` | 是 | 否 |

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="deveco-skills-list"></a>
## deveco.skills.list

List all available HarmonyOS skills

```bash
ohmatecli skills list --help
```

风险 R0；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 verify-and-retry。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `-l, --long` | Show detailed information including description and installation status | 未声明 | 否 |

<a id="deveco-skills-remove"></a>
## deveco.skills.remove

Remove an installed skill from AI agents

```bash
ohmatecli skills remove --help
```

风险 R3；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--skill <skill-name>` | Name of the skill to remove | 未声明 | 是 |
| `--agent <agents>` | Target agents, comma-separated.Omit to remove from all available agents | 未声明 | 否 |
| `--project <path>` | Project root directory for skill removal | 未声明 | 否 |
| `--path <path>` | Path for skill removal | 未声明 | 否 |

<a id="deveco-ui"></a>
## deveco.ui

Inspect and interact with UI on a connected device

```bash
ohmatecli ui --help
```

风险 R2；前提 device；超时 1800000 ms；可取消 是；恢复 manual。

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="deveco-ui-click"></a>
## deveco.ui.click

Tap at the specified coordinates

```bash
ohmatecli ui click --help
```

风险 R2；前提 device；超时 1800000 ms；可取消 是；恢复 manual。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `x` | 否 | 否 |
| `y` | 否 | 否 |

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--device <name\|serial>` | Target device (name or serial) | 未声明 | 否 |
| `--id <id>` | Node id (auto-resolves to center coordinates) | 未声明 | 否 |
| `--window <windowId>` | Target window id (used with --id) | 未声明 | 否 |

<a id="deveco-ui-dircfling"></a>
## deveco.ui.dircfling

Fling in a specified direction

```bash
ohmatecli ui dircfling --help
```

风险 R2；前提 device；超时 1800000 ms；可取消 是；恢复 manual。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `direction` | 是 | 否 |

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--device <name\|serial>` | Target device (name or serial) | 未声明 | 否 |

<a id="deveco-ui-doubleclick"></a>
## deveco.ui.doubleclick

Double-tap at the specified coordinates

```bash
ohmatecli ui doubleclick --help
```

风险 R2；前提 device；超时 1800000 ms；可取消 是；恢复 manual。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `x` | 否 | 否 |
| `y` | 否 | 否 |

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--device <name\|serial>` | Target device (name or serial) | 未声明 | 否 |
| `--id <id>` | Node id (auto-resolves to center coordinates) | 未声明 | 否 |
| `--window <windowId>` | Target window id (used with --id) | 未声明 | 否 |

<a id="deveco-ui-drag"></a>
## deveco.ui.drag

Drag from one point to another

```bash
ohmatecli ui drag --help
```

风险 R2；前提 device；超时 1800000 ms；可取消 是；恢复 manual。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `x1` | 是 | 否 |
| `y1` | 是 | 否 |
| `x2` | 是 | 否 |
| `y2` | 是 | 否 |

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--device <name\|serial>` | Target device (name or serial) | 未声明 | 否 |
| `--speed <n>` | Swipe speed (pixels per second) | 未声明 | 否 |

<a id="deveco-ui-find"></a>
## deveco.ui.find

Find on-screen element(s) by a selector (e.g. "text=Login,type=Button")

```bash
ohmatecli ui find --help
```

风险 R0；前提 device；超时 1800000 ms；可取消 是；恢复 verify-and-retry。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `selector` | 否 | 否 |

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--device <name\|serial>` | Target device (name or serial) | 未声明 | 否 |
| `--window <windowId>` | Target window id | 未声明 | 否 |
| `--all` | Print all matches instead of the first/indexed one | 未声明 | 否 |
| `--timeout <ms>` | Max wait time in milliseconds for the element to appear | `3000` | 否 |
| `--format <format>` | Output format；取值：`default`, `json` | `"default"` | 否 |

<a id="deveco-ui-fling"></a>
## deveco.ui.fling

Fling from one point to another

```bash
ohmatecli ui fling --help
```

风险 R2；前提 device；超时 1800000 ms；可取消 是；恢复 manual。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `x1` | 是 | 否 |
| `y1` | 是 | 否 |
| `x2` | 是 | 否 |
| `y2` | 是 | 否 |

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--device <name\|serial>` | Target device (name or serial) | 未声明 | 否 |
| `--speed <n>` | Swipe speed (pixels per second) | 未声明 | 否 |

<a id="deveco-ui-layout"></a>
## deveco.ui.layout

Inspect on-screen node(s) for UI testing

```bash
ohmatecli ui layout --help
```

风险 R0；前提 device；超时 1800000 ms；可取消 是；恢复 verify-and-retry。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--device <name\|serial>` | Target device (name or serial) | 未声明 | 否 |
| `--id <id>` | Layout node id | 未声明 | 否 |
| `--window <windowId>` | Target window id | 未声明 | 否 |
| `--all-windows` | Include all windows (mutually exclusive with --window) | 未声明 | 否 |
| `--depth <n>` | Tree depth limit (0=unlimited, 1=root only, 2=root+children) | `0` | 否 |
| `--format <format>` | Output format；取值：`default`, `json` | `"default"` | 否 |
| `--mode <mode>` | Output mode: full \| simplified；取值：`full`, `simplified` | `"simplified"` | 否 |

<a id="deveco-ui-longclick"></a>
## deveco.ui.longclick

Long-press at the specified coordinates

```bash
ohmatecli ui longclick --help
```

风险 R2；前提 device；超时 1800000 ms；可取消 是；恢复 manual。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `x` | 否 | 否 |
| `y` | 否 | 否 |

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--device <name\|serial>` | Target device (name or serial) | 未声明 | 否 |
| `--id <id>` | Node id (auto-resolves to center coordinates) | 未声明 | 否 |
| `--window <windowId>` | Target window id (used with --id) | 未声明 | 否 |

<a id="deveco-ui-screenrecord"></a>
## deveco.ui.screenrecord

Record the screen of a physical device to an MP4 file

```bash
ohmatecli ui screenrecord --help
```

风险 R1；前提 device；超时 1800000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--device <name\|serial>` | Target physical device name or serial; required when multiple devices are connected | 未声明 | 否 |
| `--path <dir\|file.mp4>` | Required writable destination: existing directory or a new .mp4 file | 未声明 | 否 |

<a id="deveco-ui-screenrecord-start"></a>
## deveco.ui.screenrecord.start

Start recording and return immediately (detached)

```bash
ohmatecli ui screenrecord start --help
```

风险 R2；前提 device；超时 1800000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--device <name\|serial>` | Target physical device name or serial; required when multiple devices are connected | 未声明 | 否 |
| `--path <dir\|file.mp4>` | Required writable destination: existing directory or a new .mp4 file | 未声明 | 否 |

<a id="deveco-ui-screenrecord-status"></a>
## deveco.ui.screenrecord.status

Show the recording status without changing it

```bash
ohmatecli ui screenrecord status --help
```

风险 R2；前提 device；超时 1800000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--device <name\|serial>` | Target physical device name or serial; required when multiple devices are connected | 未声明 | 否 |
| `--format <format>` | Output format；取值：`table`, `json` | `"table"` | 否 |

<a id="deveco-ui-screenrecord-stop"></a>
## deveco.ui.screenrecord.stop

Stop the current recording and save the file

```bash
ohmatecli ui screenrecord stop --help
```

风险 R2；前提 device；超时 1800000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--device <name\|serial>` | Target physical device name or serial; required when multiple devices are connected | 未声明 | 否 |
| `--force` | Stop a recording that was not started by this CLI (no download) | 未声明 | 否 |

<a id="deveco-ui-screenshot"></a>
## deveco.ui.screenshot

Capture a screenshot of the device screen

```bash
ohmatecli ui screenshot --help
```

风险 R1；前提 device；超时 1800000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--device <name\|serial>` | Target device name or serial; required when multiple devices are connected | 未声明 | 否 |
| `--display <displayId>` | Target display id; omit for default screen | 未声明 | 否 |
| `--path <path>` | Required directory or PNG file path; destination must be writable | 未声明 | 否 |

<a id="deveco-ui-swipe"></a>
## deveco.ui.swipe

Swipe from one point to another

```bash
ohmatecli ui swipe --help
```

风险 R2；前提 device；超时 1800000 ms；可取消 是；恢复 manual。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `x1` | 是 | 否 |
| `y1` | 是 | 否 |
| `x2` | 是 | 否 |
| `y2` | 是 | 否 |

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--device <name\|serial>` | Target device (name or serial) | 未声明 | 否 |
| `--speed <n>` | Swipe speed (pixels per second) | 未声明 | 否 |

<a id="deveco-ui-text"></a>
## deveco.ui.text

Input text at a target location or the currently focused field

```bash
ohmatecli ui text --help
```

风险 R2；前提 device；超时 1800000 ms；可取消 是；恢复 manual。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `text` | 是 | 否 |
| `x` | 否 | 否 |
| `y` | 否 | 否 |

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--device <name\|serial>` | Target device (name or serial) | 未声明 | 否 |
| `--id <id>` | Node id to target before input (auto-resolves to center) | 未声明 | 否 |
| `--window <windowId>` | Target window id (used with --id) | 未声明 | 否 |

<a id="deveco-ui-wait"></a>
## deveco.ui.wait

Wait: sleep [timeoutMs], or wait for element <selector> [timeoutMs] [--disappear]

```bash
ohmatecli ui wait --help
```

风险 R0；前提 device；超时 1800000 ms；可取消 是；恢复 verify-and-retry。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `args` | 否 | 是 |

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--disappear` | Wait for element to disappear (requires selector) | 未声明 | 否 |
| `--device <name\|serial>` | Target device (name or serial) | 未声明 | 否 |
| `--window <windowId>` | Target window id | 未声明 | 否 |

<a id="deveco-ui-window"></a>
## deveco.ui.window

Manage device windows

```bash
ohmatecli ui window --help
```

风险 R2；前提 device；超时 1800000 ms；可取消 是；恢复 manual。

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="deveco-ui-window-list"></a>
## deveco.ui.window.list

List windows on the device

```bash
ohmatecli ui window list --help
```

风险 R0；前提 device；超时 1800000 ms；可取消 是；恢复 verify-and-retry。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--device <name\|serial>` | Target device (name or serial) | 未声明 | 否 |
| `--format <format>` | Output format；取值：`default`, `json` | `"default"` | 否 |
| `--all` | Show all windows including system windows | 未声明 | 否 |

<a id="deveco-update"></a>
## deveco.update

Update deveco-cli to latest

```bash
ohmatecli update --help
```

风险 R3；前提 无声明前提；超时 1800000 ms；可取消 是；恢复 manual。

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="deveco-verify"></a>
## deveco.verify

Run UI verification on a connected device

```bash
ohmatecli verify --help
```

风险 R3；前提 device；超时 1800000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--test-plan <plan>` | Natural-language test plan describing steps and expected results | 未声明 | 否 |
| `--bundle-name <name>` | Bundle name of the app to be tested | 未声明 | 否 |
| `--no-fresh-start` | Skip relaunching the app before verification | 未声明 | 否 |
| `--device <name\|serial>` | Target device name or serial | 未声明 | 否 |

<a id="deveco-verify-init"></a>
## deveco.verify.init

Configure the vision model for UI verification

```bash
ohmatecli verify init --help
```

风险 R3；前提 device；超时 1800000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--base-url <url>` | Base URL of the vision model | 未声明 | 否 |
| `--model-name <name>` | Vision model name | 未声明 | 否 |
| `--api-key <key>` | API key for the vision model | 未声明 | 否 |

<a id="deveco-verify-log"></a>
## deveco.verify.log

Get verification log by ID

```bash
ohmatecli verify log --help
```

风险 R3；前提 device；超时 1800000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--id <id>` | Verification task ID | 未声明 | 是 |
| `--search-keywords <keywords>` | Filter log by keywords | 未声明 | 否 |
| `--max-log-size <n>` | Max characters to show (-1 for unlimited) | `"5000"` | 否 |

<a id="deveco-verify-screenshot"></a>
## deveco.verify.screenshot

Save verification screenshots by ID

```bash
ohmatecli verify screenshot --help
```

风险 R3；前提 device；超时 1800000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--id <id>` | Verification task ID | 未声明 | 是 |
| `--save-path <path>` | Absolute path to save screenshots | 未声明 | 是 |

<a id="devtools-serve"></a>
## devtools.serve

Compatibility alias of debug start; uses the same owned service

```bash
ohmatecli devtools serve --help
```

风险 R0；前提 无声明前提；超时 30000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--port <value>` | Bind an explicit loopback port (default: random) | 未声明 | 否 |
| `--dev-auto-pair` | Development only: serve one-time invitations to a loopback peer without a TTY | 未声明 | 否 |

<a id="docs-check"></a>
## docs.check

Check documentation or compare a stable public API baseline

```bash
ohmatecli docs check --help
```

风险 R1；前提 project, toolchain；超时 1800000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--modules <value...>` | Declared module names | 未声明 | 否 |
| `--files <value...>` | Exact project source files | 未声明 | 否 |
| `--baseline <value>` | Prior OHMate API model with the same scope | 未声明 | 否 |

<a id="docs-generate"></a>
## docs.generate

Generate public API HTML, index and AI JSON from one official model

```bash
ohmatecli docs generate --help
```

风险 R1；前提 project, toolchain；超时 1800000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--modules <value...>` | Declared module names | 未声明 | 否 |
| `--files <value...>` | Exact project source files | 未声明 | 否 |
| `--baseline <value>` | Prior OHMate API model with the same scope | 未声明 | 否 |

<a id="doctor"></a>
## doctor

Read-only local environment diagnosis

```bash
ohmatecli doctor --help
```

风险 R0；前提 无声明前提；超时 60000 ms；可取消 是；恢复 verify-and-retry。

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="extensions-disable"></a>
## extensions.disable

Control an explicitly named extension; unverified executable extensions are blocked

```bash
ohmatecli extensions disable --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 manual。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `id` | 是 | 否 |

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="extensions-enable"></a>
## extensions.enable

Control an explicitly named extension; unverified executable extensions are blocked

```bash
ohmatecli extensions enable --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 manual。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `id` | 是 | 否 |

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="extensions-list"></a>
## extensions.list

List extension verification and enablement state

```bash
ohmatecli extensions list --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 manual。

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="integrate-hvigor"></a>
## integrate.hvigor

Review thin Hvigor tasks calling the shared registry without copying rules

```bash
ohmatecli integrate hvigor --help
```

风险 R2；前提 project；超时 300000 ms；可取消 是；恢复 manual。

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="integrate-runtime"></a>
## integrate.runtime

Preview a Runtime Profile entry; explicit writes require reviewed approval

```bash
ohmatecli integrate runtime --help
```

风险 R0；前提 project；超时 300000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--module <value>` | Declared entry module | 未声明 | 否 |
| `--profile <value>` | release-none, release-core, debug or test | 未声明 | 否 |
| `--write` | Apply the reviewed integration Diff | 未声明 | 否 |

<a id="memory-add"></a>
## memory.add

Explicitly approve a workspace memory

```bash
ohmatecli memory add --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 manual。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `text` | 是 | 否 |

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="memory-list"></a>
## memory.list

List explicitly approved workspace memories

```bash
ohmatecli memory list --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 manual。

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="memory-remove"></a>
## memory.remove

Remove an approved workspace memory

```bash
ohmatecli memory remove --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 manual。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `id` | 是 | 否 |

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="mock-apply"></a>
## mock.apply

Unavailable remote Mock control; device/build authentication is not established

```bash
ohmatecli mock apply --help
```

风险 R2；前提 authenticated-device-build；超时 300000 ms；可取消 是；恢复 manual。

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="mock-plan"></a>
## mock.plan

Dry-run explicitly provided request samples; no observed device traffic or remote approval

```bash
ohmatecli mock plan --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 manual。

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="mock-revoke"></a>
## mock.revoke

Unavailable remote Mock control; device/build authentication is not established

```bash
ohmatecli mock revoke --help
```

风险 R2；前提 authenticated-device-build；超时 300000 ms；可取消 是；恢复 manual。

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="mock-status"></a>
## mock.status

Report unavailable remote Mock state without claiming that no rules are active

```bash
ohmatecli mock status --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 manual。

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="mock-validate"></a>
## mock.validate

Validate bounded exact Mock rules without executing requests or returning bodies

```bash
ohmatecli mock validate --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 manual。

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="model-add"></a>
## model.add

Configure an endpoint using an environment variable reference

```bash
ohmatecli model add --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 manual。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `id` | 是 | 否 |

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--api <value>` | api | 未声明 | 否 |
| `--model <value>` | model | 未声明 | 否 |
| `--endpoint <value>` | endpoint | 未声明 | 否 |
| `--credential-env <value>` | credential-env | 未声明 | 否 |
| `--context-window <value>` | context-window | 未声明 | 否 |
| `--max-tokens <value>` | max-tokens | 未声明 | 否 |

<a id="model-check"></a>
## model.check

Send a small explicit connectivity probe to a configured endpoint

```bash
ohmatecli model check --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 manual。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `id` | 是 | 否 |

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="model-list"></a>
## model.list

List configured BYOK endpoints without resolving credentials

```bash
ohmatecli model list --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 manual。

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="model-remove"></a>
## model.remove

Remove an endpoint and disable it if selected

```bash
ohmatecli model remove --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 manual。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `id` | 是 | 否 |

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="model-select"></a>
## model.select

Explicitly enable a configured BYOK endpoint

```bash
ohmatecli model select --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 manual。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `id` | 是 | 否 |

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="model-trae"></a>
## model.trae

Discover models exposed by the local TRAE extension without selecting or sending a prompt

```bash
ohmatecli model trae --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--endpoint <value>` | Local bridge address shown by the TRAE extension | 未声明 | 否 |

<a id="model-trae-cli"></a>
## model.trae-cli

Discover models from the installed TRAE CLI without selecting or sending a prompt

```bash
ohmatecli model trae-cli --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--executable <value>` | TRAE CLI executable path (default: trae-cli on PATH) | 未声明 | 否 |

<a id="project-inspect"></a>
## project.inspect

Discover evidenced ArkTS, Cloud and Native project facets without running builds

```bash
ohmatecli project inspect --help
```

风险 R0；前提 无声明前提；超时 60000 ms；可取消 是；恢复 verify-and-retry。

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="project-list"></a>
## project.list

List explicitly registered local applications

```bash
ohmatecli project list --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 manual。

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="project-register"></a>
## project.register

Validate and register an explicitly selected application directory

```bash
ohmatecli project register --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 manual。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `path` | 是 | 否 |

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="release-artifacts"></a>
## release.artifacts

Archive selected build artifacts and symbols without overwriting originals

```bash
ohmatecli release artifacts --help
```

风险 R1；前提 project；超时 300000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--product <value>` | Declared Release product | 未声明 | 否 |
| `--modules <value...>` | Declared module@target selections | 未声明 | 否 |
| `--manifest <value>` | Project or private evidence-store build manifest | 未声明 | 否 |
| `--artifacts <value...>` | Explicit build-matched HAP/HAR/HSP/APP files | 未声明 | 否 |
| `--symbols <value...>` | Explicit SourceMap/nameCache/Native symbol files | 未声明 | 否 |

<a id="release-guide"></a>
## release.guide

Generate readiness and manual release steps; no signing or upload

```bash
ohmatecli release guide --help
```

风险 R1；前提 project；超时 300000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--product <value>` | Declared Release product | 未声明 | 否 |
| `--modules <value...>` | Declared module@target selections | 未声明 | 否 |
| `--manifest <value>` | Project or private evidence-store build manifest | 未声明 | 否 |
| `--artifacts <value...>` | Explicit build-matched HAP/HAR/HSP/APP files | 未声明 | 否 |
| `--symbols <value...>` | Explicit SourceMap/nameCache/Native symbol files | 未声明 | 否 |

<a id="release-verify"></a>
## release.verify

Verify all fourteen Release gates from selected source, package and producer evidence

```bash
ohmatecli release verify --help
```

风险 R1；前提 project；超时 300000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--product <value>` | Declared Release product | 未声明 | 否 |
| `--modules <value...>` | Declared module@target selections | 未声明 | 否 |
| `--manifest <value>` | Project or private evidence-store build manifest | 未声明 | 否 |
| `--artifacts <value...>` | Explicit build-matched HAP/HAR/HSP/APP files | 未声明 | 否 |
| `--symbols <value...>` | Explicit SourceMap/nameCache/Native symbol files | 未声明 | 否 |

<a id="replay-import"></a>
## replay.import

Validate and open an offline problem package as a read-only path reference

```bash
ohmatecli replay import --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 verify-and-retry。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--path <value>` | Standalone .ohmate-problem.zip file | 未声明 | 否 |
| `--build-id <value>` | Optional exact build assertion; does not authenticate the build | 未声明 | 否 |

<a id="replay-plan"></a>
## replay.plan

Plan bounded semantic test steps offline; missing local Adapter/build evidence requires manual actions

```bash
ohmatecli replay plan --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--path <value>` | Standalone .ohmate-problem.zip file | 未声明 | 否 |
| `--build-id <value>` | Optional exact build assertion; does not authenticate the build | 未声明 | 否 |
| `--steps <value>` | Optional bounded .ohmate-replay.json semantic test references; no raw input | 未声明 | 否 |

<a id="replay-show"></a>
## replay.show

Read a verified offline event or Kit domain page; no replay actions are performed

```bash
ohmatecli replay show --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--path <value>` | Standalone .ohmate-problem.zip file | 未声明 | 否 |
| `--build-id <value>` | Optional exact build assertion; does not authenticate the build | 未声明 | 否 |
| `--domain <value>` | Optional Kit domain; records are limited to 48 KiB per page | 未声明 | 否 |
| `--file <value>` | Optional listed Kit file within the selected domain; attachments expose metadata only | 未声明 | 否 |
| `--after <value>` | Exclusive event sequence or Kit record ordinal | 未声明 | 否 |
| `--limit <value>` | Page size (1–256) | 未声明 | 否 |

<a id="replay-verify"></a>
## replay.verify

Verify an offline problem package without extraction, execution or authentication recovery

```bash
ohmatecli replay verify --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--path <value>` | Standalone .ohmate-problem.zip file | 未声明 | 否 |
| `--build-id <value>` | Optional exact build assertion; does not authenticate the build | 未声明 | 否 |

<a id="rules-check"></a>
## rules.check

Inspect applicable project rules

```bash
ohmatecli rules check --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--files <value...>` | Files used to resolve nested AGENTS scopes | 未声明 | 否 |

<a id="rules-list"></a>
## rules.list

Inspect applicable project rules

```bash
ohmatecli rules list --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--files <value...>` | Files used to resolve nested AGENTS scopes | 未声明 | 否 |

<a id="scan"></a>
## scan

Run official Code Linter with explicit scope, original evidence and coverage limits

```bash
ohmatecli scan --help
```

风险 R1；前提 project, toolchain；超时 1800000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--modules <value...>` | Declared module names | 未声明 | 否 |
| `--files <value...>` | Exact source files | 未声明 | 否 |
| `--domains <value...>` | Requested scan domains; unavailable domains prevent certification | 未声明 | 否 |
| `--config <value>` | Project JSON5 Code Linter configuration | 未声明 | 否 |

<a id="session-export"></a>
## session.export

Export a redacted conversation snapshot to local product storage

```bash
ohmatecli session export --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 manual。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `id` | 是 | 否 |

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="session-list"></a>
## session.list

List persistent conversations independently of Web

```bash
ohmatecli session list --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 manual。

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="session-resume"></a>
## session.resume

Inspect conversation history and resume context

```bash
ohmatecli session resume --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 manual。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `id` | 是 | 否 |

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="session-show"></a>
## session.show

Inspect conversation history and resume context

```bash
ohmatecli session show --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 manual。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `id` | 是 | 否 |

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="skill-export"></a>
## skill.export

Export a portable Skill from the live registry into immutable private artifacts

```bash
ohmatecli skill export --help
```

风险 R1；前提 无声明前提；超时 300000 ms；可取消 是；恢复 verify-and-retry。

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="skill-verify"></a>
## skill.verify

Check portable Skill integrity, privacy and command drift without executing its files

```bash
ohmatecli skill verify --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--path <value>` | Exported ohmate-cli directory | 未声明 | 否 |

<a id="task-approve"></a>
## task.approve

Persistent task approve

```bash
ohmatecli task approve --help
```

风险 R0；前提 无声明前提；超时 0 ms；可取消 是；恢复 manual。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `id` | 是 | 否 |
| `planId` | 是 | 否 |

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--wait` | Wait for the final task result | 未声明 | 否 |

<a id="task-cancel"></a>
## task.cancel

Persistent task cancel

```bash
ohmatecli task cancel --help
```

风险 R0；前提 无声明前提；超时 0 ms；可取消 是；恢复 manual。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `id` | 是 | 否 |

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--force` | Force cancellation after recording the request | 未声明 | 否 |

<a id="task-events"></a>
## task.events

Persistent task events

```bash
ohmatecli task events --help
```

风险 R0；前提 无声明前提；超时 0 ms；可取消 是；恢复 manual。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `id` | 是 | 否 |

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--after <sequence>` | Read events after this cursor | 未声明 | 否 |

<a id="task-list"></a>
## task.list

Persistent task list

```bash
ohmatecli task list --help
```

风险 R0；前提 无声明前提；超时 0 ms；可取消 是；恢复 manual。

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="task-resume"></a>
## task.resume

Persistent task resume

```bash
ohmatecli task resume --help
```

风险 R0；前提 无声明前提；超时 0 ms；可取消 是；恢复 manual。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `id` | 是 | 否 |

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--wait` | Wait for the final task result | 未声明 | 否 |

<a id="task-show"></a>
## task.show

Persistent task show

```bash
ohmatecli task show --help
```

风险 R0；前提 无声明前提；超时 0 ms；可取消 是；恢复 manual。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `id` | 是 | 否 |

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="task-submit"></a>
## task.submit

Persistent task submit

```bash
ohmatecli task submit --help
```

风险 R0；前提 无声明前提；超时 0 ms；可取消 是；恢复 manual。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `toolId` | 是 | 否 |

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--wait` | Wait for the final task result | 未声明 | 否 |
| `--payload <json>` | Tool input as JSON | 未声明 | 否 |

<a id="test-instrument"></a>
## test.instrument

Run official instrument tests with fresh-result evidence

```bash
ohmatecli test instrument --help
```

风险 R2；前提 project, toolchain；超时 1800000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--modules <value...>` | Module selections | 未声明 | 否 |
| `--files <value...>` | File-scoped tests | 未声明 | 否 |
| `--scope <value...>` | Suite or Suite#method selections | 未声明 | 否 |
| `--no-coverage` | Disable coverage generation | 未声明 | 否 |
| `--asan` | Instrument Test ASan request | 未声明 | 否 |
| `--build-only` | Build the test package without running tests | 未声明 | 否 |
| `--device <value>` | Explicit device; execution requires a verified official selector | 未声明 | 否 |

<a id="test-local"></a>
## test.local

Run official local tests with fresh-result evidence

```bash
ohmatecli test local --help
```

风险 R2；前提 project, toolchain；超时 1800000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--modules <value...>` | Module selections | 未声明 | 否 |
| `--files <value...>` | File-scoped tests | 未声明 | 否 |
| `--scope <value...>` | Suite or Suite#method selections | 未声明 | 否 |
| `--no-coverage` | Disable coverage generation | 未声明 | 否 |
| `--asan` | Instrument Test ASan request | 未声明 | 否 |
| `--build-only` | Build the test package without running tests | 未声明 | 否 |
| `--device <value>` | Explicit device; execution requires a verified official selector | 未声明 | 否 |

<a id="test-plan"></a>
## test.plan

Infer selected literal suites and methods without broadening file scope

```bash
ohmatecli test plan --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--kind <value>` | local or instrument | 未声明 | 否 |
| `--modules <value...>` | Module selections | 未声明 | 否 |
| `--files <value...>` | File-scoped tests | 未声明 | 否 |
| `--scope <value...>` | Suite or Suite#method selections | 未声明 | 否 |
| `--no-coverage` | Disable coverage generation | 未声明 | 否 |
| `--asan` | Instrument Test ASan request | 未声明 | 否 |
| `--build-only` | Build the test package without running tests | 未声明 | 否 |
| `--device <value>` | Explicit device; execution requires a verified official selector | 未声明 | 否 |

<a id="ui-open"></a>
## ui.open

Open the same-runtime local Web workbench without requiring a model or application

```bash
ohmatecli ui --help
```

风险 R0；前提 无声明前提；超时 30000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--port <value>` | Bind an explicit loopback port (default: random) | 未声明 | 否 |
| `--no-open` | Print the one-time browser URL without launching a browser | 未声明 | 否 |

<a id="ui-status"></a>
## ui.status

Read local workbench status without exposing browser capabilities

```bash
ohmatecli ui status --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 manual。

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="ui-stop"></a>
## ui.stop

Stop the owned workbench HTTP service and event streams while preserving tasks

```bash
ohmatecli ui stop --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 manual。

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="workspace-patch"></a>
## workspace.patch

Review and apply bounded text changes with old hashes and recovery evidence

```bash
ohmatecli workspace patch --help
```

风险 R2；前提 无声明前提；超时 300000 ms；可取消 是；恢复 manual。

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="workspace-read"></a>
## workspace.read

Read a bounded public text file within the project root

```bash
ohmatecli workspace read --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 verify-and-retry。

| 位置参数 | 必填 | 多值 |
| --- | --- | --- |
| `path` | 是 | 否 |

无命令专用选项；完整结构化输入以 JSON Schema 为准。

<a id="workspace-recovery-inspect"></a>
## workspace.recovery.inspect

Inspect file hashes from a patch journal without changing files

```bash
ohmatecli workspace recovery inspect --help
```

风险 R0；前提 无声明前提；超时 300000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--journal-id <value>` | Patch journal identity | 未声明 | 否 |

<a id="workspace-recovery-restore"></a>
## workspace.recovery.restore

Review a restore diff and refuse conflicting subsequent edits

```bash
ohmatecli workspace recovery restore --help
```

风险 R2；前提 无声明前提；超时 300000 ms；可取消 是；恢复 manual。

| 选项 | 含义 | 默认值 | 必须提供 |
| --- | --- | --- | --- |
| `--journal-id <value>` | Patch journal identity | 未声明 | 否 |
