use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
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
    current_file: Mutex<Option<PathBuf>>,
}

#[derive(Serialize, Clone)]
struct RenderPayload {
    text: String,
    base_dir: String,
}

#[derive(Serialize, Clone)]
struct ThemePayload {
    name: String,
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

fn push_theme(window: &WebviewWindow, name: &str) {
    let payload = ThemePayload {
        name: name.to_string(),
    };
    let _ = window.emit("mdreader:theme", payload);
    let theme = if name == "dark" {
        Some(tauri::Theme::Dark)
    } else {
        Some(tauri::Theme::Light)
    };
    let _ = window.set_theme(theme);
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

fn open_file_into_window(window: &WebviewWindow, path: PathBuf) {
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
    *state.current_file.lock().unwrap() = Some(path);
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
                .run_on_main_thread(move || open_file_into_window(&w, path))
                .ok();
        });
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

    let view_menu = SubmenuBuilder::new(app, "View")
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
                let _ = w.eval("document.execCommand('selectAll')");
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
        "theme:system" | "theme:light" | "theme:dark" => {
            let value = &id["theme:".len()..];
            write_theme_pref(app, value);
            if let Some(w) = app.get_webview_window("main") {
                let name = effective_theme_name(app, &w);
                push_theme(&w, name);
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
            open_file_into_window(&w, p);
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
                    open_file_into_window(&w, p);
                }
            }
        }))
        .plugin(tauri_plugin_store::Builder::default().build())
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
                *state.current_file.lock().unwrap() = Some(p);
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

            // JS bridge tells us when it's ready; we then push theme + pending file.
            let h_ready = handle.clone();
            handle.listen_any("mdreader:ready", move |_event| {
                if let Some(w) = h_ready.get_webview_window("main") {
                    let name = effective_theme_name(&h_ready, &w);
                    push_theme(&w, name);
                    let state = h_ready.state::<OpenState>();
                    let pending = state.current_file.lock().unwrap().clone();
                    if let Some(p) = pending {
                        let _ = push_render(&w, &p);
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

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_handle, _event| {});
}
