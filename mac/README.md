# MDReader

轻量 macOS Markdown 阅读器 — 双击 `.md` 即开。

- SwiftUI 原生壳（macOS 13+）
- WKWebView + markdown-it 渲染层
- 支持：GFM 表格 / 任务列表 / 代码高亮 (highlight.js) / Mermaid 图表 / KaTeX 数学公式
- 跟随系统明暗主题；菜单可强制切换

## 目录结构

```
MDReader/
├── MDReader/          # Swift 源码 + Info.plist + entitlements
├── Resources/         # 内嵌前端（viewer.html/css，vendor 由构建产生）
├── build-web/         # esbuild 打包前端依赖
├── Samples/           # 测试样例 .md
├── project.yml        # xcodegen 工程描述
└── Makefile           # 一键构建入口
```

## 首次构建

需要的工具：

| 工具 | 用途 | 安装 |
|---|---|---|
| Xcode 15+ | 编译 macOS App | App Store |
| Node 18+ | 打包前端依赖 | 已有 |
| xcodegen | 生成 `.xcodeproj` | `brew install xcodegen` |

执行：

```sh
brew install xcodegen      # 仅首次
make build                 # 装 npm 依赖 → esbuild → xcodegen → xcodebuild
make open-sample           # 用 Release 产物打开 Samples/test-sample.md
```

构建产物：`build/Build/Products/Release/MDReader.app`

## 在 Xcode 里开发

```sh
make project
open MDReader.xcodeproj
```

在 Xcode 里直接 ⌘R 运行（前端 vendor 资源只在 `make web` 时重新构建，Xcode 里改 Swift 不触发 npm）。

## 验证清单

跑过 `make open-sample` 后逐项检查 `Samples/test-sample.md`：

1. 双击 `.md` 自动用 MDReader 打开（首次需在 Finder → Get Info 设默认）
2. 表格、任务列表、删除线
3. Python / Swift 代码块有色彩 + 悬停出现 Copy 按钮
4. Mermaid 流程图正常出图
5. 行内 `$E=mc^2$` 与块级积分公式
6. 系统切换浅 / 深主题，渲染同步跟随，无白屏
7. 菜单 Appearance 可强制 Light / Dark / Follow System

## 跨平台未来

`Resources/` 目录可整体移植：

- 前端层 100% 复用（HTML/CSS/JS）
- Swift 壳 → 替换为 Tauri (Rust) 或 Wails (Go)
- 仅需重写 ~150 行原生壳代码（文件关联、菜单、IPC）

## 已知限制 / 后续

- 只读：不支持编辑（按设计）
- 文件变更热重载未接入（`DispatchSource.makeFileSystemObjectSource` 留作 TODO）
- 滚动位置记忆未接入
- 沙盒模式下，`![](pic.png)` 引用同目录图片可工作，跨目录引用受限
