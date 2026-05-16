# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project shape

Dual-platform Markdown reader (display name: **MDGEM**). Two native shells, one shared front-end:

- `mac/` — SwiftUI + WKWebView (macOS 13+)
- `win/` — Tauri 2 (Rust) + WebView2

The front-end (markdown-it + highlight.js + KaTeX + Mermaid + sidebar UI) is **a single bundle that lives under `mac/Resources/`**. The Windows shell points `tauri.conf.json#build.frontendDist` at `../../mac/Resources`, so editing `mac/Resources/` or `mac/build-web/entries/*` ships to both platforms.

## Common commands

**Mac**
```sh
cd mac
make build            # esbuild → xcodegen → xcodebuild Release → MDGEM.app
make open-sample      # opens Samples/test-sample.md in the Release build
make project          # regenerate MDReader.xcodeproj from project.yml
make web              # rebuild the front-end bundle only (vendor/viewer.bundle.js)
make clean            # nukes build/, the generated .xcodeproj, Resources/vendor, build-web/node_modules
```
Build product lives at `mac/build/Build/Products/Release/MDGEM.app`.

**Front-end bundle only** (used by both platforms):
```sh
cd mac/build-web && npm run build    # esbuild → ../Resources/vendor/{viewer,mermaid}.bundle.js + CSS/font copies
```

**Win** (Rust logic runs on macOS for dev; final `.exe` must build on Windows):
```sh
cd win/src-tauri
cargo run -- ../../mac/Samples/test-sample.md
cargo check                          # fast syntax + type check
```
There is no test suite in either shell.

## Architecture

### IPC contract — `window.MDViewerAPI`

The viewer bundle (`mac/build-web/entries/viewer.entry.js`) exposes a stable surface on `window.MDViewerAPI`:
```
render(text, baseDir)      setTheme({name, pref})         setFileTree(payload)
setOutline(items)          onScanDirResult(reqId, p)      toast(msg, kind)
toggleSidebar()            selectAllContent()             scrollToAnchor(id)
```
Both native shells push state in via these calls; the JS calls *back* to native via two different mechanisms:

| Direction | Mac | Win |
|---|---|---|
| Native → JS | `webView.evaluateJavaScript("window.MDViewerAPI…")` | `window.emit("mdreader:*", payload)` → `bridge.js` listens → calls `MDViewerAPI.*` |
| JS → Native | `window.webkit.messageHandlers.<name>.postMessage(...)` | `window.__TAURI__.event.emit("mdreader:*", payload)` → Rust `handle.listen_any(...)` |

`win/src-tauri/src/bridge.js` is injected via `initialization_script` and is the **only** thing translating Tauri's event-based IPC into the `MDViewerAPI` shape. When adding a new IPC: register the script-message handler in `mac/MDReader/MarkdownWebView.swift` AND a `listen_any` in `win/src-tauri/src/lib.rs` AND a translation in `bridge.js`, then expose the result via `MDViewerAPI`. The lazy-folder scan (`scanDir` ↔ `mdreader:scan-dir` / `mdreader:scan-dir-result`) is the canonical example.

### Workspace pinning

`DocumentSession` (mac) and `OpenState.workspace_root` (win) **pin the workspace to the directory the document was first opened from**. Sidebar clicks open files inside the workspace but **do not** change the root. New-workspace entry points are: initial argv, drag-drop onto window, File → Open, single-instance forwarding. Tauri's `LoadMode::{NewWorkspace, KeepWorkspace}` and Swift's `DocumentSession.load(url:)` (which only updates `fileURL`, never `workspaceRoot`) encode this rule.

Folders are valid open targets: `Info.plist` declares `public.folder` (rank `None`, so MDGEM never claims default folder-handler status), `MarkdownDocument` detects `configuration.file.isDirectory` and picks `README.md` (case-insensitive) or the first `.md` alphabetically. The Tauri side mirrors this via `find_default_md_in_dir` + `load_target`. The default `File → Open…` menu only allows files; a separate `File → Open Folder…` (⌘⇧O) uses an `NSOpenPanel` with `canChooseDirectories=true` because SwiftUI's `DocumentGroup` open panel hard-codes folder selection off.

### Lazy file tree

`FileTree.swift` (mac) and `lib.rs#scan_tree` (win) share a hardcoded `LAZY_DIR_NAMES` set: `node_modules, dist, build, out, target, vendor, release, coverage, Pods, DerivedData, __pycache__`. When the scanner enters one of these, it emits a stub node `{type:"dir", lazy:true, children:nil}` and skips recursion. The viewer renders these with a `…` hint; clicking issues a `scanDir` / `mdreader:scan-dir` request with a `reqId`, the backend scans one level off the main thread, and `onScanDirResult` merges the children back into `currentTree`. Without this, opening a typical project froze the UI scanning thousands of `node_modules/*/README.md` files. Keep the two lists in sync if you edit them.

### Build flow specifics

- `mac/project.yml` is the source of truth for the Xcode project. `make build` runs `xcodegen generate` every time, so **do not edit `MDReader.xcodeproj` directly** — it's regenerated from `project.yml`. `Info.plist` and `MDReader.entitlements` are excluded from xcodegen's source globs and edited by hand.
- `Resources/` (with `type: folder`) is copied wholesale into the bundle. `Resources/vendor/` is produced by `mac/build-web/build.mjs` (esbuild) and **gitignored** (`mac/.gitignore`); the `mac/build-web` step runs as part of `make web` / `make build`.
- After Info.plist changes that affect Launch Services (UTI registration, file associations), run `lsregister -f /path/to/MDGEM.app` before testing or macOS may still use the old metadata.
- Win uses `tauri-plugin-single-instance`: a second `open` call is forwarded to the existing window via the closure in `lib.rs`'s `single_instance::init`. Drag-drop is wired through `WindowEvent::DragDrop` on `on_window_event`.

### Version numbers

Five files must move together: `mac/project.yml` (`MARKETING_VERSION`), `mac/MDReader/Info.plist` (`CFBundleShortVersionString`), `mac/build-web/package.json` + `package-lock.json`, `win/src-tauri/Cargo.toml`, `win/src-tauri/tauri.conf.json`. After editing `Cargo.toml`, run `cargo update -p mdreader --offline` to sync `Cargo.lock`.

### Release workflow

Two distinct triggers:

- **"提交" / "提交代码" / "commit"** — stage modified files, draft a commit message, confirm with user, then `git commit` (do **not** push). Adds `Co-Authored-By` per repo convention.
- **"推送" / "提交推送"** — same as above plus `git push origin main`.
- **"发版" / "发布" / "发更新" / "出版本"** — full release flow below.

Plain commit / push paths **do not** touch version numbers, tags, or GitHub Releases.

**Full release flow**, with two confirmation gates:

1. Bump the patch version (1.0.0 → 1.0.1 → … → 1.0.11) across the five manifest files (see "Version numbers"). Run `cargo update -p mdreader --offline` to sync `Cargo.lock`. Only bump minor/major when explicitly asked. Exception: if the current version hasn't shipped (no GitHub Release for it), release as-is — don't bump.
2. **🛑 GATE 1 — version confirmation.** Show the user the new version and wait for confirmation before any commit.
3. On confirm: commit (`Release X.Y.Z: <subject>`) and `git push origin main`. CI auto-triggers from path filters.
4. Watch the runs in the background (`gh run watch`). When all artifacts complete, `gh run download` them and flatten into `release/v<version>/` (e.g. `release/v1.0.0/MDGEM-arm64.dmg`). Commit + push as `Archive X.Y.Z release binaries`. Safe step — repo files only, nothing user-visible yet.
5. Tell the user the three file paths + sizes and ask them to install/test.
6. **🛑 GATE 2 — publish confirmation.** Wait for explicit "OK / 可以发" before step 7. State-check questions like "是不是…?" are *not* approval.
7. On confirm: `git tag -a v<version>` + `gh release create v<version> release/v<version>/* --title "MDGEM X.Y.Z" --notes "…"` + `git push origin v<version>`. Tag and Release are always created together — don't tag earlier (a rejected build would leave an orphan tag).

**If GATE 2 is rejected:** version stays bumped (don't roll back). Next release goes to the *next* patch (rejected 1.0.2 → next attempt is 1.0.3). Optionally `git rm -rf release/v<version>/ && git commit` to drop the unpublished binaries — ask the user first.

## CI

`.github/workflows/macos-build.yml` (matrix: arm64 + intel → two DMGs) triggers on `mac/**` push. `windows-build.yml` (NSIS `.exe`) triggers on `win/**` or `mac/Resources/**` push, since the win shell consumes `mac/Resources/`. Artifacts are in the workflow run's Artifacts panel.
