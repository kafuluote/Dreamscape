# 迁移范围与差异

源项目：Insomnia 13.3.1 / `d370ff0a6`。本次迁移采用独立 Rust 桌面引擎，保留核心本地工作流和常见数据格式，不携带 Electron 主进程。

| 原版能力 | 当前状态 | 差异 / 后续工作 |
| --- | --- | --- |
| 应用帐号登录、注册、云会话、组织切换 | 已移除 | 启动直接进入本地工作区，无登录守卫、云 API 客户端、遥测或订阅校验 |
| HTTP/HTTPS | 已实现 | reqwest/rustls；不是 libcurl。没有 NTLM、Digest、SPNEGO、AWS 签名或自定义 CA/mTLS 配置，未知认证明确报错 |
| GraphQL HTTP | 已实现 | 编辑 JSON envelope；没有 schema 浏览器、自动补全和 GraphQL subscription UI |
| URL/Headers/Body/Basic/Bearer/API Key | 已实现 | 支持变量和启停行；原始数据留在 source 便于后续适配 |
| OAuth 2.0 | 部分 | client credentials、password、refresh token 和手工 Access Token；没有浏览器授权码/PKCE、OAuth 1.0 |
| WebSocket | 已实现 | WS/WSS、握手头与常见认证、文本发送、二进制 Base64 接收、自动 Pong；没有 Socket.IO、二进制发送、代理和 Cookie Jar 同步 |
| gRPC | 已实现 | .proto、include、v1/v1alpha reflection、unary/服务端流/客户端流/双向流；客户端流由 JSON 数组一次提交并半关闭，不是交互式逐条追加；TLS 使用系统可信根 |
| 集合/文件夹/请求 | 已实现 | 本地单工作区；无团队组织模型、设计文档编辑器、拖动排序 |
| 环境变量 | 已实现常用语法 | 支持简单变量和嵌套字段；不是完整 Nunjucks/Liquid，复杂 `{% tag %}` 会明确报错；无 Vault 解密/外部密钥源 |
| 插件 | 部分兼容 | CommonJS requestHooks/responseHooks、常用 request/response/store；无模板标签、Electron UI、context.data/network、市场安装、主题扩展；WS 不运行 HTTP 插件钩子 |
| 请求脚本 | 部分兼容 | 常用 insomnia.environment/request/response、同步 test 与基础 expect；不是完整 Insomnia/Chai/Postman SDK，异步 test 不支持 |
| 运行器 | 已实现 | 顺序执行 HTTP/GraphQL/gRPC；不含 CLI Inso、数据文件迭代或完整脚本测试项目 |
| 响应/历史 | 已实现 | 原始字节下载、状态/耗时/大小/头、JSON 格式化、有限历史；文本显示按 UTF-8，非 UTF-8 数据请下载原始字节；无 HTML 执行预览 |
| Cookie | 部分 | 按集合隔离、内存会话 Cookie；不导入原版 Cookie Jar；单独“保存但不发送”时只保存最终响应 Cookie |
| Insomnia v4/v5 导入 | 已实现常用集合 | HTTP/GraphQL/WS/gRPC、文件夹、环境、脚本；不直接读取原 NeDB；未支持资源保留并提示 |
| Postman/OpenAPI/HAR/cURL | 已实现常用格式 | Postman pm.* 脚本需适配；OpenAPI 外部引用/schema/security 不自动展开；不执行 cURL，未知选项明确拒绝 |
| Git 同步 | 已实现本地快照方案 | 使用系统 Git、本地文件 `insomnia-local.json`；不兼容原版 `.insomnia` Git 文件布局、不提供 GUI clone/remote/冲突解决、不自动推送 |
| 云同步/协作/Konnect/AI/Mock/MCP/Socket.IO | 未迁移 | 不提供相关入口；导入遇到相应资源时保留原始数据 |
| 更新器/代码签名/跨平台安装验证 | 未迁移 | Windows 本地构建；macOS/Linux 可后续配置 Tauri 平台打包与验证 |

## 数据完整性

- 导入是追加操作，重新生成 ID 并重连集合、文件夹、环境和请求引用。
- 导入后提示未支持项；完整本地 JSON/YAML 备份保留 `unmigrated` 和请求 `source`。
- Insomnia v4 兼容导出只包含可表达的集合资源，不含本地运行时设置、历史或全部未迁移资源；完整恢复请使用本地格式。
- 无效备份、重复 ID、跨集合错误引用、文件夹循环会在更改现有工作区之前被拒绝。
- SQLite 写入使用事务/WAL；文件导出和 Git 快照使用临时文件原子替换；关闭窗口前刷新最新状态。
- 原项目源码和原版应用数据保持独立。
