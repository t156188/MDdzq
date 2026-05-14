# MDGEM (Windows)

Windows 版 MDGEM，与同仓库的 macOS `mac/` 并列。**完全复用** Mac 版的前端渲染层（`../mac/Resources/`），仅替换原生壳：`SwiftUI + WKWebView` → `Tauri 2 (Rust) + WebView2`。

UI 与 Mac 版逐像素一致（同一套 HTML/CSS/JS）。

## 功能（与 Mac 版 1:1）

- 文件关联：`.md` / `.markdown` / `.mdown` / `.mkd` / `.mkdn` 五个后缀
- 拖拽 `.md` 到窗口打开
- `Ctrl+O` 打开文件对话框
- 渲染：markdown-it / GFM 表 / 任务列表 / highlight.js / Mermaid / KaTeX
- View → Appearance：Follow System / Light / Dark（**持久化**，存在 `settings.json`）
- View → Zoom In / Out / Actual Size（`Ctrl+=` / `Ctrl+-` / `Ctrl+0`）
- 外链自动用系统默认浏览器打开
- 同时只跑一个实例；再次双击会把文件丢给已运行的窗口
- 最小窗口 520×360
- 标题栏显示当前文件名

## 项目结构

```
win/
└── src-tauri/
    ├── src/
    │   ├── main.rs          # 入口（隐藏 Win 控制台）
    │   ├── lib.rs           # 应用逻辑：菜单 / 文件 / 主题 / 单实例
    │   └── bridge.js        # 注入的桥接 JS：Rust ↔ MDViewerAPI
    ├── Cargo.toml
    ├── tauri.conf.json      # frontendDist 指向 ../../mac/Resources
    ├── capabilities/        # Tauri 2 权限声明
    └── icons/               # 从 dzq050232.jpg 生成的 app icon
```

`.github/workflows/windows-build.yml` 在仓库根。

## 前置

- Rust stable（一次性 `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`）
- Node 18+ —— 只用来构建前端 vendor 包（markdown-it/hljs/katex/mermaid）

Mac 项目的 `build-web/` 把 vendor 产物写到了 `../mac/Resources/vendor/`。如果该目录为空，先去 Mac 项目里跑：

```sh
cd ../mac/build-web && npm install && npm run build
```

## 开发（在 Mac 上跑，验证逻辑）

```sh
cd win/src-tauri
cargo run                                              # 空窗口
cargo run -- ../../mac/Samples/test-sample.md         # 带样例
```

会以 macOS 应用形式启动。UI、文件读、菜单、主题、外链都和最终的 Win 版一致。

## 出 Windows 安装包

Tauri 不支持 Mac → Win 交叉编译（WebView2 SDK 限制）。两条路：

**路 A：在 Windows 机器上构建**

```powershell
cd win\src-tauri
cargo install tauri-cli --version "^2" --locked   # 一次性
cargo tauri build --bundles nsis
```

产物：`src-tauri/target/release/bundle/nsis/MDGEM_0.1.0_x64-setup.exe`

**路 B：GitHub Actions（无需自己有 Win 机器）**

仓库根目录已生成 `.github/workflows/windows-build.yml`。push 到 `main` 或手动 `workflow_dispatch` 触发，artifact 里下载 `.exe`。

## 与 Mac 版的代码关系

| 责任 | Mac (`mac/`) | Windows (`win/`) |
|---|---|---|
| Markdown 渲染、主题、代码高亮、Mermaid、KaTeX | `Resources/`（共享） | 同一份，frontendDist 指过去 |
| 文件读 / 窗口 / 菜单 / 文件关联 | `MarkdownDocument.swift` + `MDReaderApp.swift` + `Commands.swift` + Info.plist | `src-tauri/src/lib.rs` + `tauri.conf.json` |
| Native ↔ JS 桥 | Swift `evaluateJavaScript` | Tauri events + `bridge.js`（注入为 initialization_script） |
| 外链 | `NSWorkspace.shared.open` | `tauri-plugin-opener` |
| 主题持久化 | `@AppStorage` | `tauri-plugin-store`（`settings.json`） |
| 文件关联 | Info.plist `CFBundleDocumentTypes` | `tauri.conf.json` `bundle.fileAssociations` |

## 已知限制 / 后续

- 与 Mac 版一致：只读、无热重载、无滚动位置记忆。
- 图标从 `../dzq050232.jpg`（中心裁剪到正方形）生成，两端共用。需要换图时改 `MDdzq/icon-source.png` 后重跑 icon 生成步骤。
- 安装包约 8–12 MB（自带 WebView2 系统组件由 Win 10/11 提供）。
