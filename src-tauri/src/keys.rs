#[cfg(target_os = "windows")]
mod win {
    use super::{target_matches, type_each, STOPPED_UP_TO};
    use crate::Key;
    use std::sync::atomic::Ordering;
    use std::{thread, time::Duration};
    use windows_sys::Win32::Foundation::{CloseHandle, HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, MapVirtualKeyW, SendInput, VkKeyScanW, INPUT, INPUT_0, INPUT_KEYBOARD,
        KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, MAPVK_VK_TO_VSC,
        VK_BACK, VK_CONTROL, VK_DELETE, VK_DOWN, VK_LEFT, VK_LWIN, VK_MENU, VK_RETURN, VK_RIGHT,
        VK_RWIN, VK_SHIFT, VK_SPACE, VK_TAB, VK_UP,
    };
    use windows_sys::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetGUIThreadInfo, GetParent, GetWindowLongPtrW, GetWindowTextW,
        GetWindowThreadProcessId, IsIconic, SetWindowLongPtrW, SetWindowPos, ShowWindow,
        GUITHREADINFO, GWL_EXSTYLE, HWND_TOPMOST, MA_NOACTIVATE, SWP_FRAMECHANGED, SWP_NOACTIVATE,
        SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SW_HIDE, SW_SHOWNOACTIVATE, WM_MOUSEACTIVATE,
        WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    };

    // why: titles hold patient names; they are compared here and never returned or logged.
    fn title_has(hwnd: HWND, needle: &str) -> bool {
        let mut buf = [0u16; 512];
        let len = unsafe { GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
        len > 0
            && String::from_utf16_lossy(&buf[..len as usize])
                .to_lowercase()
                .contains(needle)
    }

    // why: the path of the program file holds no patient data; it is compared, never returned.
    fn program_path(hwnd: HWND) -> Option<String> {
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
        if pid == 0 {
            return None;
        }
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if process.is_null() {
            return None;
        }
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = unsafe {
            QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len)
        };
        unsafe { CloseHandle(process) };
        (ok != 0).then(|| String::from_utf16_lossy(&buf[..len as usize]))
    }

    fn matches(front: HWND, needle: &str, program: &str) -> bool {
        target_matches(program_path(front).as_deref(), program, || {
            title_matches(front, needle)
        })
    }

    // why: a Perio Exam left open behind another Eaglesoft window must not match, so only the
    // control that has keyboard focus and the windows that contain it are checked.
    fn title_matches(front: HWND, needle: &str) -> bool {
        if needle.is_empty() {
            return false;
        }
        let mut info: GUITHREADINFO = unsafe { std::mem::zeroed() };
        info.cbSize = size_of::<GUITHREADINFO>() as u32;
        let thread = unsafe { GetWindowThreadProcessId(front, std::ptr::null_mut()) };
        let mut hwnd =
            if unsafe { GetGUIThreadInfo(thread, &mut info) } != 0 && !info.hwndFocus.is_null() {
                info.hwndFocus
            } else {
                front
            };
        for _ in 0..32 {
            if hwnd.is_null() {
                return false;
            }
            if unsafe { IsIconic(hwnd) } == 0 && title_has(hwnd, needle) {
                return true;
            }
            if hwnd == front {
                return false;
            }
            hwnd = unsafe { GetParent(hwnd) };
        }
        false
    }

    pub fn focus_check(window_match: &str, program_match: &str) -> &'static str {
        let hwnd = unsafe { GetForegroundWindow() };
        if hwnd.is_null() {
            return "EMPTY";
        }
        let mut buf = [0u16; 2];
        if unsafe { GetWindowTextW(hwnd, buf.as_mut_ptr(), 2) } == 0 {
            return "EMPTY";
        }
        if matches(hwnd, &window_match.to_lowercase(), program_match) {
            "MATCH"
        } else {
            "MISMATCH"
        }
    }

    fn input(vk: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
        let scan = unsafe { MapVirtualKeyW(vk as u32, MAPVK_VK_TO_VSC) } as u16;
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    wScan: scan,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    fn virtual_key(key: &Key) -> Result<Vec<INPUT>, String> {
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
        let (vk, flags) = match named {
            Some(found) => found,
            None => {
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
                ((scan & 0xff) as u16, 0)
            }
        };
        let mut inputs: Vec<INPUT> = mods.iter().map(|m| input(*m, 0)).collect();
        inputs.push(input(vk, flags));
        inputs.push(input(vk, flags | KEYEVENTF_KEYUP));
        inputs.extend(mods.iter().rev().map(|m| input(*m, KEYEVENTF_KEYUP)));
        Ok(inputs)
    }

    // why: a held Ctrl turns "3" into Ctrl+3, which Eaglesoft reads as a different command.
    fn modifier_held() -> bool {
        [VK_CONTROL, VK_MENU, VK_SHIFT, VK_LWIN, VK_RWIN]
            .iter()
            .any(|vk| unsafe { GetAsyncKeyState(*vk as i32) } as u16 & 0x8000 != 0)
    }

    pub fn send_keys(
        keys: &[Key],
        delay_ms: u64,
        window_match: &str,
        program_match: &str,
        token: u64,
    ) -> String {
        let presses = match keys.iter().map(virtual_key).collect::<Result<Vec<_>, _>>() {
            Ok(presses) => presses,
            Err(message) => return format!("ERR {message}"),
        };
        let needle = window_match.to_lowercase();
        let target = unsafe { GetForegroundWindow() };
        if target.is_null() || !matches(target, &needle, program_match) {
            return "LOST_FOCUS 0".into();
        }
        type_each(
            presses.len(),
            || token <= STOPPED_UP_TO.load(Ordering::SeqCst),
            |sent| {
                let front = unsafe { GetForegroundWindow() };
                if front != target || !matches(front, &needle, program_match) {
                    return Some(format!("LOST_FOCUS {sent}"));
                }
                if modifier_held() {
                    return Some(format!(
                        "ERR Ctrl, Alt, Shift, or Windows key held down after {sent} keys"
                    ));
                }
                None
            },
            |sent| {
                let inputs = &presses[sent];
                let count = unsafe {
                    SendInput(
                        inputs.len() as u32,
                        inputs.as_ptr(),
                        size_of::<INPUT>() as i32,
                    )
                };
                if count as usize != inputs.len() {
                    return Err("ERR Windows blocked the keystroke".into());
                }
                thread::sleep(Duration::from_millis(delay_ms));
                Ok(())
            },
        )
    }

    unsafe extern "system" fn no_activate(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _id: usize,
        _data: usize,
    ) -> LRESULT {
        if msg == WM_MOUSEACTIVATE {
            return MA_NOACTIVATE as LRESULT;
        }
        DefSubclassProc(hwnd, msg, wparam, lparam)
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
            SetWindowSubclass(hwnd, Some(no_activate), 1, 0);
            SetWindowPos(
                hwnd,
                std::ptr::null_mut(),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
            );
            ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            SetWindowPos(
                hwnd,
                HWND_TOPMOST,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            );
        }
    }

    // why: the pill is shown with ShowWindow, so it is hidden the same way to keep one record of it.
    pub fn hide(window: &tauri::WebviewWindow) {
        if let Ok(handle) = window.hwnd() {
            unsafe { ShowWindow(handle.0 as HWND, SW_HIDE) };
        }
    }
}

use std::sync::atomic::{AtomicU64, Ordering};

// why: Stop in the pill must reach a phrase that is already typing. Each phrase carries a
// number, and a phrase quits before its next key once Stop has covered its number.
static STOPPED_UP_TO: AtomicU64 = AtomicU64::new(0);

pub fn stop_typing(up_to: u64) {
    STOPPED_UP_TO.fetch_max(up_to, Ordering::SeqCst);
}

// why: any program can copy a window title, so the program that owns the window must match
// too, by its file name. An empty name means the office has not checked it yet: no match.
#[cfg(any(target_os = "windows", test))]
fn program_is(path: &str, wanted: &str) -> bool {
    let wanted = wanted.trim();
    !wanted.is_empty()
        && path
            .rsplit(['\\', '/'])
            .next()
            .is_some_and(|name| name.eq_ignore_ascii_case(wanted))
}

#[cfg(any(target_os = "windows", test))]
fn target_matches(path: Option<&str>, program: &str, title: impl FnOnce() -> bool) -> bool {
    path.is_some_and(|path| program_is(path, program)) && title()
}

// why: checks Stop before every key, so the reply says how many keys really went out.
#[cfg(any(target_os = "windows", test))]
fn type_each(
    count: usize,
    stopped: impl Fn() -> bool,
    mut check: impl FnMut(usize) -> Option<String>,
    mut send: impl FnMut(usize) -> Result<(), String>,
) -> String {
    for sent in 0..count {
        if stopped() {
            return format!("STOPPED {sent}");
        }
        if let Some(reply) = check(sent) {
            return reply;
        }
        if let Err(reply) = send(sent) {
            return reply;
        }
    }
    "OK".into()
}

#[cfg(target_os = "windows")]
pub use win::{focus_check, hide, send_keys, show_without_focus};

#[cfg(not(target_os = "windows"))]
pub fn send_keys(
    _keys: &[crate::Key],
    _delay_ms: u64,
    _window_match: &str,
    _program_match: &str,
    _token: u64,
) -> String {
    "ERR live typing needs Windows".into()
}

#[cfg(not(target_os = "windows"))]
pub fn focus_check(_window_match: &str, _program_match: &str) -> &'static str {
    "EMPTY"
}

#[cfg(not(target_os = "windows"))]
pub fn show_without_focus(window: &tauri::WebviewWindow) {
    let _ = window.show();
}

#[cfg(not(target_os = "windows"))]
pub fn hide(window: &tauri::WebviewWindow) {
    let _ = window.hide();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn program_must_match_by_file_name() {
        let path = r"C:\EagleSoft\Shared Files\Eaglesoft.exe";
        assert!(program_is(path, "eaglesoft.exe"));
        assert!(!program_is(path, ""));
        assert!(!program_is(path, "soft.exe"));
        assert!(!program_is(r"C:\Tools\notepad.exe", "eaglesoft.exe"));
    }

    #[test]
    fn a_matching_title_in_another_program_does_not_pass() {
        let notepad = Some(r"C:\Windows\notepad.exe");
        let eaglesoft = Some(r"C:\EagleSoft\Eaglesoft.exe");
        assert!(!target_matches(notepad, "Eaglesoft.exe", || true));
        assert!(!target_matches(None, "Eaglesoft.exe", || true));
        assert!(!target_matches(eaglesoft, "", || true));
        assert!(!target_matches(eaglesoft, "Eaglesoft.exe", || false));
        assert!(target_matches(eaglesoft, "Eaglesoft.exe", || true));
    }

    #[test]
    fn stop_during_typing_halts_before_the_next_key_and_reports_keys_sent() {
        let sent = Cell::new(0);
        let reply = type_each(
            5,
            || sent.get() >= 2,
            |_| None,
            |_| {
                sent.set(sent.get() + 1);
                Ok(())
            },
        );
        assert_eq!(reply, "STOPPED 2");
        assert_eq!(sent.get(), 2);
    }

    #[test]
    fn typing_runs_every_key_when_not_stopped() {
        let sent = Cell::new(0);
        let reply = type_each(
            3,
            || false,
            |_| None,
            |_| {
                sent.set(sent.get() + 1);
                Ok(())
            },
        );
        assert_eq!(reply, "OK");
        assert_eq!(sent.get(), 3);
    }

    #[test]
    fn stop_covers_every_phrase_at_or_below_its_number() {
        stop_typing(7);
        stop_typing(3);
        let stopped = |token: u64| token <= STOPPED_UP_TO.load(Ordering::SeqCst);
        assert!(stopped(7));
        assert!(stopped(5));
        assert!(!stopped(8));
    }
}
