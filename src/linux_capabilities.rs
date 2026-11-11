use super::*;
use serde_json::{json, Value};

#[derive(Default)]
pub struct Protocols {
    pub keyboard: Option<bool>,
    pub capture: Option<bool>,
}

pub fn protocols() -> Protocols {
    if resolve_path_binary("wayland-info").is_some() {
        let mut cmd = Command::new("wayland-info");
        if let Ok(output) = process::run(
            &mut cmd,
            deadline().min(Instant::now() + Duration::from_secs(2)),
        ) {
            if output.status.success() {
                let text = String::from_utf8_lossy(&output.stdout);
                if text.contains("interface:") {
                    return Protocols {
                        keyboard: Some(text.contains("zwp_virtual_keyboard_manager_v1")),
                        capture: if text.contains("zwlr_screencopy_manager_v1") {
                            Some(true)
                        } else if text.contains("ext_image_copy_capture_manager_v1")
                            && text.contains("ext_output_image_capture_source_manager_v1")
                        {
                            None
                        } else {
                            Some(false)
                        },
                    };
                }
            }
        }
    }
    // Desktop names do not prove which protocols this session advertises.
    Protocols::default()
}

pub fn use_wtype() -> bool {
    let keyboard = protocols().keyboard;
    resolve_path_binary("wtype").is_some()
        && keyboard != Some(false)
        && (keyboard == Some(true) || resolve_path_binary("ydotool").is_none())
}

pub fn capabilities(session: LinuxSession, tools: &[LinuxToolStatus]) -> Value {
    let has = |name| tools.iter().any(|t| t.name == name && t.found);
    let cap = |state, reason| json!({"state":state, "reason":reason, "runtimeVerified":false});
    let mut value = if session == LinuxSession::Wayland {
        let p = protocols();
        let capture = if !has("grim") || p.capture == Some(false) {
            "unsupported"
        } else if p.capture == Some(true) {
            "available"
        } else {
            "unverified"
        };
        let keyboard = if has("wtype") && p.keyboard == Some(true) {
            "available"
        } else if has("ydotool") || (has("wtype") && p.keyboard.is_none()) {
            "unverified"
        } else {
            "unsupported"
        };
        json!({
            "screenshot": cap(capture, "grim needs a capture protocol; ext-image-copy/source support depends on the installed grim version and remains unverified. Missing protocol is unsupported; a missing probe is unverified. Window capture is unsupported."),
            "inspect": cap(if capture == "unsupported" { "unsupported" } else { "degraded" }, "Screenshot only; no AT-SPI element ids."),
            "typing": cap(keyboard, "wtype needs the advertised virtual-keyboard protocol. ydotool daemon/uinput access and keyboard layout remain unverified; ASCII only."),
            "keypress": cap(keyboard, "wtype keysyms/chords or ydotool common evdev keys/chords; unsupported keys fail before input."),
            "click": cap(if has("ydotool") { "unverified" } else { "unsupported" }, "ydotoold and uinput permissions must work; executable presence is insufficient."),
            "scroll": cap(if has("ydotool") { "unverified" } else if keyboard == "unsupported" { "unsupported" } else { "degraded" }, "ydotool mousemove --wheel requires daemon/uinput access; otherwise page/arrow key fallback via wtype, not wheel events."),
            "focus": cap(if has("swaymsg") && env::var_os("SWAYSOCK").is_some() { "unverified" } else { "unsupported" }, "Only Sway IPC; a socket variable does not prove IPC access. Other compositors unsupported."),
        })
    } else {
        json!({
            "screenshot": cap(if has("scrot") || has("maim") { "available" } else { "unsupported" }, "Window capture with maim additionally requires xdotool; failed lookup never captures screen."),
            "inspect": cap(if has("scrot") || has("maim") { "degraded" } else { "unsupported" }, "Screenshot only; no AT-SPI element ids."),
            "click": cap(if has("xdotool") { "available" } else { "unsupported" }, "Coordinates only; display access unverified."),
            "typing": cap(if has("xdotool") { "available" } else { "unsupported" }, "xdotool; display access unverified."),
            "keypress": cap(if has("xdotool") { "available" } else { "unsupported" }, "xdotool; display access unverified."),
            "scroll": cap(if has("xdotool") { "available" } else { "unsupported" }, "xdotool wheel buttons; display access unverified."),
            "focus": cap(if has("wmctrl") || has("xdotool") { "available" } else { "unsupported" }, "Window-manager behavior and display access unverified."),
        })
    };
    for (name, found, reason) in [
        ("clipboardRead", if session == LinuxSession::Wayland { has("wl-paste") } else { has("xclip") || has("xsel") }, "Plugin only; requires clipboard approval and working display/selection access."),
        ("clipboardWrite", if session == LinuxSession::Wayland { has("wl-copy") } else { has("xclip") || has("xsel") }, "Plugin only; requires clipboard approval; clipboard tool may own a background selection server."),
        ("browserOpen", has("xdg-open"), "Plugin only; approval policy applies; handler handoff is not proof of a rendered page."),
        ("appLaunch", has("gtk-launch"), "Plugin only; approval required; installed desktop id required; handler handoff is not proof of a window."),
    ] { value[name] = cap(if found { "unverified" } else { "unsupported" }, reason); }
    value
}

pub fn unsupported(message: &str) -> String {
    json!({"ok":false,"supported":false,"backend":"linux","error":message}).to_string()
}

pub fn evdev_args(key: &str) -> Option<Vec<OsString>> {
    fn code(key: &str) -> Option<u32> {
        Some(match key.to_lowercase().as_str() {
            "ctrl" | "control" => 29,
            "shift" => 42,
            "alt" => 56,
            "super" | "meta" | "win" => 125,
            "enter" | "return" => 28,
            "tab" => 15,
            "escape" | "esc" => 1,
            "space" | "spacebar" => 57,
            "backspace" => 14,
            "delete" | "del" => 111,
            "home" => 102,
            "end" => 107,
            "up" => 103,
            "down" => 108,
            "left" => 105,
            "right" => 106,
            "pageup" | "page_up" | "pgup" => 104,
            "pagedown" | "page_down" | "pgdn" => 109,
            k if k.len() == 1 => {
                let ch = k.chars().next()?;
                let letters = "qwertyuiopasdfghjklzxcvbnm";
                let codes = [
                    16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 30, 31, 32, 33, 34, 35, 36, 37, 38, 44,
                    45, 46, 47, 48, 49, 50,
                ];
                if let Some(i) = letters.find(ch) {
                    codes[i]
                } else if let Some(i) = "1234567890".find(ch) {
                    2 + i as u32
                } else {
                    return None;
                }
            }
            _ => return None,
        })
    }
    let codes: Vec<u32> = key.trim().split('+').map(code).collect::<Option<_>>()?;
    if codes.is_empty() {
        return None;
    }
    let mut args: Vec<OsString> = vec!["key".into()];
    args.extend(codes.iter().map(|k| format!("{k}:1").into()));
    args.extend(codes.iter().rev().map(|k| format!("{k}:0").into()));
    Some(args)
}
