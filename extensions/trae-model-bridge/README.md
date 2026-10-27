# OHMate TRAE Model Bridge

连接 TRAE 通过公开 `vscode.lm` API 开放给扩展的模型，让 OHMate CLI 与 Web
使用同一套文本、流式响应、工具合同和任务审批。

1. 在 TRAE 的扩展管理中使用“从 VSIX 安装”，选择本扩展文件。
2. 命令面板运行 `OHMate: 启动 TRAE 模型桥`。
3. 运行 `OHMate: 复制模型桥连接设置（含临时密钥）`，选择终端类型，
   将设置粘贴到自己的私有终端执行。
4. 使用 `ohmatecli model select <配置ID>` 选择发现的模型；
   `ohmatecli model check <配置ID>` 检查实际连接。
5. 从同一终端运行 `ohmatecli ui --no-open`，在 Web 中选择模型；
   或使用 CLI `context preview` / `agent run`。
6. 每个模型请求会在 TRAE 中弹出本次授权确认。结束后运行
   `OHMate: 停止 TRAE 模型桥`。

Web 的“发现 TRAE 模型”只需填写扩展显示的地址，密钥仍由服务进程环境变量提供。
扩展重启会改变随机端口和密钥，需要重新复制设置、发现模型并重启 Web 服务。
旧配置可在模型列表中删除。

默认关闭、只监听 `127.0.0.1`、拒绝浏览器直接调用，不读取或保存 IDE
Token。临时桥密钥仅驻留内存，显式复制时进入剪贴板；请勿把连接设置发送给助手。
响应与请求不进入扩展日志。断开、超时或停止会取消模型请求。

工具在 OHMate 中执行，扩展只转发模型调用意图。模型无法直接调用 IDE 工具。
图片和隐藏推理不支持；价格、用量未知。公开 API 不统一定义输出 token 参数，
CLI 的 `maxTokens` 不是宿主侧精确预算；输出有独立字节上限。

**模型范围限制**：API 存在不代表 TRAE 开放全部内置模型。未开放的模型无法通过
此扩展使用；空列表或授权失败会明确提示，不尝试私有接口或凭据绕过。
当前真实 TRAE 授权和云模型调用尚未验证。

开发验证：在产品根运行 `npm run test:trae-bridge`。
打包：`npm run build:trae-bridge`，生成本地 VSIX 和 SHA-256，不自动安装或发布。
