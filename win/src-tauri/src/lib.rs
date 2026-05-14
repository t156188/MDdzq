use std::path::{Path, PathBuf};
use std::sync::Mutex;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{
    AppHandle, DragDropEvent, Emitter, Listener, Manager, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_dialog::{DialogExt, FilePath};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_store::StoreExt;
use url::Url;

const MD_EXTS: &[&str] = &["md", "markdown", "mdown", "mkd", "mkdn"];
const STORE_FILE: &str = "settings.json";
const STORE_KEY_THEME: &str = "themeOverride"; // "system" | "light" | "dark"
const STORE_KEY_ZOOM: &str = "pageZoom";       // 0.4 ..= 3.0
const STORE_KEY_RECENTS: &str = "recentFiles"; // newest-first list of absolute paths
const RECENTS_MAX: usize = 12;

/// Directory names we never recurse into eagerly. They still appear in the
/// tree, but the front-end fetches their children on demand (see
/// `mdreader:scan-dir`). Keeps `node_modules`/build output from freezing the
/// UI when opening large workspaces.
const LAZY_DIR_NAMES: &[&str] = &[
    "node_modules", "dist", "build", "out", "target", "vendor",
    "release", "coverage", "Pods", "DerivedData", "__pycache__",
];

#[derive(Default)]
struct OpenState {
    /// Currently displayed .md file.
    current_file: Mutex<Option<PathBuf>>,
    /// Pinned at the first opened file's parent directory. Sidebar clicks do
    /// not change this — only "new document" entry points (initial argv,
    /// drag-drop, File → Open, single-instance forward).
    workspace_root: Mutex<Option<PathBuf>>,
    /// Recursive FS watcher for the current workspace. Dropping it closes
    /// the underlying handle and lets the consumer thread exit.
    watcher: Mutex<Option<RecommendedWatcher>>,
}

#[derive(Serialize, Clone)]
struct RenderPayload {
    text: String,
    base_dir: String,
}

#[derive(Serialize, Clone)]
struct ThemePayload {
    name: String,
    pref: String,
}

#[derive(Serialize, Clone)]
struct FileTreeNode {
    #[serde(rename = "type")]
    kind: String,
    name: String,
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    children: Option<Vec<FileTreeNode>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    lazy: Option<bool>,
}

#[derive(Serialize, Clone)]
struct ScanDirResult {
    #[serde(rename = "reqId")]
    req_id: String,
    path: String,
    children: Vec<FileTreeNode>,
}

#[derive(Deserialize)]
struct ScanDirRequest {
    path: String,
    #[serde(rename = "reqId")]
    req_id: String,
}

#[derive(Serialize, Clone)]
struct FileTreePayload {
    root: FileTreeNode,
    current: Option<String>,
}

#[derive(Deserialize)]
struct FsOp {
    op: String,
    path: String,
    #[serde(default, rename = "newName")]
    new_name: Option<String>,
}

#[derive(Copy, Clone)]
enum LoadMode {
    /// New document entry point — reset workspace_root to the file's parent.
    NewWorkspace,
    /// Sidebar click inside the existing workspace — keep workspace_root.
    KeepWorkspace,
}

fn is_markdown_path(p: &Path) -> bool {
    p.extension()
        .and_then(|s| s.to_str())
        .map(|s| MD_EXTS.iter().any(|e| e.eq_ignore_ascii_case(s)))
        .unwrap_or(false)
}

fn absolutize(p: PathBuf) -> PathBuf {
    if p.is_absolute() {
        p
    } else {
        std::env::current_dir()
            .ok()
            .map(|c| c.join(&p))
            .unwrap_or(p)
    }
}

/// Pick the first argv entry that points to either a markdown file or a
/// directory. Used both for initial argv and for second-instance forwarding
/// (single-instance plugin).
fn pick_target_from_args<I, S>(args: I) -> Option<PathBuf>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    for (i, a) in args.into_iter().enumerate() {
        if i == 0 {
            continue; // skip exe path
        }
        let s = a.as_ref();
        if s.starts_with('-') {
            continue;
        }
        let p = absolutize(PathBuf::from(s));
        if is_markdown_path(&p) {
            return Some(p);
        }
        if p.is_dir() {
            return Some(p);
        }
    }
    None
}

/// Pick a "default" md inside a folder — README.* wins (case-insensitive),
/// otherwise the first .md/.markdown/... in alpha order. Only the immediate
/// children are inspected — opening a giant tree shouldn't recurse here.
fn find_default_md_in_dir(dir: &Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    let mut files: Vec<PathBuf> = entries
        .filter_map(|r| r.ok().map(|e| e.path()))
        .filter(|p| p.is_file() && is_markdown_path(p))
        .collect();
    files.sort_by(|a, b| {
        a.file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_lowercase()
            .cmp(
                &b.file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_lowercase(),
            )
    });
    // README.<md-ext> first, case-insensitive.
    if let Some(p) = files.iter().find(|p| {
        p.file_stem()
            .and_then(|s| s.to_str())
            .map(|s| s.eq_ignore_ascii_case("README"))
            .unwrap_or(false)
    }) {
        return Some(p.clone());
    }
    files.into_iter().next()
}

fn read_text(path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let mut s = String::from_utf8_lossy(&bytes).into_owned();
    if s.starts_with('\u{feff}') {
        s.remove(0);
    }
    Ok(s)
}

fn read_theme_pref(app: &AppHandle) -> String {
    if let Ok(store) = app.store(STORE_FILE) {
        if let Some(v) = store.get(STORE_KEY_THEME) {
            if let Some(s) = v.as_str() {
                return s.to_string();
            }
        }
    }
    // No stored preference (fresh install) → default to dark.
    "dark".to_string()
}

fn write_theme_pref(app: &AppHandle, value: &str) {
    if let Ok(store) = app.store(STORE_FILE) {
        store.set(STORE_KEY_THEME, serde_json::Value::String(value.to_string()));
        let _ = store.save();
    }
}

fn read_recents(app: &AppHandle) -> Vec<String> {
    if let Ok(store) = app.store(STORE_FILE) {
        if let Some(v) = store.get(STORE_KEY_RECENTS) {
            if let Some(arr) = v.as_array() {
                return arr
                    .iter()
                    .filter_map(|x| x.as_str().map(String::from))
                    .collect();
            }
        }
    }
    Vec::new()
}

fn write_recents(app: &AppHandle, list: &[String]) {
    if let Ok(store) = app.store(STORE_FILE) {
        store.set(STORE_KEY_RECENTS, serde_json::json!(list));
        let _ = store.save();
    }
}

fn add_recent(app: &AppHandle, path: &Path) {
    let p = path.to_string_lossy().to_string();
    if p.is_empty() {
        return;
    }
    let mut list = read_recents(app);
    list.retain(|x| x != &p);
    list.insert(0, p);
    list.truncate(RECENTS_MAX);
    write_recents(app, &list);
    if let Some(w) = app.get_webview_window("main") {
        push_recents(&w, &list);
    }
}

/// Drop entries whose target no longer exists. Cheap to do — we only ever
/// keep RECENTS_MAX paths.
fn prune_recents(app: &AppHandle) {
    let list = read_recents(app);
    let alive: Vec<String> = list
        .into_iter()
        .filter(|p| Path::new(p).exists())
        .collect();
    write_recents(app, &alive);
}

fn push_recents(window: &WebviewWindow, list: &[String]) {
    let _ = window.emit("mdreader:recents", list);
}

fn read_zoom_pref(app: &AppHandle) -> f64 {
    if let Ok(store) = app.store(STORE_FILE) {
        if let Some(v) = store.get(STORE_KEY_ZOOM) {
            if let Some(n) = v.as_f64() {
                return n.clamp(0.4, 3.0);
            }
        }
    }
    1.0
}

fn write_zoom_pref(app: &AppHandle, value: f64) {
    if let Ok(store) = app.store(STORE_FILE) {
        store.set(STORE_KEY_ZOOM, serde_json::json!(value));
        let _ = store.save();
    }
}

fn push_zoom(window: &WebviewWindow, value: f64) {
    let js = format!(
        "window.__mdr_zoom = {z}; document.body.style.zoom = {z};",
        z = value
    );
    let _ = window.eval(&js);
}

fn effective_theme_name(app: &AppHandle, window: &WebviewWindow) -> &'static str {
    match read_theme_pref(app).as_str() {
        "light" => "light",
        "dark" => "dark",
        _ => match window.theme().unwrap_or(tauri::Theme::Light) {
            tauri::Theme::Dark => "dark",
            _ => "light",
        },
    }
}

fn push_theme(window: &WebviewWindow, name: &str, pref: &str) {
    let payload = ThemePayload {
        name: name.to_string(),
        pref: pref.to_string(),
    };
    let _ = window.emit("mdreader:theme", payload);
    let theme = if name == "dark" {
        Some(tauri::Theme::Dark)
    } else {
        Some(tauri::Theme::Light)
    };
    let _ = window.set_theme(theme);
}

fn display_name(p: &Path) -> String {
    p.file_name()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| p.to_string_lossy().to_string())
}

fn is_lazy_dir_name(name: &str) -> bool {
    LAZY_DIR_NAMES.iter().any(|n| *n == name)
}

/// Read + sort the immediate children of `dir`, applying the same hidden-file
/// + lazy-dir rules as the full scan.
fn scan_children(dir: &Path) -> Vec<FileTreeNode> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut paths: Vec<PathBuf> = entries
        .filter_map(|r| r.ok().map(|e| e.path()))
        .filter(|p| {
            p.file_name()
                .and_then(|s| s.to_str())
                .map(|s| !s.starts_with('.'))
                .unwrap_or(false)
        })
        .collect();
    paths.sort_by(|a, b| {
        let a_dir = a.is_dir();
        let b_dir = b.is_dir();
        if a_dir != b_dir {
            return if a_dir {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Greater
            };
        }
        a.file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_lowercase()
            .cmp(
                &b.file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_lowercase(),
            )
    });
    let mut out = Vec::new();
    for p in paths {
        if let Some(n) = scan_tree(&p, false) {
            out.push(n);
        }
    }
    out
}

fn scan_tree(url: &Path, is_root: bool) -> Option<FileTreeNode> {
    let metadata = std::fs::metadata(url).ok()?;
    if metadata.is_dir() {
        // Heavy directory → stub with lazy=true. Root is exempt so opening a
        // file directly inside e.g. `node_modules` still shows a populated
        // sidebar.
        let name = display_name(url);
        if !is_root && is_lazy_dir_name(&name) {
            return Some(FileTreeNode {
                kind: "dir".to_string(),
                name,
                path: url.to_string_lossy().to_string(),
                children: None,
                lazy: Some(true),
            });
        }
        let children = scan_children(url);
        if !is_root && children.is_empty() {
            return None;
        }
        Some(FileTreeNode {
            kind: "dir".to_string(),
            name,
            path: url.to_string_lossy().to_string(),
            children: Some(children),
            lazy: None,
        })
    } else {
        if !is_markdown_path(url) {
            return None;
        }
        Some(FileTreeNode {
            kind: "file".to_string(),
            name: display_name(url),
            path: url.to_string_lossy().to_string(),
            children: None,
            lazy: None,
        })
    }
}

fn push_file_tree(window: &WebviewWindow, workspace_root: &Path, current: Option<&Path>) {
    let Some(root) = scan_tree(workspace_root, true) else {
        return;
    };
    let payload = FileTreePayload {
        root,
        current: current.map(|p| p.to_string_lossy().to_string()),
    };
    let _ = window.emit("mdreader:file-tree", payload);
}

/// Spawn a recursive FS watcher rooted at `root` and a consumer thread that
/// coalesces events inside a 300ms window before refreshing the sidebar tree
/// and (when relevant) re-rendering the currently open file.
fn start_watcher(app: AppHandle, root: PathBuf) -> Option<RecommendedWatcher> {
    let (tx, rx) = std::sync::mpsc::channel::<notify::Result<notify::Event>>();
    let mut watcher: RecommendedWatcher = notify::recommended_watcher(
        move |res: notify::Result<notify::Event>| {
            // If the receiver was dropped (workspace replaced) the send fails
            // and the watcher will be torn down by its owner.
            let _ = tx.send(res);
        },
    )
    .ok()?;
    watcher
        .watch(&root, RecursiveMode::Recursive)
        .ok()?;

    let app_handle = app;
    std::thread::spawn(move || {
        use std::time::{Duration, Instant};
        let debounce = Duration::from_millis(300);
        loop {
            let first = match rx.recv() {
                Ok(v) => v,
                Err(_) => break, // watcher dropped; thread exits cleanly
            };
            let mut paths: Vec<PathBuf> = Vec::new();
            if let Ok(ev) = first {
                paths.extend(ev.paths);
            }
            // Drain everything that arrives inside the debounce window so a
            // burst of writes (npm install, git checkout…) lands in one
            // refresh instead of N.
            let deadline = Instant::now() + debounce;
            loop {
                let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                    break;
                };
                match rx.recv_timeout(remaining) {
                    Ok(Ok(ev)) => paths.extend(ev.paths),
                    Ok(Err(_)) => {}
                    Err(_) => break, // timeout or channel closed
                }
            }
            handle_fs_change(&app_handle, paths);
        }
    });
    Some(watcher)
}

fn handle_fs_change(app: &AppHandle, paths: Vec<PathBuf>) {
    refresh_tree(app);
    let state = app.state::<OpenState>();
    let current = state.current_file.lock().unwrap().clone();
    let Some(cur) = current else { return };
    let cur_canon = std::fs::canonicalize(&cur).unwrap_or_else(|_| cur.clone());
    let touched = paths.iter().any(|p| {
        std::fs::canonicalize(p)
            .map(|c| c == cur_canon)
            .unwrap_or(false)
    });
    if touched {
        if let Some(w) = app.get_webview_window("main") {
            let _ = push_render(&w, &cur);
        }
    }
}

/// Set the workspace root and (re)start the FS watcher. Pass `None` to clear.
fn set_workspace_root(app: &AppHandle, root: Option<PathBuf>) {
    let state = app.state::<OpenState>();
    // Drop the old watcher *first* so its sender closes and the consumer
    // thread exits before a fresh one starts.
    *state.watcher.lock().unwrap() = None;
    *state.workspace_root.lock().unwrap() = root.clone();
    if let Some(path) = root {
        *state.watcher.lock().unwrap() = start_watcher(app.clone(), path);
    }
}

fn refresh_tree(app: &AppHandle) {
    let Some(w) = app.get_webview_window("main") else {
        return;
    };
    let state = app.state::<OpenState>();
    let root = state.workspace_root.lock().unwrap().clone();
    let current = state.current_file.lock().unwrap().clone();
    if let Some(root) = root {
        push_file_tree(&w, &root, current.as_deref());
    }
}

fn push_render(window: &WebviewWindow, path: &Path) -> Result<(), String> {
    let text = read_text(path)?;
    let parent = path.parent().unwrap_or_else(|| Path::new(""));
    // Encode the directory as a file:// URL; JS will rewrite image src to the
    // asset:// protocol so the WebView2/WKWebView page can actually fetch them.
    let base_url = Url::from_directory_path(parent)
        .map(|u| u.to_string())
        .unwrap_or_default();
    let payload = RenderPayload {
        text,
        base_dir: base_url,
    };
    window
        .emit("mdreader:render", payload)
        .map_err(|e| e.to_string())?;

    let title = path
        .file_name()
        .and_then(|s| s.to_str())
        .map(|s| format!("{s} — MDGEM"))
        .unwrap_or_else(|| "MDGEM".to_string());
    let _ = window.set_title(&title);
    Ok(())
}

/// Branch on whether the user pointed us at a file or a directory:
/// - File → existing `load_file` path.
/// - Directory → set workspace_root, auto-open a sensible md inside (if any),
///   and push the file tree so the sidebar comes up populated.
fn load_target(window: &WebviewWindow, path: PathBuf, mode: LoadMode) {
    if path.is_dir() {
        let app = window.app_handle().clone();
        if matches!(mode, LoadMode::NewWorkspace) {
            set_workspace_root(&app, Some(path.clone()));
        }
        if let Some(pick) = find_default_md_in_dir(&path) {
            // Reuse load_file but keep the workspace we just set — sidebar
            // click semantics, not "new workspace from a file's parent".
            load_file(window, pick, LoadMode::KeepWorkspace);
        } else {
            // Folder with no md inside: clear the current document and just
            // refresh the tree.
            let state = app.state::<OpenState>();
            *state.current_file.lock().unwrap() = None;
            let root = state.workspace_root.lock().unwrap().clone();
            if let Some(root) = root {
                push_file_tree(window, &root, None);
            }
        }
    } else {
        load_file(window, path, mode);
    }
}

fn load_file(window: &WebviewWindow, path: PathBuf, mode: LoadMode) {
    let app = window.app_handle().clone();
    if let Err(err) = push_render(window, &path) {
        let _ = app
            .dialog()
            .message(format!("Could not open file:\n{}\n\n{err}", path.display()))
            .kind(tauri_plugin_dialog::MessageDialogKind::Error)
            .title("MDGEM")
            .blocking_show();
        return;
    }
    if matches!(mode, LoadMode::NewWorkspace) {
        let new_root = path.parent().map(|p| p.to_path_buf());
        set_workspace_root(&app, new_root);
    }
    let state = app.state::<OpenState>();
    *state.current_file.lock().unwrap() = Some(path.clone());
    let root = state.workspace_root.lock().unwrap().clone();
    if let Some(root) = root {
        push_file_tree(window, &root, Some(&path));
    }
    add_recent(&app, &path);
}

fn open_file_dialog(window: WebviewWindow) {
    let app = window.app_handle().clone();
    app.dialog()
        .file()
        .add_filter("Markdown", MD_EXTS)
        .pick_file(move |selection| {
            let Some(file) = selection else { return };
            let path = match file {
                FilePath::Path(p) => p,
                FilePath::Url(u) => match u.to_file_path() {
                    Ok(p) => p,
                    Err(_) => return,
                },
            };
            let w = window.clone();
            window
                .run_on_main_thread(move || load_file(&w, path, LoadMode::NewWorkspace))
                .ok();
        });
}

fn toast(window: &WebviewWindow, message: &str, kind: &str) {
    let m = serde_json::to_string(message).unwrap_or_else(|_| "\"\"".to_string());
    let k = serde_json::to_string(kind).unwrap_or_else(|_| "\"info\"".to_string());
    let _ = window.eval(&format!(
        "window.MDViewerAPI && window.MDViewerAPI.toast && window.MDViewerAPI.toast({m}, {k});"
    ));
}

fn reveal_in_explorer(path: &Path) {
    let p = path.to_string_lossy().to_string();
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("explorer.exe")
            .arg(format!("/select,{}", p))
            .spawn();
    }
    #[cfg(target_os = "macos")]
    {
        // Useful when developers run `cargo run` on a Mac to smoke-test logic.
        let _ = std::process::Command::new("open").arg("-R").arg(&p).spawn();
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        if let Some(dir) = path.parent() {
            let _ = std::process::Command::new("xdg-open").arg(dir).spawn();
        }
    }
}

fn handle_fs_op(app: &AppHandle, op: FsOp) {
    let Some(w) = app.get_webview_window("main") else {
        return;
    };
    let path = PathBuf::from(&op.path);
    match op.op.as_str() {
        "reveal" => {
            reveal_in_explorer(&path);
        }
        "copyPath" => {
            // JS already tried navigator.clipboard.writeText and asked us to
            // do it via the platform clipboard.
            let json = serde_json::to_string(&op.path).unwrap_or_default();
            let _ = w.eval(&format!(
                "navigator.clipboard.writeText({json}).then(()=>window.MDViewerAPI.toast('Path copied','info'),()=>window.MDViewerAPI.toast('Could not copy','error'));"
            ));
        }
        "rename" => {
            let Some(new_name) = op.new_name.filter(|s| !s.trim().is_empty()) else {
                toast(&w, "Invalid name", "error");
                return;
            };
            if new_name.contains('/') || new_name.contains('\\') {
                toast(&w, "Name cannot contain / or \\", "error");
                return;
            }
            let parent = path.parent().unwrap_or_else(|| Path::new(""));
            let dst = parent.join(&new_name);
            if dst.exists() {
                toast(&w, "A file with that name already exists", "error");
                return;
            }
            match std::fs::rename(&path, &dst) {
                Ok(_) => {
                    let state = app.state::<OpenState>();
                    let was_current = {
                        let mut cur = state.current_file.lock().unwrap();
                        if cur.as_deref() == Some(path.as_path()) {
                            *cur = Some(dst.clone());
                            true
                        } else {
                            false
                        }
                    };
                    if was_current {
                        let title = dst
                            .file_name()
                            .and_then(|s| s.to_str())
                            .map(|s| format!("{s} — MDGEM"))
                            .unwrap_or_else(|| "MDGEM".to_string());
                        let _ = w.set_title(&title);
                    }
                    refresh_tree(app);
                    toast(&w, "Renamed", "info");
                }
                Err(e) => toast(&w, &format!("Rename failed: {e}"), "error"),
            }
        }
        "delete" => {
            let state = app.state::<OpenState>();
            let is_current = state.current_file.lock().unwrap().as_deref() == Some(path.as_path());
            if is_current {
                toast(&w, "Close the file before deleting it", "error");
                return;
            }
            match trash::delete(&path) {
                Ok(_) => {
                    refresh_tree(app);
                    toast(&w, "Moved to Recycle Bin", "info");
                }
                Err(e) => toast(&w, &format!("Delete failed: {e}"), "error"),
            }
        }
        "newFile" | "newFolder" => {
            let Some(name) = op.new_name
                .as_ref()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
            else {
                toast(&w, "Invalid name", "error");
                return;
            };
            if name.contains('/') || name.contains('\\') {
                toast(&w, "Name cannot contain / or \\", "error");
                return;
            }
            let dst = path.join(&name);
            if dst.exists() {
                toast(&w, "Already exists", "error");
                return;
            }
            let result = if op.op == "newFolder" {
                std::fs::create_dir(&dst)
            } else {
                std::fs::write(&dst, "")
            };
            match result {
                Ok(_) => {
                    refresh_tree(app);
                    toast(&w, "Created", "info");
                }
                Err(e) => toast(&w, &format!("Create failed: {e}"), "error"),
            }
        }
        _ => {}
    }
}

fn rebuild_menu(app: &AppHandle) -> tauri::Result<()> {
    let theme_pref = read_theme_pref(app);
    let is = |v: &str| theme_pref == v;

    let open = MenuItemBuilder::with_id("open", "Open…")
        .accelerator("CmdOrCtrl+O")
        .build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit MDGEM")
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;
    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&open)
        .separator()
        .item(&quit)
        .build()?;

    let copy = MenuItemBuilder::with_id("copy", "Copy")
        .accelerator("CmdOrCtrl+C")
        .build(app)?;
    let select_all = MenuItemBuilder::with_id("selectAll", "Select All")
        .accelerator("CmdOrCtrl+A")
        .build(app)?;
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .item(&copy)
        .item(&select_all)
        .build()?;

    let theme_system = CheckMenuItemBuilder::with_id("theme:system", "Follow System")
        .checked(is("system"))
        .build(app)?;
    let theme_light = CheckMenuItemBuilder::with_id("theme:light", "Light")
        .checked(is("light"))
        .build(app)?;
    let theme_dark = CheckMenuItemBuilder::with_id("theme:dark", "Dark")
        .checked(is("dark"))
        .build(app)?;
    let appearance = SubmenuBuilder::new(app, "Appearance")
        .item(&theme_system)
        .item(&theme_light)
        .item(&theme_dark)
        .build()?;

    let zoom_in = MenuItemBuilder::with_id("zoomIn", "Zoom In")
        .accelerator("CmdOrCtrl+=")
        .build(app)?;
    let zoom_out = MenuItemBuilder::with_id("zoomOut", "Zoom Out")
        .accelerator("CmdOrCtrl+-")
        .build(app)?;
    let zoom_reset = MenuItemBuilder::with_id("zoomReset", "Actual Size")
        .accelerator("CmdOrCtrl+0")
        .build(app)?;

    let toggle_sidebar = MenuItemBuilder::with_id("toggleSidebar", "Toggle Sidebar")
        .accelerator("CmdOrCtrl+B")
        .build(app)?;

    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&toggle_sidebar)
        .separator()
        .item(&appearance)
        .separator()
        .item(&zoom_in)
        .item(&zoom_out)
        .item(&zoom_reset)
        .build()?;

    let about = MenuItemBuilder::with_id("about", "About MDGEM").build(app)?;
    let help_menu = SubmenuBuilder::new(app, "Help").item(&about).build()?;

    let menu = MenuBuilder::new(app)
        .item(&file_menu)
        .item(&edit_menu)
        .item(&view_menu)
        .item(&help_menu)
        .build()?;

    app.set_menu(menu)?;
    Ok(())
}

fn handle_menu_event(app: &AppHandle, id: &str) {
    let window = app.get_webview_window("main");
    match id {
        "open" => {
            if let Some(w) = window {
                open_file_dialog(w);
            }
        }
        "quit" => app.exit(0),
        "copy" => {
            if let Some(w) = window {
                let _ = w.eval("document.execCommand('copy')");
            }
        }
        "selectAll" => {
            if let Some(w) = window {
                let _ = w.eval(
                    "window.MDViewerAPI && window.MDViewerAPI.selectAllContent ? window.MDViewerAPI.selectAllContent() : document.execCommand('selectAll')",
                );
            }
        }
        "zoomIn" | "zoomOut" | "zoomReset" => {
            if let Some(w) = window {
                let cur = read_zoom_pref(app);
                let next = match id {
                    "zoomIn" => (cur + 0.1).min(3.0),
                    "zoomOut" => (cur - 0.1).max(0.4),
                    _ => 1.0,
                };
                // Round to 2 decimals so repeated steps don't drift (0.1+0.1 → 0.2…).
                let next = (next * 100.0).round() / 100.0;
                write_zoom_pref(app, next);
                push_zoom(&w, next);
            }
        }
        "toggleSidebar" => {
            if let Some(w) = window {
                let _ = w.eval(
                    "window.MDViewerAPI && window.MDViewerAPI.toggleSidebar && window.MDViewerAPI.toggleSidebar();",
                );
            }
        }
        "theme:system" | "theme:light" | "theme:dark" => {
            let value = &id["theme:".len()..];
            write_theme_pref(app, value);
            if let Some(w) = app.get_webview_window("main") {
                let name = effective_theme_name(app, &w);
                push_theme(&w, name, value);
            }
            let _ = rebuild_menu(app);
        }
        "about" => {
            let _ = app
                .dialog()
                .message("MDGEM 0.1.0\nMarkdown — a tiny gem for reading .md files.\n\nCopyright © 2026")
                .title("About MDGEM")
                .kind(tauri_plugin_dialog::MessageDialogKind::Info)
                .show(|_| {});
        }
        _ => {}
    }
}

fn handle_drop(app: &AppHandle, paths: Vec<PathBuf>) {
    // Prefer an actual .md drop (most explicit intent); fall back to a
    // dropped directory (treat as workspace).
    let pick = paths
        .iter()
        .find(|p| is_markdown_path(p))
        .cloned()
        .or_else(|| paths.into_iter().find(|p| p.is_dir()));
    if let Some(p) = pick {
        if let Some(w) = app.get_webview_window("main") {
            load_target(&w, p, LoadMode::NewWorkspace);
        }
    }
}

const BRIDGE_JS: &str = include_str!("bridge.js");

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let initial_target = pick_target_from_args(std::env::args());

    let app = tauri::Builder::default()
        .manage(OpenState::default())
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
                if let Some(p) = pick_target_from_args(argv) {
                    load_target(&w, p, LoadMode::NewWorkspace);
                }
            }
        }))
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .on_menu_event(|app, event| handle_menu_event(app, event.id().as_ref()))
        .on_window_event(|window, event| {
            if let WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) = event {
                let app = window.app_handle().clone();
                let paths = paths.clone();
                handle_drop(&app, paths);
            }
        })
        .setup(move |app| {
            let handle = app.handle().clone();
            let _ = rebuild_menu(&handle);

            // Queue any argv target before window opens; JS will pull it once
            // ready. For directories the workspace IS the target; we also
            // pre-pick a default README/first-md so the viewer comes up with
            // something to show.
            if let Some(p) = initial_target.clone() {
                if p.is_dir() {
                    set_workspace_root(&handle, Some(p.clone()));
                    let picked = find_default_md_in_dir(&p);
                    if let Some(file) = picked.as_ref() {
                        add_recent(&handle, file);
                    }
                    let state = handle.state::<OpenState>();
                    *state.current_file.lock().unwrap() = picked;
                } else {
                    set_workspace_root(&handle, p.parent().map(|x| x.to_path_buf()));
                    let state = handle.state::<OpenState>();
                    *state.current_file.lock().unwrap() = Some(p.clone());
                    add_recent(&handle, &p);
                }
            }
            // Drop stale recents (files removed since last session) before the
            // page reads them — keeps the menu honest at startup.
            prune_recents(&handle);

            let _window = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::App("viewer.html".into()),
            )
            .title("MDGEM")
            .inner_size(900.0, 720.0)
            .min_inner_size(520.0, 360.0)
            .resizable(true)
            .initialization_script(BRIDGE_JS)
            .build()?;

            // JS bridge tells us when it's ready; push theme + pending file + tree.
            let h_ready = handle.clone();
            handle.listen_any("mdreader:ready", move |_event| {
                if let Some(w) = h_ready.get_webview_window("main") {
                    let pref = read_theme_pref(&h_ready);
                    let name = effective_theme_name(&h_ready, &w);
                    push_theme(&w, name, &pref);
                    push_zoom(&w, read_zoom_pref(&h_ready));
                    push_recents(&w, &read_recents(&h_ready));
                    let state = h_ready.state::<OpenState>();
                    let pending = state.current_file.lock().unwrap().clone();
                    let root = state.workspace_root.lock().unwrap().clone();
                    if let Some(p) = pending.as_ref() {
                        let _ = push_render(&w, p);
                    }
                    if let Some(root) = root {
                        push_file_tree(&w, &root, pending.as_deref());
                    }
                }
            });

            // External-link forwarder: JS catches link clicks and emits the URL.
            let h_link = handle.clone();
            handle.listen_any("mdreader:open-external", move |event| {
                let raw: String =
                    serde_json::from_str(event.payload()).unwrap_or_default();
                if !raw.is_empty() {
                    let _ = h_link.opener().open_url(raw, None::<&str>);
                }
            });

            // Sidebar file-click forwarder: open inside the existing workspace.
            let h_open = handle.clone();
            handle.listen_any("mdreader:open-file", move |event| {
                let raw: String =
                    serde_json::from_str(event.payload()).unwrap_or_default();
                if raw.is_empty() {
                    return;
                }
                if let Some(w) = h_open.get_webview_window("main") {
                    load_file(&w, PathBuf::from(raw), LoadMode::KeepWorkspace);
                }
            });

            // File-system ops from the sidebar context menu.
            let h_op = handle.clone();
            handle.listen_any("mdreader:fs-op", move |event| {
                let op: FsOp = match serde_json::from_str(event.payload()) {
                    Ok(v) => v,
                    Err(_) => return,
                };
                handle_fs_op(&h_op, op);
            });

            // Lazy-folder expansion: JS asks for the immediate children of a
            // single directory. Run on a worker thread so large folders don't
            // block the event loop.
            let h_scan = handle.clone();
            handle.listen_any("mdreader:scan-dir", move |event| {
                let req: ScanDirRequest = match serde_json::from_str(event.payload()) {
                    Ok(v) => v,
                    Err(_) => return,
                };
                let h = h_scan.clone();
                std::thread::spawn(move || {
                    let path = PathBuf::from(&req.path);
                    let children = if path.is_dir() {
                        scan_children(&path)
                    } else {
                        Vec::new()
                    };
                    if let Some(w) = h.get_webview_window("main") {
                        let _ = w.emit(
                            "mdreader:scan-dir-result",
                            ScanDirResult {
                                req_id: req.req_id,
                                path: req.path,
                                children,
                            },
                        );
                    }
                });
            });

            // Sidebar Recent menu: open a recent file as a brand-new workspace
            // (its parent directory). If the file is gone, prune the list and
            // tell the user.
            let h_recent = handle.clone();
            handle.listen_any("mdreader:open-recent", move |event| {
                let raw: String =
                    serde_json::from_str(event.payload()).unwrap_or_default();
                if raw.is_empty() {
                    return;
                }
                let path = PathBuf::from(&raw);
                if let Some(w) = h_recent.get_webview_window("main") {
                    if !path.exists() {
                        toast(&w, "That file no longer exists", "error");
                        prune_recents(&h_recent);
                        push_recents(&w, &read_recents(&h_recent));
                        return;
                    }
                    load_target(&w, path, LoadMode::NewWorkspace);
                }
            });

            // Sidebar theme toggle: JS pushes the user's preference, we
            // persist it, re-resolve effective theme, push back, and
            // rebuild the menu so the checkmark stays in sync.
            let h_theme = handle.clone();
            handle.listen_any("mdreader:set-theme-pref", move |event| {
                let pref: String =
                    serde_json::from_str(event.payload()).unwrap_or_default();
                if pref != "system" && pref != "light" && pref != "dark" {
                    return;
                }
                write_theme_pref(&h_theme, &pref);
                if let Some(w) = h_theme.get_webview_window("main") {
                    let name = effective_theme_name(&h_theme, &w);
                    push_theme(&w, name, &pref);
                }
                let _ = rebuild_menu(&h_theme);
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_handle, _event| {});
}
