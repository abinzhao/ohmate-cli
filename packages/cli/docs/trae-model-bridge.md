# TRAE 本地模型桥

目标是让 OHMate CLI 与 Web 共用现有模型配置和 Agent 工具审批，调用 TRAE
通过公开 `vscode.lm` API 开放给扩展的模型。

CLI 与 Web 的发现、选择和 Agent 请求使用同一 Registry 与 Runtime；
Web 发现保留持久任务回执，模型连接检查绑定所选工程。

- 扩展位于 `extensions/trae-model-bridge/`，不增加 workspace 或运行时依赖。
- 用户从 TRAE 命令面板启动，默认关闭，监听随机端口 `127.0.0.1`。
- Bearer 随机生成并仅驻留内存。只有用户明确复制连接设置时写入剪贴板；
  不读取 IDE 登录信息，不保存密钥，不将密钥放入 CLI 参数或回执。
- `/v1/models` 动态列举公开模型；`/v1/chat/completions` 转换文本、原生工具调用
  与工具结果。工具始终由 OHMate Runtime 执行和审批。
- 每个请求在 TRAE 内经用户确认才调用 `sendRequest`。连接取消、超时和停止扩展
  均取消宿主请求。拒绝非本机地址、浏览器 Origin、重定向、并发与超大请求。
- CLI `model trae --endpoint http://127.0.0.1:<port>/v1` 只发现配置，不自动选择；
  Web 使用相同命令。凭据引用固定为 `OHMATE_TRAE_BRIDGE_KEY`。

验收覆盖：认证与来源限制、模型动态变化、空模型、输入限制、流式文本、
原生工具往返、拒绝授权、取消与清理、CLI 配置幂等、SDK 工具循环、Web
发现/选择/移除及错误反馈、VSIX 文件与哈希。

公开 API 的存在不证明 TRAE 将全部内置模型开放给扩展。宿主未开放时返回空列表，
不使用私有 API 或凭据绕过。宿主未提供用量与价格时保持未知；
`max_tokens` 受宿主能力限制，不作为精确输出预算或计费凭据。
图片、隐藏推理、实际宿主授权与实际模型响应需分别验证。

ByteTech 参考文章当前需要认证，尚未取得正文。本实现依据官方 VS Code Language Model
扩展 API 及本机 TRAE 自带公开类型声明，不宣称复现了该文章。

本地协议、CLI/HTTP/SDK、独立浏览器及 VSIX 内容验证通过；实际 TRAE 宿主与
云模型请求仍待验证。
