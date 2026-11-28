//! API keys live in the operating system's credential store (decision 001), never in settings.json.
//! Only the pill window may read a key; Settings sees saved or unset, nothing more.

use serde_json::Value;
use std::collections::BTreeMap;

pub const KEY_NAMES: [&str; 2] = ["OPENAI_API_KEY", "DEEPGRAM_API_KEY"];
#[cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]
const SERVICE: &str = "PerioKey";

pub trait Store {
    fn get(&self, name: &str) -> Result<Option<String>, String>;
    fn set(&self, name: &str, value: &str) -> Result<(), String>;
    /// Deleting a key that is not there is not an error.
    fn delete(&self, name: &str) -> Result<(), String>;
}

#[derive(serde::Serialize, Debug, PartialEq)]
pub struct KeyStatus {
    pub openai: bool,
    pub deepgram: bool,
}

/// Removes every API key from a settings file. Returns the cleaned JSON and whether a key was found.
pub fn strip_keys(json: &str) -> Result<(String, bool), &'static str> {
    strip(json, &KEY_NAMES)
}

/// Removes only the named keys; the cleaned JSON, or None when none of them was there.
pub fn strip_named(json: &str, names: &[&str]) -> Result<Option<String>, &'static str> {
    let (cleaned, found) = strip(json, names)?;
    Ok(found.then_some(cleaned))
}

fn strip(json: &str, names: &[&str]) -> Result<(String, bool), &'static str> {
    let mut value: Value = serde_json::from_str(json).map_err(|_| "settings are not valid JSON")?;
    let mut found = false;
    if let Some(root) = value.as_object_mut() {
        for name in names {
            found |= root.remove(*name).is_some();
        }
        if let Some(env) = root.get_mut("env").and_then(Value::as_object_mut) {
            for name in names {
                found |= env.remove(*name).is_some();
            }
        }
    }
    let cleaned = serde_json::to_string(&value).map_err(|_| "could not save settings")?;
    Ok((cleaned, found))
}

/// Moves each key an older build left in settings.json into the store, before the file loses it.
/// A key already in the store is newer and is kept. Any error means some key was not moved.
pub fn move_old_keys(json: &str, store: &dyn Store) -> Result<(), String> {
    let old: Value = serde_json::from_str(json).map_err(|_| "settings are not valid JSON")?;
    for name in KEY_NAMES {
        let found = [old.get("env").and_then(|env| env.get(name)), old.get(name)]
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::trim)
            .find(|value| !value.is_empty());
        if let Some(value) = found {
            if store.get(name)?.is_none() {
                store.set(name, value)?;
            }
        }
    }
    Ok(())
}

// why: error text names the window and the step, never a key value.
pub fn allow(label: &str, wanted: &str) -> Result<(), String> {
    if label == wanted {
        Ok(())
    } else {
        Err(format!("only the {wanted} window may do this"))
    }
}

fn known_name(name: &str) -> Result<&'static str, String> {
    KEY_NAMES
        .into_iter()
        .find(|known| *known == name)
        .ok_or_else(|| "unknown key name".to_string())
}

// why: people paste "Bearer sk-..." or stray spaces; a key is only these characters.
fn clean_value(typed: &str) -> Result<String, String> {
    let trimmed = typed.trim();
    let key = match trimmed.get(..7) {
        Some(head) if head.eq_ignore_ascii_case("bearer ") => trimmed[7..].trim_start(),
        _ => trimmed,
    };
    let ok = !key.is_empty()
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'));
    if ok {
        Ok(key.to_string())
    } else {
        Err("that key has spaces or symbols a key cannot have".to_string())
    }
}

/// The raw keys, for the pill window only.
pub fn read_for(label: &str, store: &dyn Store) -> Result<BTreeMap<String, String>, String> {
    allow(label, "pill")?;
    let mut keys = BTreeMap::new();
    for name in KEY_NAMES {
        if let Some(value) = store.get(name)? {
            keys.insert(name.to_string(), value);
        }
    }
    Ok(keys)
}

pub fn status(store: &dyn Store) -> Result<KeyStatus, String> {
    Ok(KeyStatus {
        openai: store.get("OPENAI_API_KEY")?.is_some(),
        deepgram: store.get("DEEPGRAM_API_KEY")?.is_some(),
    })
}

pub fn set_for(label: &str, store: &dyn Store, name: &str, value: &str) -> Result<(), String> {
    allow(label, "settings")?;
    let name = known_name(name)?;
    store.set(name, &clean_value(value)?)
}

pub fn clear_for(label: &str, store: &dyn Store, names: &[&str]) -> Result<(), String> {
    allow(label, "settings")?;
    for name in names {
        store.delete(name)?;
    }
    Ok(())
}

/// The real credential store: Windows Credential Manager or the macOS Keychain.
pub struct OsStore;

#[cfg(windows)]
mod os {
    use super::SERVICE;
    use std::ptr::null_mut;
    use windows_sys::Win32::Foundation::{GetLastError, ERROR_NOT_FOUND};
    use windows_sys::Win32::Security::Credentials::{
        CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE,
        CRED_TYPE_GENERIC,
    };

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(Some(0)).collect()
    }

    fn target(name: &str) -> Vec<u16> {
        wide(&format!("{SERVICE}/{name}"))
    }

    pub fn get(name: &str) -> Result<Option<String>, String> {
        let target = target(name);
        let mut found: *mut CREDENTIALW = null_mut();
        // SAFETY: target is a NUL-ended UTF-16 string; found is freed with CredFree below.
        let ok = unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut found) };
        if ok == 0 {
            // SAFETY: reads this thread's last error code only.
            return match unsafe { GetLastError() } {
                ERROR_NOT_FOUND => Ok(None),
                _ => Err("could not read a saved key from Windows Credential Manager".into()),
            };
        }
        // SAFETY: CredReadW succeeded, so found points to a credential with a blob of that size.
        let bytes = unsafe {
            let cred = &*found;
            std::slice::from_raw_parts(cred.CredentialBlob, cred.CredentialBlobSize as usize)
                .to_vec()
        };
        // SAFETY: found came from CredReadW.
        unsafe { CredFree(found.cast()) };
        String::from_utf8(bytes)
            .map(Some)
            .map_err(|_| "a saved key in Windows Credential Manager is damaged".into())
    }

    pub fn set(name: &str, value: &str) -> Result<(), String> {
        let mut target = target(name);
        let mut user = wide("PerioKey");
        let blob = value.as_bytes();
        let cred = CREDENTIALW {
            Flags: 0,
            Type: CRED_TYPE_GENERIC,
            TargetName: target.as_mut_ptr(),
            Comment: null_mut(),
            LastWritten: Default::default(),
            CredentialBlobSize: blob.len() as u32,
            CredentialBlob: blob.as_ptr() as *mut u8,
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            AttributeCount: 0,
            Attributes: null_mut(),
            TargetAlias: null_mut(),
            UserName: user.as_mut_ptr(),
        };
        // SAFETY: every pointer in cred lives until this call returns; Windows copies the blob.
        let ok = unsafe { CredWriteW(&cred, 0) };
        if ok == 0 {
            Err("could not save the key in Windows Credential Manager".into())
        } else {
            Ok(())
        }
    }

    pub fn delete(name: &str) -> Result<(), String> {
        let target = target(name);
        // SAFETY: target is a NUL-ended UTF-16 string.
        let ok = unsafe { CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) };
        // SAFETY: reads this thread's last error code only.
        if ok == 0 && unsafe { GetLastError() } != ERROR_NOT_FOUND {
            return Err("could not clear a key in Windows Credential Manager".into());
        }
        Ok(())
    }
}

#[cfg(target_os = "macos")]
mod os {
    use super::SERVICE;
    use security_framework::passwords::{
        delete_generic_password, get_generic_password, set_generic_password,
    };

    // why: errSecItemNotFound, the Keychain's "no such key".
    const NOT_FOUND: i32 = -25300;

    pub fn get(name: &str) -> Result<Option<String>, String> {
        match get_generic_password(SERVICE, name) {
            Ok(bytes) => String::from_utf8(bytes)
                .map(Some)
                .map_err(|_| "a saved key in the Keychain is damaged".into()),
            Err(e) if e.code() == NOT_FOUND => Ok(None),
            Err(_) => Err("could not read a saved key from the Keychain".into()),
        }
    }

    pub fn set(name: &str, value: &str) -> Result<(), String> {
        set_generic_password(SERVICE, name, value.as_bytes())
            .map_err(|_| "could not save the key in the Keychain".into())
    }

    pub fn delete(name: &str) -> Result<(), String> {
        match delete_generic_password(SERVICE, name) {
            Ok(()) => Ok(()),
            Err(e) if e.code() == NOT_FOUND => Ok(()),
            Err(_) => Err("could not clear a key in the Keychain".into()),
        }
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod os {
    const NONE: &str = "this computer has no supported credential store";
    pub fn get(_: &str) -> Result<Option<String>, String> {
        Ok(None)
    }
    pub fn set(_: &str, _: &str) -> Result<(), String> {
        Err(NONE.into())
    }
    pub fn delete(_: &str) -> Result<(), String> {
        Ok(())
    }
}

impl Store for OsStore {
    fn get(&self, name: &str) -> Result<Option<String>, String> {
        os::get(name)
    }
    fn set(&self, name: &str, value: &str) -> Result<(), String> {
        os::set(name, value)
    }
    fn delete(&self, name: &str) -> Result<(), String> {
        os::delete(name)
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    #[derive(Default)]
    pub struct Memory(pub RefCell<HashMap<String, String>>);

    impl Store for Memory {
        fn get(&self, name: &str) -> Result<Option<String>, String> {
            Ok(self.0.borrow().get(name).cloned())
        }
        fn set(&self, name: &str, value: &str) -> Result<(), String> {
            self.0.borrow_mut().insert(name.into(), value.into());
            Ok(())
        }
        fn delete(&self, name: &str) -> Result<(), String> {
            self.0.borrow_mut().remove(name);
            Ok(())
        }
    }

    #[test]
    fn keys_are_stripped_from_settings_json_and_the_rest_is_kept() {
        let old = r#"{"env":{"OPENAI_API_KEY":"sk-old","DEEPGRAM_API_KEY":"dg-old","STT_PROVIDER":"openai"},"mic":"m1","OPENAI_API_KEY":"sk-top"}"#;
        let (cleaned, found) = strip_keys(old).unwrap();
        assert!(found);
        assert!(
            !cleaned.contains("sk-old")
                && !cleaned.contains("dg-old")
                && !cleaned.contains("sk-top")
        );
        let value: Value = serde_json::from_str(&cleaned).unwrap();
        assert_eq!(value["env"]["STT_PROVIDER"], "openai");
        assert_eq!(value["mic"], "m1");
        let (_, again) = strip_keys(&cleaned).unwrap();
        assert!(!again);
    }

    #[test]
    fn old_keys_move_to_the_store_and_a_saved_key_is_kept() {
        let store = Memory::default();
        store.set("OPENAI_API_KEY", "sk-new").unwrap();
        let old = r#"{"env":{"OPENAI_API_KEY":"sk-old","DEEPGRAM_API_KEY":" dg-old "}}"#;
        move_old_keys(old, &store).unwrap();
        assert_eq!(
            store.get("OPENAI_API_KEY").unwrap().as_deref(),
            Some("sk-new")
        );
        assert_eq!(
            store.get("DEEPGRAM_API_KEY").unwrap().as_deref(),
            Some("dg-old")
        );
    }

    #[test]
    fn bad_settings_json_is_refused_without_quoting_it() {
        let err = strip_keys(r#"{"env":{"OPENAI_API_KEY":"sk-secret""#).unwrap_err();
        assert!(!err.contains("sk-secret"));
    }

    #[test]
    fn only_the_pill_window_may_read_raw_keys() {
        let store = Memory::default();
        store.set("OPENAI_API_KEY", "sk-abc").unwrap();
        for label in ["settings", "other", ""] {
            let err = read_for(label, &store).unwrap_err();
            assert!(!err.contains("sk-abc"), "error quoted the key");
        }
        let keys = read_for("pill", &store).unwrap();
        assert_eq!(
            keys.get("OPENAI_API_KEY").map(String::as_str),
            Some("sk-abc")
        );
        assert_eq!(keys.get("DEEPGRAM_API_KEY"), None);
    }

    #[test]
    fn status_says_saved_or_unset_and_nothing_more() {
        let store = Memory::default();
        assert_eq!(
            status(&store).unwrap(),
            KeyStatus {
                openai: false,
                deepgram: false
            }
        );
        store.set("DEEPGRAM_API_KEY", "dg-1").unwrap();
        let shown = serde_json::to_string(&status(&store).unwrap()).unwrap();
        assert_eq!(shown, r#"{"openai":false,"deepgram":true}"#);
    }

    #[test]
    fn settings_sets_and_clears_keys_and_the_pill_cannot() {
        let store = Memory::default();
        assert!(set_for("pill", &store, "OPENAI_API_KEY", "sk-1").is_err());
        set_for("settings", &store, "OPENAI_API_KEY", "  Bearer sk-1  ").unwrap();
        assert_eq!(
            store.get("OPENAI_API_KEY").unwrap().as_deref(),
            Some("sk-1")
        );
        set_for("settings", &store, "DEEPGRAM_API_KEY", "dg-2").unwrap();
        assert!(clear_for("pill", &store, &KEY_NAMES).is_err());
        clear_for("settings", &store, &KEY_NAMES).unwrap();
        assert_eq!(
            status(&store).unwrap(),
            KeyStatus {
                openai: false,
                deepgram: false
            }
        );
        clear_for("settings", &store, &KEY_NAMES).unwrap();
    }

    #[test]
    fn bad_names_and_values_are_refused_without_quoting_the_value() {
        let store = Memory::default();
        assert!(set_for("settings", &store, "PATH", "x").is_err());
        let err = set_for("settings", &store, "OPENAI_API_KEY", "sk bad\"key").unwrap_err();
        assert!(!err.contains("bad"));
        assert!(set_for("settings", &store, "OPENAI_API_KEY", "   ").is_err());
        assert!(store.0.borrow().is_empty());
    }
}
