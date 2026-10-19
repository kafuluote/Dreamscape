# Insomnia Local

基于 `H:\mygo\insomnia`（Insomnia 13.3.1，源码提交 `d370ff0a6`）的数据格式与本地 API 调试工作流，以 **Rust + Tauri 2 + React/TypeScript** 重构的独立桌面客户端。

**启动即进入本地工作区，没有应用帐号、登录页面、云会话、订阅校验或登录门槛。** 接口调试所需的 Basic、Bearer、API Key、OAuth 2.0 认证仍然保留。

本项目位于 `H:\mygo\insomniafix`，不会覆盖原始源码或原版 Insomnia 数据库。它是可运行的独立重构版本，并非原版全部功能的等价替换。详细兼容情况见 [MIGRATION.md](MIGRATION.md)。

## 已实现

- HTTP/HTTPS：常见方法、查询参数、请求头、JSON/XML/文本、URL-encoded、multipart 文件上传、二进制文件请求体、代理、超时、取消、TLS 校验、重定向。
- GraphQL：通过 JSON `{query, variables, operationName}` 请求体发送 HTTP 请求。
- WebSocket：自定义握手请求头、接口认证、连接/断开、文本发送、文本/二进制接收、消息时间戳。
- 原生 gRPC：Rust `tonic` + `prost-reflect` + `protox`，不依赖 `grpcurl` 或 `protoc`。支持本地 `.proto`、include 目录、v1/v1alpha 服务反射、方法发现、unary 与流式调用。
- 集合、嵌套文件夹、请求创建/复制/编辑/删除、搜索、多标签页、基础/子环境、文件夹变量、认证继承。
- `{{ _.name }}` / `{{ name }}` / `{{ user.id }}` 变量、嵌套引用、`{{ $uuid }}`、`{{ $timestamp }}`，缺失变量和循环引用明确报错。
- SQLite 自动保存、关闭前保存、单实例保护、响应历史、原始响应下载。Cookie 按集合隔离，会话结束后清除。
- Insomnia v4/v5 JSON/YAML、Postman v2、OpenAPI 2/3、HAR、常用 cURL 导入；原生 JSON/YAML 完整备份和 Insomnia v4 兼容导出。
- 本地 Insomnia CommonJS 插件的 `requestHooks`、`responseHooks`、`context.request`、`context.response`、`context.store` 常用接口。
- `insomnia.environment`、`insomnia.request`、`insomnia.response`、基础断言/测试脚本；顺序执行集合的运行器。
- Git 初始化、状态、保存快照/提交、读取、fast-forward 拉取和推送，使用系统 Git 凭据。

## 开发与构建

Windows 需要 Node.js 24、Rust stable（MSVC）、Visual Studio C++ Build Tools、Windows SDK 和 WebView2。本机已使用 Node 24.21.0 / Rust 1.99.0 验证。其他平台须安装 Tauri 对应构建依赖；当前安装包配置为 Windows NSIS。

```powershell
cd H:\mygo\insomniafix
npm ci
npm run dev
```

```powershell
npm run desktop:build
```

产物：

- `src-tauri/target/release/insomnia-local.exe`：桌面程序，依赖系统 WebView2。
- `src-tauri/target/release/bundle/nsis/Insomnia Local_0.1.0_x64-setup.exe`：Windows 安装包。

只有启用插件/脚本时才需要运行机器安装 Node.js；只有使用 Git 功能时才需要系统 Git。普通 HTTP/WebSocket/gRPC 使用 Rust 引擎，不需要 Node 服务。

`npm run dev:web` 仅启动浏览器界面预览，**不模拟发送请求或保存数据**。完整功能请运行 Tauri 桌面程序。

## 迁移原版数据

1. 在原版 Insomnia 导出集合为 v4 JSON 或 v5 YAML。
2. 启动本程序，点击侧栏“导入”，选择文件。导入会追加新集合，并重新分配 ID，不覆盖现有请求。
3. 检查导入结果中的兼容性提示，选好子环境。gRPC 可以重新选 `.proto`，或直接使用服务反射。
4. 导出一份“Insomnia Local JSON（完整备份）”。未支持资源保存在 `unmigrated` 中，原始请求附在 `source` 中。

本程序不会直接改写原版 NeDB 文件、系统密钥或云端数据。不要把新工作区 SQLite 文件替换进原版目录。

## 插件与脚本

在设置里选择含 `package.json` 的本地插件目录，审核代码后勾选启用。插件依赖请自行在该目录安装。示例见 [examples/insomnia-plugin-local-header](examples/insomnia-plugin-local-header)。

插件在短生命周期 Node 子进程中执行，单次上限 15 秒。**该进程不是安全沙箱**，具有当前用户的 Node.js 权限。默认不启用请求脚本，也不自动启用导入的代码。

请求前脚本：

```javascript
insomnia.environment.set('request_id', require('node:crypto').randomUUID());
insomnia.request.addHeader({ key: 'X-Request-ID', value: insomnia.environment.get('request_id') });
```

响应后脚本：

```javascript
insomnia.test('HTTP 200', () => insomnia.expect(insomnia.response.code).to.equal(200));
insomnia.test('JSON response', () => insomnia.expect(insomnia.response.json()).to.have.property('ok'));
```

## 本地数据与 Git

应用数据位于 Tauri 的用户应用数据目录（Windows 通常为 `%APPDATA%\dev.insomnia.local\workspace.sqlite`），实际目录可在应用“关于”中查看。

环境变量、请求认证和响应历史按原文保存在本机；当前没有原版 Vault 的密钥加密机制。原始响应以文本和 Base64 保存，下载使用原始字节。每次响应默认最多保留 10 MiB（可调至 100 MiB）；超限有截断提示。历史上限 200 条、合计约 100 MiB，每个请求显示最近 50 条。

Git 功能只管理仓库根目录的 `insomnia-local.json`，提交使用 `--only`，不会把用户其他已暂存文件一起提交。首次使用请在终端配置仓库 remote、用户身份和上游分支；应用不弹出终端索取密码。拉取要求工作树干净，且不自动解决分叉历史。读取/拉取后的快照只有经过界面确认才替换当前工作区。

完整备份、兼容导出和 Git 快照都可能含有接口凭据，请选择适当的存放位置和仓库权限。

## 验证

```powershell
npm run lint
npm run type-check
npm test
npm run test:rust
npm run desktop:build
```

测试包括导入层级/环境/兼容导出、重复导入 ID、错误备份和文件夹循环、cURL 引号处理、真实 HTTP 错误响应、真实 WebSocket 回显、真实 gRPC 服务反射/unary/双向流、SQLite 重启恢复、插件脚本断言、跨进程插件存储，以及 Git 不夹带其他暂存文件。

开发用本地回显服务器：`node scripts/echo-server.cjs`，仅监听 `127.0.0.1:4319`。

## 代码结构

| 路径 | 职责 |
| --- | --- |
| `src-tauri/src/http_client.rs` | reqwest HTTP 引擎、接口认证、Cookie、响应限制 |
| `src-tauri/src/grpc.rs` | Protobuf 编译/反射与动态流式 gRPC |
| `src-tauri/src/websocket.rs` | Rust WebSocket 连接、消息、断开 |
| `src-tauri/src/storage.rs` | SQLite 文档与响应历史 |
| `src-tauri/src/template.rs` | 环境变量解析 |
| `src-tauri/src/git.rs` | 原子快照和 Git 操作 |
| `src-tauri/src/plugins.rs` / `scripts/plugin-runner.cjs` | 插件子进程与常用 Insomnia 接口兼容 |
| `src-tauri/src/lib.rs` | Tauri 命令、取消/超时、文件选择、生命周期 |
| `src/importers.ts` | 格式导入、数据校验、导出 |
| `src/App.tsx` / `src/RequestEditor.tsx` | 本地工作区和请求编辑界面 |

参考：[Tauri 2 文档](https://v2.tauri.app/)、[Tonic](https://docs.rs/tonic/)、[prost-reflect](https://docs.rs/prost-reflect/)。

Apache-2.0。保留原项目许可证，参见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。本项目不是 Kong 官方发行版。
