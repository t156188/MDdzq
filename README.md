# MDdzq

**App 显示名**：**MDGEM** — **M**ark**D**own · a tiny **gem** for reading `.md` files. 一颗用来阅读 Markdown 的小宝石。

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
│   │   └── icons/                    # icon.ico 嵌进 .exe；icon.png 给 NSIS / 运行时
│   └── README.md
└── .github/workflows/windows-build.yml
```

## App icon

两端共用一张方图作为源（不再常驻仓库；要换图时临时放到根目录 `icon-source.png` 后跑下面的脚本，跑完即可删）。

- Mac：
  - `mac/MDReader/Assets.xcassets/AppIcon.appiconset/*.png`（**真正生效**，asset catalog 编译进 `Assets.car`，`Info.plist` 的 `CFBundleIconName` 指向它）
  - `mac/MDReader/AppIcon.icns`（fallback，`CFBundleIconFile` 指向，现代 macOS 一般用不到，保留无害）
- Win：
  - `win/src-tauri/icons/icon.ico`（多分辨率 16/32/48/64/128/256，嵌进 `.exe`，Explorer / 任务栏显示）
  - `win/src-tauri/icons/icon.png` + `{32,128,256,512}x*.png`（NSIS 安装器 / 运行时 fallback）

`tauri.conf.json` 的 `bundle.icon` 列表只列了 `icon.png` 和 `icon.ico` —— 其它尺寸 PNG 是历史产物，删了也不影响 Win 构建。

## 各端开发

**Mac**

```sh
cd mac
brew install xcodegen          # 仅首次
make build                     # 构建 Release，产物在 build/.../MDGEM.app
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
| `windows-build.yml` | 推 `win/**` 或 `mac/Resources/**`，或手动 | `MDGEM_0.1.0_x64-setup.exe`（NSIS x64）|
| `macos-build.yml` | 推 `mac/**`，或手动 | `MDGEM-arm64.dmg`（Apple Silicon）+ `MDGEM-intel.dmg`（Intel） |

去 Actions 页面对应那次运行的 **Artifacts** 区下载。Mac 两个芯片版本用 matrix build 并行，约 8–12 分钟跑完。

### 本地构建（不走 CI）

- **Mac**：`cd mac && make build`（本机就能编，默认出 Universal Binary）
- **Win**：在 Windows 机器上 `cd win\src-tauri && cargo install tauri-cli --version "^2" --locked && cargo tauri build --bundles nsis`

## 重新生成 icon（换图时）

把新图丢到根目录，然后：

```sh
# 0. 把新图裁成正方形 icon-source.png（1080×1080）。
#    简单居中裁：
sips --setProperty format png --cropToHeightWidth $S $S <新图>.jpg --out icon-source.png  # $S = min(w,h)
#    若主体偏上/偏下，居中裁会切掉头/脚 —— 用 Swift 一行做带偏移裁切（见 git log 找 Claude 之前那段脚本，或直接喂给 Claude 让它处理）

# 1. Mac：刷 asset catalog（真正生效的那份）+ .icns（fallback）
APPSET=mac/MDReader/Assets.xcassets/AppIcon.appiconset
ICONSET=mac/MDReader/AppIcon.iconset
mkdir -p $ICONSET
for s in 16 32 128 256 512; do
  sips -z $s $s   icon-source.png --out $APPSET/icon_${s}x${s}.png
  sips -z $((s*2)) $((s*2)) icon-source.png --out $APPSET/icon_${s}x${s}@2x.png
  cp $APPSET/icon_${s}x${s}.png    $ICONSET/icon_${s}x${s}.png
  cp $APPSET/icon_${s}x${s}@2x.png $ICONSET/icon_${s}x${s}@2x.png
done
iconutil --convert icns $ICONSET --output mac/MDReader/AppIcon.icns
rm -rf $ICONSET

# 2. Win：尺寸 PNG + 多分辨率 ICO
DEST=win/src-tauri/icons
for s in 32 128 256 512; do
  sips -z $s $s icon-source.png --out $DEST/${s}x${s}.png
done
sips -z 512 512 icon-source.png --out $DEST/icon.png
python3 -c "from PIL import Image; \
Image.open('icon-source.png').convert('RGBA').save('$DEST/icon.ico', \
format='ICO', sizes=[(16,16),(32,32),(48,48),(64,64),(128,128),(256,256)])"
# 没装 Pillow：pip install Pillow；或在 Win 机器上用 cargo tauri icon

# 3. 清掉根目录临时图
rm icon-source.png <新图>.jpg
```
