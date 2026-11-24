#[cfg(target_os = "windows")]
mod win {
    use crate::Key;
    use std::{thread, time::Duration};
    use windows_sys::Win32::Foundation::{HWND, LPARAM};
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, VkKeyScanW, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS,
        KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, VK_BACK, VK_CONTROL, VK_DELETE, VK_DOWN,
        VK_LEFT, VK_MENU, VK_RETURN, VK_RIGHT, VK_SHIFT, VK_SPACE, VK_TAB, VK_UP,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumChildWindows, GetForegroundWindow, GetWindowLongPtrW, GetWindowTextW,
        IsWindowVisible, SetWindowLongPtrW, SetWindowPos, ShowWindow, GWL_EXSTYLE, HWND_TOPMOST,
        SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SW_SHOWNOACTIVATE, WS_EX_NOACTIVATE,
        WS_EX_TOOLWINDOW,
    };

    // why: titles hold patient names; they are compared here and never returned or logged.
    fn title_has(hwnd: HWND, needle: &str) -> bool {
        let mut buf = [0u16; 512];
        let len = unsafe { GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
        len > 0 && String::from_utf16_lossy(&buf[..len as usize]).to_lowercase().contains(needle)
    }

    struct Search<'a> {
        needle: &'a str,
        found: bool,
    }

    unsafe extern "system" fn visit(child: HWND, data: LPARAM) -> i32 {
        let search = &mut *(data as *mut Search);
        if IsWindowVisible(child) != 0 && title_has(child, search.needle) {
            search.found = true;
            return 0;
        }
        1
    }

    // why: Eaglesoft's Perio Exam can be a visible MDI child inside the outer Chart window.
    fn matches(hwnd: HWND, needle: &str) -> bool {
        if needle.is_empty() {
            return false;
        }
        if title_has(hwnd, needle) {
            return true;
        }
        let mut search = Search { needle, found: false };
        unsafe { EnumChildWindows(hwnd, Some(visit), &mut search as *mut Search as LPARAM) };
        search.found
    }

    pub fn focus_check(window_match: &str) -> &'static str {
        let hwnd = unsafe { GetForegroundWindow() };
        if hwnd.is_null() {
            return "EMPTY";
        }
        let mut buf = [0u16; 2];
        if unsafe { GetWindowTextW(hwnd, buf.as_mut_ptr(), 2) } == 0 {
            return "EMPTY";
        }
        if matches(hwnd, &window_match.to_lowercase()) {
            "MATCH"
        } else {
            "MISMATCH"
        }
    }

    fn input(vk: u16, scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT { wVk: vk, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 },
            },
        }
    }

    fn virtual_key(key: &Key) -> Result<(u16, KEYBD_EVENT_FLAGS, Vec<u16>), String> {
        let mut mods: Vec<u16> = key
            .mods
            .iter()
            .map(|m| match m.as_str() {
                "ctrl" => Ok(VK_CONTROL),
                "alt" => Ok(VK_MENU),
                "shift" => Ok(VK_SHIFT),
                _ => Err("unknown modifier".to_string()),
            })
            .collect::<Result<_, _>>()?;
        let named = match key.key.as_str() {
            "backspace" => Some((VK_BACK, 0)),
            "delete" => Some((VK_DELETE, KEYEVENTF_EXTENDEDKEY)),
            "left" => Some((VK_LEFT, KEYEVENTF_EXTENDEDKEY)),
            "right" => Some((VK_RIGHT, KEYEVENTF_EXTENDEDKEY)),
            "up" => Some((VK_UP, KEYEVENTF_EXTENDEDKEY)),
            "down" => Some((VK_DOWN, KEYEVENTF_EXTENDEDKEY)),
            "tab" => Some((VK_TAB, 0)),
            "enter" => Some((VK_RETURN, 0)),
            "space" => Some((VK_SPACE, 0)),
            _ => None,
        };
        if let Some((vk, flags)) = named {
            return Ok((vk, flags, mods));
        }
        let mut chars = key.key.encode_utf16();
        let (Some(ch), None) = (chars.next(), chars.next()) else {
            return Err("unknown key".into());
        };
        let scan = unsafe { VkKeyScanW(ch) };
        if scan == -1 {
            return Err("key not on this keyboard layout".into());
        }
        let shift = (scan >> 8) & 0xff;
        for (bit, vk) in [(1, VK_SHIFT), (2, VK_CONTROL), (4, VK_MENU)] {
            if shift & bit != 0 && !mods.contains(&vk) {
                mods.push(vk);
            }
        }
        Ok(((scan & 0xff) as u16, 0, mods))
    }

    fn press(key: &Key) -> Result<(), String> {
        let (vk, flags, mods) = virtual_key(key)?;
        let mut inputs: Vec<INPUT> = mods.iter().map(|m| input(*m, 0, 0)).collect();
        inputs.push(input(vk, 0, flags));
        inputs.push(input(vk, 0, flags | KEYEVENTF_KEYUP));
        inputs.extend(mods.iter().rev().map(|m| input(*m, 0, KEYEVENTF_KEYUP)));
        let sent =
            unsafe { SendInput(inputs.len() as u32, inputs.as_ptr(), size_of::<INPUT>() as i32) };
        if sent as usize == inputs.len() {
            Ok(())
        } else {
            Err("Windows blocked the keystroke".into())
        }
    }

    pub fn send_keys(keys: &[Key], delay_ms: u64, window_match: &str) -> String {
        let needle = window_match.to_lowercase();
        let target = unsafe { GetForegroundWindow() };
        if target.is_null() || !matches(target, &needle) {
            return "LOST_FOCUS 0".into();
        }
        for (sent, key) in keys.iter().enumerate() {
            let front = unsafe { GetForegroundWindow() };
            if front != target || !matches(front, &needle) {
                return format!("LOST_FOCUS {sent}");
            }
            if let Err(message) = press(key) {
                return format!("ERR {message}");
            }
            thread::sleep(Duration::from_millis(delay_ms));
        }
        "OK".into()
    }

    pub fn show_without_focus(window: &tauri::WebviewWindow) {
        let Ok(handle) = window.hwnd() else { return };
        let hwnd = handle.0 as HWND;
        unsafe {
            let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            SetWindowLongPtrW(
                hwnd,
                GWL_EXSTYLE,
                style | (WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW) as isize,
            );
            ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        }
    }
}

#[cfg(target_os = "windows")]
pub use win::{focus_check, send_keys, show_without_focus};

#[cfg(not(target_os = "windows"))]
pub fn send_keys(_keys: &[crate::Key], _delay_ms: u64, _window_match: &str) -> String {
    "ERR live typing needs Windows".into()
}

#[cfg(not(target_os = "windows"))]
pub fn focus_check(_window_match: &str) -> &'static str {
    "EMPTY"
}

#[cfg(not(target_os = "windows"))]
pub fn show_without_focus(window: &tauri::WebviewWindow) {
    let _ = window.show();
}
