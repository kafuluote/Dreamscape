# Insomnia Local

使用 Rust + Tauri 2 + React/TypeScript 构建的本地 API 调试客户端。无需应用帐号，工作区数据保存在本机。

## 主要功能

- HTTP/HTTPS、GraphQL、WebSocket 和 gRPC 调试。
- 请求集合、文件夹、环境变量和响应历史。
- Insomnia、Postman、OpenAPI、HAR 和 cURL 导入，以及数据导出。
- 常用 Insomnia 插件钩子、基础脚本和 Git 同步。

详细兼容范围见 [MIGRATION.md](MIGRATION.md)。

## 开发运行

Windows 开发环境需要 Node.js 24、Rust（MSVC）、Visual Studio C++ Build Tools、Windows SDK 和 WebView2。

```bash
npm ci
npm run dev
```

构建 Windows 安装包：

```bash
npm run desktop:build
```

## 许可证

[Apache-2.0](LICENSE)，项目声明见 [NOTICE](NOTICE)。本项目为独立重构版本，非 Kong 官方发行版。
