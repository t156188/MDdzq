# MDdzq

轻量 Markdown 阅读器，双端：

- **`mac/`** — macOS 原生壳（SwiftUI + WKWebView），Apple Silicon。
- **`win/`** — Windows 原生壳（Tauri 2 / Rust + WebView2）。

两端共享 `mac/Resources/` 下的前端渲染层（markdown-it + highlight.js + KaTeX + Mermaid），UI 完全一致。

## 仓库结构

```
MDdzq/
├── mac/                              # macOS 项目（SwiftUI）
│   ├── MDReader/                     # Swift 源 + Info.plist + AppIcon.icns
│   ├── Resources/                    # ⇦ 共享前端 (viewer.html + vendor/*)
│   ├── build-web/                    # esbuild 打包前端 vendor 的脚本
│   ├── Samples/test-sample.md        # 回归测试样例
│   ├── project.yml + Makefile        # xcodegen 配置
│   └── MDReader.xcodeproj
├── win/                              # Windows 项目（Tauri 2）
│   ├── src-tauri/
│   │   ├── src/{main.rs, lib.rs, bridge.js}
│   │   ├── tauri.conf.json           # frontendDist → ../../mac/Resources
│   │   ├── capabilities/default.json
│   │   ├── Cargo.toml / Cargo.lock
│   │   └── icons/                    # 从 dzq050232.jpg 生成
│   └── README.md
├── dzq050232.jpg                     # 原图（1080×1620）
├── icon-source.png                   # 居中裁切后 1080×1080，两端 icon 都从这生成
└── .github/workflows/windows-build.yml
```

## App icon

两端用同一张图：`dzq050232.jpg` →（中心裁正方形）`icon-source.png`。

- Mac：`mac/MDReader/AppIcon.icns`（含 16/32/128/256/512 + @2x，由 `iconutil` 打包）
- Win：`win/src-tauri/icons/{32,128,256,512}x*.png` + `icon.{png,ico}`（RGBA）

替换图标：换 `dzq050232.jpg` 后参考下面"重新生成 icon"一节。

## 各端开发

**Mac**

```sh
cd mac
brew install xcodegen          # 仅首次
make build                     # 构建 Release，产物在 build/.../MDReader.app
make open-sample               # 打开样例文档
```

**Win**（开发期可在 Mac 上 `cargo run` 验证逻辑；最终 `.exe` 必须在 Win 上构建）

```sh
cd win/src-tauri
cargo run -- ../../mac/Samples/test-sample.md
```

详见 `win/README.md`。

## CI 构建产物

仓库根的 `.github/workflows/` 下两个 workflow：

| Workflow | 触发条件 | 产物 |
|---|---|---|
| `windows-build.yml` | 推 `win/**` 或 `mac/Resources/**`，或手动 | `MDReader-Setup-0.1.0.exe`（NSIS x64）|
| `macos-build.yml` | 推 `mac/**`，或手动 | `MDReader-arm64.dmg`（Apple Silicon）+ `MDReader-intel.dmg`（Intel） |

去 Actions 页面对应那次运行的 **Artifacts** 区下载。Mac 两个芯片版本用 matrix build 并行，约 8–12 分钟跑完。

### 本地构建（不走 CI）

- **Mac**：`cd mac && make build`（本机就能编，默认出 Universal Binary）
- **Win**：在 Windows 机器上 `cd win\src-tauri && cargo install tauri-cli --version "^2" --locked && cargo tauri build --bundles nsis`

## 重新生成 icon（换图时）

```sh
# 1. 重做正方形源图
sips --setProperty format png --cropToHeightWidth $S $S dzq050232.jpg --out icon-source.png  # $S = min(w,h)

# 2. Win 端：可直接用 tauri-cli 一键
cd win/src-tauri && cargo tauri icon ../../icon-source.png

# 3. Mac 端：生成 .iconset 后用 iconutil
ICONSET=mac/MDReader/AppIcon.iconset
mkdir -p $ICONSET
for s in 16 32 128 256 512; do
  sips -z $s $s   icon-source.png --out $ICONSET/icon_${s}x${s}.png
  sips -z $((s*2)) $((s*2)) icon-source.png --out $ICONSET/icon_${s}x${s}@2x.png
done
iconutil --convert icns $ICONSET --output mac/MDReader/AppIcon.icns
rm -rf $ICONSET
```
