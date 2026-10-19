# 验证记录

环境：Windows x64，Node.js 24.21.0 / npm 11.19.0 / Rust 1.99.0。验证日期：2026-10-19（Asia/Shanghai）。

| 检查 | 结果 |
| --- | --- |
| `npm run lint` | 通过（ESLint + rustfmt） |
| `npm run type-check` | 通过 |
| `npm test` | 12 个 Vitest 迁移/导入导出测试 + 3 个 Node 插件子进程测试通过 |
| `cargo test --manifest-path src-tauri/Cargo.toml --offline --quiet` | 12 个 Rust 测试通过 |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --offline --all-targets -- -D warnings` | 通过，无警告 |
| `npm run build` | 通过，React/Vite 生产资源生成成功 |
| Windows release EXE | 编译成功 |
| Windows NSIS 安装包 | 构建成功，`Insomnia Local_0.1.0_x64-setup.exe`，约 5.11 MiB；未执行安装 |
| 桌面启动 | 实际启动已编译的 Tauri EXE，窗口直接显示本地工作区，没有帐号登录入口；SQLite 初始保存状态正常 |
| 桌面交互流程 | 用户按 Esc 停止了 Computer Use，因此没有继续验证 UI 发送、导入对话框和关闭/重启交互；不将这些记作通过 |

Rust 集成测试使用真实本机监听端口，覆盖：

- HTTP POST、查询参数、Bearer 认证、JSON 请求体和 422 错误响应保留。
- multipart 请求头 boundary 修正与真实文件内容上传。
- Cookie 存储、后续发送和禁用发送。
- 大响应截断及 Base64 原始字节一致性、超时。
- WebSocket 握手和文本回显。
- gRPC v1 服务反射、动态 unary、双向流、proto 文件请求、无服务器 proto 方法发现。
- SQLite 关闭连接后重新读取工作区。
- Git 快照提交只包含工作区文件，保留其他已暂存文件，并阻止脏工作树拉取。
- 环境变量递归、缺失变量和循环引用。

前端测试还使用了原项目中的真实 v5 导出 fixture：`tests/fixtures/source-insomnia-v5.yaml`。

安装器初次构建被用户级 NSIS 缓存的重分析点错误阻断。工程已配置 `bundle.useLocalToolsDir=true`，改用项目 `target/.tauri/` 缓存。最终 `npm run desktop:build` 成功，生成 Windows x64 NSIS 安装包；日志保存在 `artifacts/windows-build.log`。

最终交付文件位于 `artifacts/release/`，包含 EXE、安装包及 SHA-256 校验值。

原始 `H:\mygo\insomnia` 的 Git 工作树检查为空，源项目未被修改。
