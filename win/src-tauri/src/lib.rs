use std::path::{Path, PathBuf};
use std::sync::Mutex;

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

#[derive(Default)]
struct OpenState {
    /// Currently displayed .md file.
    current_file: Mutex<Option<PathBuf>>,
    /// Pinned at the first opened file's parent directory. Sidebar clicks do
    /// not change this — only "new document" entry points (initial argv,
    /// drag-drop, File → Open, single-instance forward).
    workspace_root: Mutex<Option<PathBuf>>,
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

fn pick_md_from_args<I, S>(args: I) -> Option<PathBuf>
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
        let p = PathBuf::from(s);
        if is_markdown_path(&p) {
            return Some(absolutize(p));
        }
    }
    None
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
    "system".to_string()
}

fn write_theme_pref(app: &AppHandle, value: &str) {
    if let Ok(store) = app.store(STORE_FILE) {
        store.set(STORE_KEY_THEME, serde_json::Value::String(value.to_string()));
        let _ = store.save();
    }
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

fn scan_tree(url: &Path, is_root: bool) -> Option<FileTreeNode> {
    let metadata = std::fs::metadata(url).ok()?;
    if metadata.is_dir() {
        let entries = std::fs::read_dir(url).ok()?;
        let mut paths: Vec<PathBuf> = entries
            .filter_map(|r| r.ok().map(|e| e.path()))
            .filter(|p| {
                p.file_name()
                    .and_then(|s| s.to_str())
                    .map(|s| !s.starts_with('.'))
                    .unwrap_or(false)
            })
            .collect();
        // Folders first (alpha), then files (alpha). Mirrors the typical
        // file-tree UI (Explorer, VS Code Explorer, etc.).
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
        let mut children = Vec::new();
        for p in paths {
            if let Some(n) = scan_tree(&p, false) {
                children.push(n);
            }
        }
        if !is_root && children.is_empty() {
            return None;
        }
        Some(FileTreeNode {
            kind: "dir".to_string(),
            name: display_name(url),
            path: url.to_string_lossy().to_string(),
            children: Some(children),
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
    let state = app.state::<OpenState>();
    *state.current_file.lock().unwrap() = Some(path.clone());
    if matches!(mode, LoadMode::NewWorkspace) {
        let new_root = path.parent().map(|p| p.to_path_buf());
        *state.workspace_root.lock().unwrap() = new_root;
    }
    let root = state.workspace_root.lock().unwrap().clone();
    if let Some(root) = root {
        push_file_tree(window, &root, Some(&path));
    }
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
                let js = match id {
                    "zoomIn" => "window.__mdr_zoom = Math.min(3, (window.__mdr_zoom || 1) + 0.1); document.body.style.zoom = window.__mdr_zoom;",
                    "zoomOut" => "window.__mdr_zoom = Math.max(0.4, (window.__mdr_zoom || 1) - 0.1); document.body.style.zoom = window.__mdr_zoom;",
                    _ => "window.__mdr_zoom = 1; document.body.style.zoom = 1;",
                };
                let _ = w.eval(js);
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
    if let Some(p) = paths.into_iter().find(|p| is_markdown_path(p)) {
        if let Some(w) = app.get_webview_window("main") {
            load_file(&w, p, LoadMode::NewWorkspace);
        }
    }
}

const BRIDGE_JS: &str = include_str!("bridge.js");

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let initial_file = pick_md_from_args(std::env::args());

    let app = tauri::Builder::default()
        .manage(OpenState::default())
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
                if let Some(p) = pick_md_from_args(argv) {
                    load_file(&w, p, LoadMode::NewWorkspace);
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

            // Queue any argv file before window opens; JS will pull it once ready.
            if let Some(p) = initial_file.clone() {
                let state = handle.state::<OpenState>();
                *state.current_file.lock().unwrap() = Some(p.clone());
                *state.workspace_root.lock().unwrap() = p.parent().map(|x| x.to_path_buf());
            }

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
