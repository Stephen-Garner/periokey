mod keys;
mod secrets;

use std::collections::BTreeMap;
use std::fs;
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, Window, WindowEvent};
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

// why: write a whole new file, then swap it in, so a crash mid-save never leaves half a file.
fn write_settings(path: &std::path::Path, json: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|_| "could not create the settings folder")?;
    }
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, json).map_err(|_| "could not save settings")?;
    fs::rename(&temp, path).map_err(|_| "could not save settings".to_string())
}

// why: an older build saved keys in settings.json; each moves to the credential store first,
// and the file is rewritten without keys only once every move worked, so no key is lost.
fn load_settings_at(path: &std::path::Path, store: &dyn secrets::Store) -> Result<String, String> {
    let raw = fs::read_to_string(path).unwrap_or_default();
    match secrets::strip_keys(&raw) {
        Ok((cleaned, true)) => {
            // why: a failed move leaves the old file as it was; the next launch tries again.
            if secrets::move_old_keys(&raw, store).is_ok() {
                write_settings(path, &cleaned)?;
            }
            Ok(cleaned)
        }
        Ok((cleaned, false)) => Ok(cleaned),
        Err(_) => Ok(String::new()),
    }
}

// why: errors name the step, never the contents; keys are stripped so they never reach disk.
// A file that still holds old keys is only replaced once they are in the credential store.
fn save_settings_at(
    path: &std::path::Path,
    json: &str,
    store: &dyn secrets::Store,
) -> Result<(), String> {
    let (cleaned, _) = secrets::strip_keys(json)?;
    let old = fs::read_to_string(path).unwrap_or_default();
    if matches!(secrets::strip_keys(&old), Ok((_, true))) {
        secrets::move_old_keys(&old, store)?;
    }
    write_settings(path, &cleaned)
}

#[tauri::command]
fn load_settings(app: AppHandle) -> Result<String, String> {
    load_settings_at(&settings_path(&app)?, &secrets::OsStore)
}

#[tauri::command]
fn save_settings(app: AppHandle, json: String) -> Result<(), String> {
    save_settings_at(&settings_path(&app)?, &json, &secrets::OsStore)
}

#[tauri::command]
fn read_api_keys(window: Window) -> Result<BTreeMap<String, String>, String> {
    secrets::read_for(window.label(), &secrets::OsStore)
}

#[tauri::command]
fn api_key_status() -> Result<secrets::KeyStatus, String> {
    secrets::status(&secrets::OsStore)
}

#[tauri::command]
fn set_api_key(window: Window, name: String, value: String) -> Result<(), String> {
    secrets::set_for(window.label(), &secrets::OsStore, &name, &value)
}

#[tauri::command]
fn clear_api_keys(window: Window) -> Result<(), String> {
    secrets::clear_for(window.label(), &secrets::OsStore)
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
            read_api_keys,
            api_key_status,
            set_api_key,
            clear_api_keys,
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

#[cfg(test)]
mod tests {
    use super::*;
    use secrets::tests::Memory;
    use secrets::Store;

    struct Broken;

    impl Store for Broken {
        fn get(&self, _: &str) -> Result<Option<String>, String> {
            Ok(None)
        }
        fn set(&self, _: &str, _: &str) -> Result<(), String> {
            Err("could not save the key".into())
        }
        fn delete(&self, _: &str) -> Result<(), String> {
            Ok(())
        }
    }

    const OLD: &str = r#"{"env":{"OPENAI_API_KEY":"sk-old","STT_PROVIDER":"openai"},"mic":"m1"}"#;

    fn temp_settings(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("periokey-{name}-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        fs::write(&path, OLD).unwrap();
        path
    }

    #[test]
    fn an_old_key_moves_to_the_store_then_the_file_loses_it_and_a_second_launch_is_quiet() {
        let path = temp_settings("move");
        let store = Memory::default();
        let first = load_settings_at(&path, &store).unwrap();
        assert!(!first.contains("sk-old"));
        assert_eq!(
            store.get("OPENAI_API_KEY").unwrap().as_deref(),
            Some("sk-old")
        );
        let on_disk = fs::read_to_string(&path).unwrap();
        assert!(!on_disk.contains("sk-old") && on_disk.contains("m1"));
        assert_eq!(load_settings_at(&path, &store).unwrap(), first);
        assert_eq!(
            store.get("OPENAI_API_KEY").unwrap().as_deref(),
            Some("sk-old")
        );
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn a_key_already_in_the_store_is_kept_over_the_old_file() {
        let path = temp_settings("keep");
        let store = Memory::default();
        store.set("OPENAI_API_KEY", "sk-new").unwrap();
        load_settings_at(&path, &store).unwrap();
        assert_eq!(
            store.get("OPENAI_API_KEY").unwrap().as_deref(),
            Some("sk-new")
        );
        assert!(!fs::read_to_string(&path).unwrap().contains("sk-old"));
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn a_failed_move_leaves_the_old_settings_file_untouched() {
        let path = temp_settings("fail");
        let loaded = load_settings_at(&path, &Broken).unwrap();
        assert!(!loaded.contains("sk-old"));
        assert_eq!(fs::read_to_string(&path).unwrap(), OLD);
        assert!(save_settings_at(&path, r#"{"mic":"m2"}"#, &Broken).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), OLD);
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
}
