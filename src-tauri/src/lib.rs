mod keys;

use std::fs;
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_updater::UpdaterExt;

#[derive(serde::Deserialize)]
pub struct Key {
    pub key: String,
    pub mods: Vec<String>,
}

#[tauri::command]
async fn send_keys(
    keys: Vec<Key>,
    delay_ms: u64,
    window_match: String,
    program_match: String,
    token: u64,
) -> String {
    tauri::async_runtime::spawn_blocking(move || {
        keys::send_keys(&keys, delay_ms, &window_match, &program_match, token)
    })
    .await
    .unwrap_or_else(|_| "ERR typing thread stopped".into())
}

#[tauri::command]
fn stop_typing(up_to: u64) {
    keys::stop_typing(up_to);
}

#[tauri::command]
fn focus_check(window_match: String, program_match: String) -> &'static str {
    keys::focus_check(&window_match, &program_match)
}

fn settings_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

#[tauri::command]
fn load_settings(app: AppHandle) -> Result<String, String> {
    let path = settings_path(&app)?;
    Ok(fs::read_to_string(path).unwrap_or_default())
}

// why: the file holds API keys, so errors name the step, never the contents.
#[tauri::command]
fn save_settings(app: AppHandle, json: String) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&json).map_err(|_| "settings are not valid JSON")?;
    let path = settings_path(&app)?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|_| "could not create the settings folder")?;
    }
    // why: write a whole new file, then swap it in, so a crash mid-save never leaves half a file.
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, json).map_err(|_| "could not save settings")?;
    fs::rename(&temp, &path).map_err(|_| "could not save settings".to_string())
}

#[derive(Default)]
struct Hotkey(Mutex<Option<String>>);

#[tauri::command]
fn set_hotkey(app: AppHandle, state: tauri::State<Hotkey>, hotkey: String) -> Result<(), String> {
    let shortcuts = app.global_shortcut();
    let mut current = state.0.lock().map_err(|_| "hotkey state is broken")?;
    if current.as_deref() == Some(hotkey.as_str()) {
        return Ok(());
    }
    shortcuts.unregister_all().map_err(|e| e.to_string())?;
    match shortcuts.register(hotkey.as_str()) {
        Ok(()) => {
            *current = Some(hotkey);
            Ok(())
        }
        Err(e) => {
            if let Some(old) = current.as_deref() {
                let _ = shortcuts.register(old);
            }
            Err(e.to_string())
        }
    }
}

#[tauri::command]
fn show_settings(app: AppHandle) {
    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
fn hide_pill(app: AppHandle) {
    if let Some(window) = app.get_webview_window("pill") {
        keys::hide(&window);
    }
}

fn show_pill(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("pill") {
        keys::show_without_focus(&window);
    }
}

async fn check_update(app: AppHandle, install: bool) {
    let status = |text: String| {
        let _ = app.emit_to("pill", "update-status", text);
    };
    let found = match app.updater() {
        Ok(updater) => updater.check().await,
        Err(e) => Err(e),
    };
    match found {
        Ok(Some(update)) if install => {
            status(format!("Installing update {}…", update.version));
            match update.download_and_install(|_, _| {}, || {}).await {
                Ok(()) => app.restart(),
                Err(_) => status("Update failed to install. Try again later.".into()),
            }
        }
        Ok(Some(update)) => status(format!(
            "Update {} ready: tray, Check for Updates.",
            update.version
        )),
        Ok(None) if install => status("PerioKey is up to date.".into()),
        Ok(None) => {}
        Err(_) if install => status("Could not check for updates.".into()),
        Err(_) => {}
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            show_pill(app)
        }))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _, event| {
                    if event.state == ShortcutState::Pressed {
                        let _ = app.emit_to("pill", "hotkey", ());
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Hotkey::default())
        .invoke_handler(tauri::generate_handler![
            send_keys,
            stop_typing,
            focus_check,
            load_settings,
            save_settings,
            set_hotkey,
            show_settings,
            hide_pill
        ])
        .setup(|app| {
            let handle = app.handle();
            let menu = Menu::with_items(
                handle,
                &[
                    &MenuItem::with_id(handle, "pill", "Show Pill", true, None::<&str>)?,
                    &MenuItem::with_id(
                        handle,
                        "settings",
                        "Settings & Practice",
                        true,
                        None::<&str>,
                    )?,
                    &MenuItem::with_id(handle, "update", "Check for Updates", true, None::<&str>)?,
                    &MenuItem::with_id(handle, "quit", "Quit", true, None::<&str>)?,
                ],
            )?;
            let mut tray = TrayIconBuilder::with_id("main")
                .tooltip("PerioKey")
                .menu(&menu);
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.on_menu_event(|app, event| match event.id.as_ref() {
                "pill" => show_pill(app),
                "settings" => show_settings(app.clone()),
                "update" => {
                    tauri::async_runtime::spawn(check_update(app.clone(), true));
                }
                "quit" => app.exit(0),
                _ => {}
            })
            .build(app)?;
            show_pill(handle);
            tauri::async_runtime::spawn(check_update(handle.clone(), false));
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                match window.app_handle().get_webview_window(window.label()) {
                    Some(webview) if window.label() == "pill" => keys::hide(&webview),
                    _ => {
                        let _ = window.hide();
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("PerioKey could not start");
}
