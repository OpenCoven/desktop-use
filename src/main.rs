use std::env;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

const VERSION: &str = env!("CARGO_PKG_VERSION");

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let result = run(args);
    println!("{}", result);
}

fn run(args: Vec<String>) -> String {
    if args.is_empty() || has_flag(&args, "--help") || has_flag(&args, "-h") {
        return help_json();
    }
    if has_flag(&args, "--version") || has_flag(&args, "-V") {
        return json_obj(vec![
            ("ok", "true".to_string()),
            ("version", json_string(VERSION)),
        ]);
    }

    let command = match normalize_command(args[0].as_str()) {
        Some(c) => c,
        None => {
            return json_obj(vec![
                ("ok", "false".to_string()),
                (
                    "error",
                    json_string(&format!("unknown command: {}", args[0])),
                ),
                (
                    "help",
                    json_string(
                        "commands: doctor, inspect, screenshot, click, type-text, keypress, scroll, focus",
                    ),
                ),
            ]);
        }
    };

    match detect_platform() {
        Platform::Macos => run_macos(command, &args[1..]),
        Platform::LinuxX11 => run_linux(LinuxSession::X11, command, &args[1..]),
        Platform::LinuxWayland => run_linux(LinuxSession::Wayland, command, &args[1..]),
        Platform::Other => json_obj(vec![
            ("ok", "false".to_string()),
            ("supported", "false".to_string()),
            ("platform", json_string(env::consts::OS)),
            ("backend", json_string("none")),
            (
                "message",
                json_string(
                    "coven-desktop-use supports macOS (via Peekaboo) and Linux (X11 / Wayland). This platform is unsupported.",
                ),
            ),
        ]),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Platform {
    Macos,
    LinuxX11,
    LinuxWayland,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LinuxSession {
    X11,
    Wayland,
}

impl LinuxSession {
    fn label(self) -> &'static str {
        match self {
            LinuxSession::X11 => "x11",
            LinuxSession::Wayland => "wayland",
        }
    }
}

fn detect_platform() -> Platform {
    if cfg!(target_os = "macos") {
        return Platform::Macos;
    }
    if cfg!(target_os = "linux") {
        return detect_linux_session();
    }
    Platform::Other
}

fn detect_linux_session() -> Platform {
    let session = env::var("XDG_SESSION_TYPE")
        .unwrap_or_default()
        .to_lowercase();
    match session.as_str() {
        "wayland" => Platform::LinuxWayland,
        "x11" => Platform::LinuxX11,
        _ => {
            if env::var_os("WAYLAND_DISPLAY").is_some() {
                Platform::LinuxWayland
            } else if env::var_os("DISPLAY").is_some() {
                Platform::LinuxX11
            } else {
                // No display variables set (headless / SSH session). Default to
                // X11 because xdotool/scrot also fail loudly and `doctor` will
                // make the missing display obvious to the operator.
                Platform::LinuxX11
            }
        }
    }
}

fn run_macos(command: &'static str, args: &[String]) -> String {
    match command {
        "doctor" => run_peekaboo(vec!["permissions".into()], false, true),
        "inspect" => run_peekaboo(build_inspect_args(args), false, false),
        "screenshot" => run_peekaboo(build_screenshot_args(args), false, false),
        "click" | "type-text" | "keypress" | "scroll" | "focus"
            if !has_flag(args, "--confirm") =>
        {
            confirmation_required(command)
        }
        "click" => run_peekaboo(build_click_args(&strip_flag(args, "--confirm")), false, false),
        "type-text" => run_peekaboo(build_type_args(&strip_flag(args, "--confirm")), true, false),
        "keypress" => run_peekaboo(build_press_args(&strip_flag(args, "--confirm")), false, false),
        "scroll" => run_peekaboo(build_scroll_args(&strip_flag(args, "--confirm")), false, false),
        "focus" => run_peekaboo(build_focus_args(&strip_flag(args, "--confirm")), false, false),
        _ => unreachable!("normalize_command returned {} but match did not handle it", command),
    }
}

fn run_linux(session: LinuxSession, command: &'static str, args: &[String]) -> String {
    if matches!(command, "click" | "type-text" | "keypress" | "scroll" | "focus")
        && !has_flag(args, "--confirm")
    {
        return confirmation_required(command);
    }
    let stripped: Vec<String> = strip_flag(args, "--confirm");
    match command {
        "doctor" => linux_doctor(session),
        "inspect" => linux_inspect(session, args),
        "screenshot" => linux_screenshot(session, args),
        "click" => linux_click(session, &stripped),
        "type-text" => linux_type_text(session, &stripped),
        "keypress" => linux_keypress(session, &stripped),
        "scroll" => linux_scroll(session, &stripped),
        "focus" => linux_focus(session, &stripped),
        _ => unreachable!("normalize_command returned {} but match did not handle it", command),
    }
}

fn normalize_command(command: &str) -> Option<&'static str> {
    match command {
        "doctor" | "permissions" => Some("doctor"),
        "inspect" | "see" => Some("inspect"),
        "screenshot" | "capture" => Some("screenshot"),
        "click" => Some("click"),
        "type-text" | "type" => Some("type-text"),
        "keypress" | "press" => Some("keypress"),
        "scroll" => Some("scroll"),
        "focus" => Some("focus"),
        _ => None,
    }
}

fn confirmation_required(action: &str) -> String {
    json_obj(vec![
        ("ok", "false".to_string()),
        ("requiresConfirmation", "true".to_string()),
        ("action", json_string(action)),
        (
            "message",
            json_string(
                "Interactive desktop actions require --confirm after explicit user approval.",
            ),
        ),
    ])
}

fn strip_flag(args: &[String], flag: &str) -> Vec<String> {
    args.iter()
        .filter(|arg| arg.as_str() != flag)
        .cloned()
        .collect()
}

fn build_inspect_args(args: &[String]) -> Vec<OsString> {
    let mut out = vec![OsString::from("see")];
    add_common_target_args(&mut out, args);
    if let Some(mode) = value(args, "--mode") {
        if mode != "auto" {
            out.extend(["--mode".into(), mode.into()]);
        }
    }
    if let Some(screen) = value(args, "--screen-index") {
        out.extend(["--screen-index".into(), screen.into()]);
    }
    if !has_flag(args, "--no-annotate") {
        out.push("--annotate".into());
    }
    out.extend([
        "--path".into(),
        output_path(value(args, "--path"), "inspect", "png").into(),
    ]);
    if let Some(analyze) = value(args, "--analyze") {
        out.extend(["--analyze".into(), analyze.into()]);
    }
    out
}

fn build_screenshot_args(args: &[String]) -> Vec<OsString> {
    let format = value(args, "--format").unwrap_or_else(|| "png".to_string());
    let mode = value(args, "--mode").unwrap_or_else(|| "frontmost".to_string());
    let mut out = vec![
        "image".into(),
        "--mode".into(),
        mode.into(),
        "--format".into(),
        format.clone().into(),
    ];
    add_common_target_args(&mut out, args);
    if let Some(screen) = value(args, "--screen-index") {
        out.extend(["--screen-index".into(), screen.into()]);
    }
    if has_flag(args, "--retina") {
        out.push("--retina".into());
    }
    out.extend([
        "--path".into(),
        output_path(value(args, "--path"), "screenshot", &format).into(),
    ]);
    if let Some(analyze) = value(args, "--analyze") {
        out.extend(["--analyze".into(), analyze.into()]);
    }
    out
}

fn build_click_args(args: &[String]) -> Vec<OsString> {
    let mut out = vec![OsString::from("click")];
    if let Some(query) = value(args, "--query") {
        out.push(query.into());
    }
    if let Some(on) = value(args, "--on") {
        out.extend(["--on".into(), on.into()]);
    }
    if let Some(coords) = value(args, "--coords") {
        out.extend(["--coords".into(), coords.into()]);
    }
    if has_flag(args, "--double") {
        out.push("--double".into());
    }
    if has_flag(args, "--right") {
        out.push("--right".into());
    }
    add_common_target_args(&mut out, args);
    out
}

fn build_type_args(args: &[String]) -> Vec<OsString> {
    let mut out = vec![
        OsString::from("type"),
        value(args, "--text").unwrap_or_default().into(),
    ];
    if has_flag(args, "--clear") {
        out.push("--clear".into());
    }
    if has_flag(args, "--return") {
        out.push("--return".into());
    }
    add_common_target_args(&mut out, args);
    out
}

fn build_press_args(args: &[String]) -> Vec<OsString> {
    let mut out = vec![OsString::from("press")];
    if let Some(keys) = value(args, "--keys") {
        for key in keys.split(',').filter(|s| !s.is_empty()) {
            out.push(key.into());
        }
    }
    add_common_target_args(&mut out, args);
    out
}

fn build_scroll_args(args: &[String]) -> Vec<OsString> {
    let direction = value(args, "--direction").unwrap_or_else(|| "down".to_string());
    let amount = value(args, "--amount").unwrap_or_else(|| "3".to_string());
    let mut out = vec![
        "scroll".into(),
        "--direction".into(),
        direction.into(),
        "--amount".into(),
        amount.into(),
    ];
    if let Some(on) = value(args, "--on") {
        out.extend(["--on".into(), on.into()]);
    }
    add_common_target_args(&mut out, args);
    out
}

fn build_focus_args(args: &[String]) -> Vec<OsString> {
    let mut out = vec![OsString::from("window"), OsString::from("focus")];
    add_common_target_args(&mut out, args);
    out
}

fn add_common_target_args(out: &mut Vec<OsString>, args: &[String]) {
    if let Some(app) = value(args, "--app") {
        out.extend(["--app".into(), app.into()]);
    }
    if let Some(title) = value(args, "--window-title") {
        out.extend(["--window-title".into(), title.into()]);
    }
    if let Some(id) = value(args, "--window-id") {
        out.extend(["--window-id".into(), id.into()]);
    }
}

fn run_peekaboo(
    mut args: Vec<OsString>,
    redact_type_text: bool,
    always_include_permission_guide: bool,
) -> String {
    args.push("--json".into());
    args.push("--no-remote".into());
    let mut cmd = Command::new("peekaboo");
    cmd.args(&args);
    match cmd.output() {
        Ok(output) => {
            let ok = output.status.success();
            let code = output.status.code().unwrap_or(-1);
            let stdout = if redact_type_text {
                "<redacted for type action>".to_string()
            } else {
                String::from_utf8_lossy(&output.stdout).to_string()
            };
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            let include_permission_guide = always_include_permission_guide
                || looks_like_permission_failure(&stdout)
                || looks_like_permission_failure(&stderr);
            let mut fields = vec![
                ("ok", bool_json(ok)),
                ("supported", "true".to_string()),
                ("platform", json_string(env::consts::OS)),
                ("backend", json_string("peekaboo")),
                ("exitCode", code.to_string()),
                (
                    "command",
                    json_array_strings(&redact_args(&args, redact_type_text)),
                ),
                ("stdout", json_string(&stdout)),
                ("stdoutRedacted", bool_json(redact_type_text)),
                ("stderr", json_string(&stderr)),
            ];
            if include_permission_guide {
                fields.push(("permissionGuide", permission_guide_json()));
            }
            json_obj(fields)
        }
        Err(err) => json_obj(vec![
            ("ok", "false".to_string()),
            ("supported", "true".to_string()),
            ("platform", json_string(env::consts::OS)),
            ("backend", json_string("peekaboo")),
            ("error", json_string(&err.to_string())),
            (
                "hint",
                json_string(
                    "Install Peekaboo and grant Screen Recording + Accessibility permissions.",
                ),
            ),
            ("permissionGuide", permission_guide_json()),
        ]),
    }
}

fn looks_like_permission_failure(text: &str) -> bool {
    text.contains("PERMISSION_ERROR")
        || text.contains("Screen recording permission")
        || text.contains("Screen Recording") && text.contains("isGranted") && text.contains("false")
        || text.contains("Accessibility") && text.contains("isGranted") && text.contains("false")
}

fn permission_guide_json() -> String {
    let adapter_path = env::current_exe()
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_else(|_| "coven-desktop-use".to_string());
    json_obj(vec![
        (
            "summary",
            json_string(
                "macOS privacy permission is required before desktop inspection or interaction can work.",
            ),
        ),
        (
            "requiredPermissions",
            json_array_strings(&[
                "Screen Recording".to_string(),
                "Accessibility".to_string(),
            ]),
        ),
        (
            "systemSettingsPaths",
            json_array_strings(&[
                "System Settings > Privacy & Security > Screen Recording".to_string(),
                "System Settings > Privacy & Security > Accessibility".to_string(),
            ]),
        ),
        (
            "systemSettingsUris",
            json_array_strings(&[
                "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture".to_string(),
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility".to_string(),
            ]),
        ),
        (
            "primaryBinariesToAdd",
            json_array_strings(&primary_permission_binaries(&adapter_path)),
        ),
        ("adapterBinary", json_string(&adapter_path)),
        (
            "backendBinary",
            json_string(&resolve_path_binary("peekaboo").unwrap_or_else(|| "peekaboo".to_string())),
        ),
        (
            "alsoCheckCallers",
            json_array_strings(&[
                "the terminal app or service that launched OpenClaw".to_string(),
                "node".to_string(),
                "openclaw".to_string(),
                "peekaboo".to_string(),
            ]),
        ),
        (
            "afterGrant",
            json_string(
                "Quit/restart the granted app or restart the OpenClaw Gateway, then rerun `coven-desktop-use doctor`.",
            ),
        ),
        (
            "verificationCommand",
            json_string("coven-desktop-use doctor"),
        ),
    ])
}

fn primary_permission_binaries(adapter_path: &str) -> Vec<String> {
    let mut binaries = vec![adapter_path.to_string()];
    if let Some(peekaboo_path) = resolve_path_binary("peekaboo") {
        if !binaries.iter().any(|item| item == &peekaboo_path) {
            binaries.push(peekaboo_path);
        }
    } else {
        binaries.push("peekaboo".to_string());
    }
    binaries
}

fn resolve_path_binary(name: &str) -> Option<String> {
    let path_var = env::var_os("PATH")?;
    for dir in env::split_paths(&path_var) {
        let candidate = dir.join(name);
        if is_executable_file(&candidate) {
            return Some(candidate.to_string_lossy().to_string());
        }
    }
    None
}

fn is_executable_file(path: &Path) -> bool {
    path.is_file()
}

// ============================================================================
// Linux backend (X11 + Wayland)
// ----------------------------------------------------------------------------
// The Linux path mirrors the macOS Peekaboo dispatch but shells out to small
// per-session tools instead of a single bundled backend:
//
//   X11:     scrot/maim (capture)  +  xdotool (input)  +  wmctrl (focus)
//   Wayland: grim (capture)        +  wtype/ydotool (input)
//
// Element-id targeting (`--on B1`) is intentionally not supported in this v1 —
// it requires AT-SPI integration. Linux callers must use `--coords x,y` or, for
// `focus`, `--app` / `--window-title`. `doctor` reports which tools are
// installed and which apt packages cover the gaps.
// ============================================================================

fn linux_doctor(session: LinuxSession) -> String {
    let tools = linux_tool_inventory(session);
    let ok = linux_minimum_tools_present(session, &tools);
    json_obj(vec![
        ("ok", bool_json(ok)),
        ("supported", "true".to_string()),
        ("platform", json_string(env::consts::OS)),
        ("backend", json_string("linux")),
        ("session", json_string(session.label())),
        ("tools", linux_tool_inventory_json(&tools)),
        ("setupGuide", linux_setup_guide_json(session, &tools)),
    ])
}

#[derive(Debug)]
struct LinuxToolStatus {
    name: &'static str,
    found: bool,
    path: Option<String>,
}

fn linux_tool_inventory(session: LinuxSession) -> Vec<LinuxToolStatus> {
    let names: &[&'static str] = match session {
        LinuxSession::X11 => &["scrot", "maim", "xdotool", "wmctrl", "xprop"],
        LinuxSession::Wayland => &["grim", "wtype", "ydotool", "wlrctl", "swaymsg"],
    };
    names
        .iter()
        .map(|name| {
            let path = resolve_path_binary(name);
            LinuxToolStatus {
                name,
                found: path.is_some(),
                path,
            }
        })
        .collect()
}

fn linux_minimum_tools_present(session: LinuxSession, tools: &[LinuxToolStatus]) -> bool {
    let has = |name: &str| tools.iter().any(|t| t.name == name && t.found);
    match session {
        LinuxSession::X11 => (has("scrot") || has("maim")) && has("xdotool"),
        LinuxSession::Wayland => has("grim") && (has("wtype") || has("ydotool")),
    }
}

fn linux_tool_inventory_json(tools: &[LinuxToolStatus]) -> String {
    let body = tools
        .iter()
        .map(|t| {
            let mut item = vec![("found", bool_json(t.found))];
            if let Some(p) = &t.path {
                item.push(("path", json_string(p)));
            }
            format!("{}:{}", json_string(t.name), json_obj(item))
        })
        .collect::<Vec<_>>()
        .join(",");
    format!("{{{}}}", body)
}

fn linux_setup_guide_json(session: LinuxSession, tools: &[LinuxToolStatus]) -> String {
    let missing: Vec<String> = tools
        .iter()
        .filter(|t| !t.found)
        .map(|t| t.name.to_string())
        .collect();
    let install_command = match session {
        LinuxSession::X11 => "sudo apt install scrot xdotool wmctrl",
        LinuxSession::Wayland => "sudo apt install grim wtype ydotool",
    };
    let summary = match session {
        LinuxSession::X11 => {
            "X11 desktop-use uses scrot (or maim) for screen capture, xdotool for input synthesis, and wmctrl for window focus."
        }
        LinuxSession::Wayland => {
            "Wayland desktop-use uses grim for screen capture and wtype/ydotool for input. ydotool needs the ydotoold daemon and uinput permissions; wtype requires a wlroots-based compositor (Sway, Hyprland)."
        }
    };
    let mut fields = vec![
        ("session", json_string(session.label())),
        ("summary", json_string(summary)),
        ("installCommand", json_string(install_command)),
        ("missingTools", json_array_strings(&missing)),
    ];
    if matches!(session, LinuxSession::Wayland) {
        fields.push((
            "ydotoolNote",
            json_string(
                "ydotool requires the ydotoold systemd service running and your user in the 'input' group, or a uinput udev rule. See https://github.com/ReimuNotMoe/ydotool#installation",
            ),
        ));
        fields.push((
            "focusNote",
            json_string(
                "Window focus on Wayland is compositor-specific. Sway/wlroots use swaymsg; GNOME Mutter has no public CLI for window activation.",
            ),
        ));
        fields.push((
            "scrollNote",
            json_string(
                "Real scroll-wheel emulation on Wayland needs wlrctl or compositor support. Without it, `scroll` falls back to Page_Up/Page_Down keystrokes.",
            ),
        ));
    } else {
        fields.push((
            "elementIdNote",
            json_string(
                "Linux v1 does not implement AT-SPI annotation; element-id targeting (`--on B1`) is not yet available. Use `--coords x,y` or `--app`/`--window-title`.",
            ),
        ));
    }
    fields.push((
        "verificationCommand",
        json_string("coven-desktop-use doctor"),
    ));
    json_obj(fields)
}

fn linux_inspect(session: LinuxSession, args: &[String]) -> String {
    let path = output_path(value(args, "--path"), "inspect", "png");
    let mode = value(args, "--mode").unwrap_or_else(|| "screen".to_string());
    let extras: Vec<(&'static str, String)> = vec![
        ("purpose", json_string("inspect")),
        ("path", json_string(&path)),
        ("elementsAvailable", "false".to_string()),
        (
            "note",
            json_string(
                "Linux inspect captures a screenshot but does not yet emit AT-SPI element ids. Use `--coords x,y` for click targeting.",
            ),
        ),
    ];
    capture_screenshot(session, &path, &mode, &extras)
}

fn linux_screenshot(session: LinuxSession, args: &[String]) -> String {
    let format = value(args, "--format").unwrap_or_else(|| "png".to_string());
    let path = output_path(value(args, "--path"), "screenshot", &format);
    let mode = value(args, "--mode").unwrap_or_else(|| "screen".to_string());
    let extras: Vec<(&'static str, String)> = vec![
        ("purpose", json_string("screenshot")),
        ("path", json_string(&path)),
    ];
    capture_screenshot(session, &path, &mode, &extras)
}

fn capture_screenshot(
    session: LinuxSession,
    path: &str,
    mode: &str,
    extras: &[(&'static str, String)],
) -> String {
    match session {
        LinuxSession::X11 => x11_screenshot(path, mode, extras),
        LinuxSession::Wayland => wayland_screenshot(path, mode, extras),
    }
}

fn x11_screenshot(path: &str, mode: &str, extras: &[(&'static str, String)]) -> String {
    if resolve_path_binary("scrot").is_some() {
        let mut a: Vec<OsString> = vec!["--overwrite".into()];
        if matches!(mode, "window" | "frontmost") {
            a.push("--focused".into());
        }
        a.push(path.into());
        return run_linux_command("scrot", a, "scrot", false, extras);
    }
    if resolve_path_binary("maim").is_some() {
        // maim has no built-in active-window selector; require xdotool for that.
        if matches!(mode, "window" | "frontmost") && resolve_path_binary("xdotool").is_some() {
            let active = Command::new("xdotool")
                .args(["getactivewindow"])
                .output()
                .ok()
                .and_then(|o| {
                    if o.status.success() {
                        Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
                    } else {
                        None
                    }
                });
            if let Some(id) = active {
                let a: Vec<OsString> = vec!["-i".into(), id.into(), path.into()];
                return run_linux_command("maim", a, "maim", false, extras);
            }
        }
        let a: Vec<OsString> = vec![path.into()];
        return run_linux_command("maim", a, "maim", false, extras);
    }
    missing_tool_json(
        "scrot or maim",
        "Install with: sudo apt install scrot",
        "x11-screenshot",
    )
}

fn wayland_screenshot(path: &str, mode: &str, extras: &[(&'static str, String)]) -> String {
    if resolve_path_binary("grim").is_none() {
        return missing_tool_json(
            "grim",
            "Install with: sudo apt install grim",
            "wayland-screenshot",
        );
    }
    // `mode=window`/`frontmost` is degraded on vanilla wlroots: grim has no
    // notion of "active window". Sway users can pre-resolve via `swaymsg -t
    // get_tree` but that's out of scope for v1; we just take the full screen.
    let _ = mode;
    let a: Vec<OsString> = vec![path.into()];
    run_linux_command("grim", a, "grim", false, extras)
}

fn linux_click(session: LinuxSession, args: &[String]) -> String {
    let coords = match value(args, "--coords") {
        Some(c) => c,
        None => {
            return linux_error_json(
                "Linux click requires --coords x,y. Element-id targeting (`--on B1`) needs AT-SPI which is not yet implemented; query/window-title fallbacks are not available either.",
                Some("Take a screenshot, identify pixel coordinates, then call click with --coords x,y --confirm."),
            );
        }
    };
    let (x, y) = match parse_coords(&coords) {
        Some(c) => c,
        None => {
            return linux_error_json(
                "--coords must be in x,y form, e.g. 120,240.",
                None,
            );
        }
    };
    let button = if has_flag(args, "--right") { 3u32 } else { 1u32 };
    let times = if has_flag(args, "--double") { 2u32 } else { 1u32 };
    match session {
        LinuxSession::X11 => x11_click(x, y, button, times),
        LinuxSession::Wayland => wayland_click(x, y, button, times),
    }
}

fn x11_click(x: i32, y: i32, button: u32, times: u32) -> String {
    if resolve_path_binary("xdotool").is_none() {
        return missing_tool_json(
            "xdotool",
            "Install with: sudo apt install xdotool",
            "x11-click",
        );
    }
    let cmd_args: Vec<OsString> = vec![
        "mousemove".into(),
        "--sync".into(),
        x.to_string().into(),
        y.to_string().into(),
        "click".into(),
        "--repeat".into(),
        times.to_string().into(),
        button.to_string().into(),
    ];
    run_linux_command("xdotool", cmd_args, "xdotool", false, &[])
}

fn wayland_click(x: i32, y: i32, button: u32, times: u32) -> String {
    if resolve_path_binary("ydotool").is_none() {
        return missing_tool_json(
            "ydotool",
            "Install with: sudo apt install ydotool, then enable ydotoold (see setup guide).",
            "wayland-click",
        );
    }
    // ydotool button codes for press+release: left=0xC0, right=0xC1, middle=0xC2.
    let click_code = match button {
        3 => "0xC1",
        2 => "0xC2",
        _ => "0xC0",
    };
    let mut steps: Vec<LinuxStep> = vec![LinuxStep {
        program: "ydotool",
        args: vec![
            "mousemove".into(),
            "--absolute".into(),
            "-x".into(),
            x.to_string().into(),
            "-y".into(),
            y.to_string().into(),
        ],
    }];
    for _ in 0..times {
        steps.push(LinuxStep {
            program: "ydotool",
            args: vec!["click".into(), click_code.into()],
        });
    }
    run_linux_steps(steps, "ydotool", false, &[])
}

fn linux_type_text(session: LinuxSession, args: &[String]) -> String {
    let text = value(args, "--text").unwrap_or_default();
    let clear = has_flag(args, "--clear");
    let press_return = has_flag(args, "--return");
    match session {
        LinuxSession::X11 => x11_type_text(&text, clear, press_return),
        LinuxSession::Wayland => wayland_type_text(&text, clear, press_return),
    }
}

fn x11_type_text(text: &str, clear: bool, press_return: bool) -> String {
    if resolve_path_binary("xdotool").is_none() {
        return missing_tool_json(
            "xdotool",
            "Install with: sudo apt install xdotool",
            "x11-type",
        );
    }
    let mut steps: Vec<LinuxStep> = Vec::new();
    if clear {
        steps.push(LinuxStep {
            program: "xdotool",
            args: vec![
                "key".into(),
                "--clearmodifiers".into(),
                "ctrl+a".into(),
            ],
        });
        steps.push(LinuxStep {
            program: "xdotool",
            args: vec!["key".into(), "--clearmodifiers".into(), "Delete".into()],
        });
    }
    steps.push(LinuxStep {
        program: "xdotool",
        args: vec![
            "type".into(),
            "--clearmodifiers".into(),
            "--delay".into(),
            "0".into(),
            "--".into(),
            text.into(),
        ],
    });
    if press_return {
        steps.push(LinuxStep {
            program: "xdotool",
            args: vec!["key".into(), "Return".into()],
        });
    }
    run_linux_steps(steps, "xdotool", true, &[])
}

fn wayland_type_text(text: &str, clear: bool, press_return: bool) -> String {
    let use_wtype = resolve_path_binary("wtype").is_some();
    let use_ydotool = resolve_path_binary("ydotool").is_some();
    if !use_wtype && !use_ydotool {
        return missing_tool_json(
            "wtype or ydotool",
            "Install with: sudo apt install wtype  (wlroots compositors) or sudo apt install ydotool (any compositor; needs ydotoold).",
            "wayland-type",
        );
    }
    let mut steps: Vec<LinuxStep> = Vec::new();
    if use_wtype {
        if clear {
            steps.push(LinuxStep {
                program: "wtype",
                args: vec![
                    "-M".into(),
                    "ctrl".into(),
                    "a".into(),
                    "-m".into(),
                    "ctrl".into(),
                ],
            });
            steps.push(LinuxStep {
                program: "wtype",
                args: vec!["-k".into(), "Delete".into()],
            });
        }
        steps.push(LinuxStep {
            program: "wtype",
            args: vec!["--".into(), text.into()],
        });
        if press_return {
            steps.push(LinuxStep {
                program: "wtype",
                args: vec!["-k".into(), "Return".into()],
            });
        }
        return run_linux_steps(steps, "wtype", true, &[]);
    }
    // ydotool fallback. ydotool's `type` command takes the literal string.
    if clear {
        // Ctrl+A : keycode 29 (LCTRL) + 30 (A); Delete: keycode 111.
        steps.push(LinuxStep {
            program: "ydotool",
            args: vec![
                "key".into(),
                "29:1".into(),
                "30:1".into(),
                "30:0".into(),
                "29:0".into(),
            ],
        });
        steps.push(LinuxStep {
            program: "ydotool",
            args: vec!["key".into(), "111:1".into(), "111:0".into()],
        });
    }
    steps.push(LinuxStep {
        program: "ydotool",
        args: vec!["type".into(), text.into()],
    });
    if press_return {
        // Return: keycode 28.
        steps.push(LinuxStep {
            program: "ydotool",
            args: vec!["key".into(), "28:1".into(), "28:0".into()],
        });
    }
    run_linux_steps(steps, "ydotool", true, &[])
}

fn linux_keypress(session: LinuxSession, args: &[String]) -> String {
    let raw = match value(args, "--keys") {
        Some(s) => s,
        None => return linux_error_json("--keys is required for keypress.", None),
    };
    let keys: Vec<&str> = raw.split(',').filter(|s| !s.is_empty()).collect();
    if keys.is_empty() {
        return linux_error_json("--keys must contain at least one key.", None);
    }
    match session {
        LinuxSession::X11 => x11_keypress(&keys),
        LinuxSession::Wayland => wayland_keypress(&keys),
    }
}

fn x11_keypress(keys: &[&str]) -> String {
    if resolve_path_binary("xdotool").is_none() {
        return missing_tool_json(
            "xdotool",
            "Install with: sudo apt install xdotool",
            "x11-keypress",
        );
    }
    let mut steps: Vec<LinuxStep> = Vec::new();
    for key in keys {
        steps.push(LinuxStep {
            program: "xdotool",
            args: vec![
                "key".into(),
                "--clearmodifiers".into(),
                map_key_xdotool(key).into(),
            ],
        });
    }
    run_linux_steps(steps, "xdotool", false, &[])
}

fn wayland_keypress(keys: &[&str]) -> String {
    if resolve_path_binary("wtype").is_none() {
        return missing_tool_json(
            "wtype",
            "Install with: sudo apt install wtype  (wlroots compositors). For non-wlroots, use ydotool with raw keycodes.",
            "wayland-keypress",
        );
    }
    let mut steps: Vec<LinuxStep> = Vec::new();
    for key in keys {
        steps.push(LinuxStep {
            program: "wtype",
            args: vec!["-k".into(), map_key_wtype(key).into()],
        });
    }
    run_linux_steps(steps, "wtype", false, &[])
}

fn linux_scroll(session: LinuxSession, args: &[String]) -> String {
    let direction = value(args, "--direction").unwrap_or_else(|| "down".to_string());
    let amount: u32 = value(args, "--amount")
        .as_deref()
        .and_then(|s| s.parse().ok())
        .unwrap_or(3);
    match session {
        LinuxSession::X11 => x11_scroll(&direction, amount),
        LinuxSession::Wayland => wayland_scroll(&direction, amount),
    }
}

fn x11_scroll(direction: &str, amount: u32) -> String {
    if resolve_path_binary("xdotool").is_none() {
        return missing_tool_json(
            "xdotool",
            "Install with: sudo apt install xdotool",
            "x11-scroll",
        );
    }
    let button = match direction {
        "up" => "4",
        "down" => "5",
        "left" => "6",
        "right" => "7",
        _ => "5",
    };
    let cmd_args: Vec<OsString> = vec![
        "click".into(),
        "--repeat".into(),
        amount.to_string().into(),
        button.into(),
    ];
    run_linux_command("xdotool", cmd_args, "xdotool", false, &[])
}

fn wayland_scroll(direction: &str, amount: u32) -> String {
    // True scroll-wheel emulation needs wlrctl or compositor support; fall back
    // to Page_Up/Page_Down via wtype as a degraded behavior. Make the trade-off
    // explicit in the response.
    if resolve_path_binary("wtype").is_none() {
        return missing_tool_json(
            "wtype",
            "Install wtype (wlroots) or wlrctl for real scroll. Without one, scroll on Wayland is unsupported.",
            "wayland-scroll",
        );
    }
    let key = match direction {
        "up" => "Page_Up",
        "down" => "Page_Down",
        "left" => "Left",
        "right" => "Right",
        _ => "Page_Down",
    };
    let mut steps: Vec<LinuxStep> = Vec::new();
    for _ in 0..amount {
        steps.push(LinuxStep {
            program: "wtype",
            args: vec!["-k".into(), key.into()],
        });
    }
    run_linux_steps(
        steps,
        "wtype",
        false,
        &[(
            "degraded",
            json_string(
                "Wayland scroll uses Page_Up/Page_Down via wtype as a fallback. Install wlrctl for true scroll-wheel events.",
            ),
        )],
    )
}

fn linux_focus(session: LinuxSession, args: &[String]) -> String {
    let app = value(args, "--app");
    let title = value(args, "--window-title");
    let target = title.or(app);
    let target = match target {
        Some(t) => t,
        None => {
            return linux_error_json(
                "focus requires --app or --window-title on Linux.",
                None,
            );
        }
    };
    match session {
        LinuxSession::X11 => x11_focus(&target),
        LinuxSession::Wayland => wayland_focus(&target),
    }
}

fn x11_focus(target: &str) -> String {
    if resolve_path_binary("wmctrl").is_some() {
        let cmd_args: Vec<OsString> = vec!["-a".into(), target.into()];
        return run_linux_command("wmctrl", cmd_args, "wmctrl", false, &[]);
    }
    if resolve_path_binary("xdotool").is_some() {
        let cmd_args: Vec<OsString> = vec![
            "search".into(),
            "--name".into(),
            target.into(),
            "windowactivate".into(),
        ];
        return run_linux_command("xdotool", cmd_args, "xdotool", false, &[]);
    }
    missing_tool_json(
        "wmctrl or xdotool",
        "Install with: sudo apt install wmctrl",
        "x11-focus",
    )
}

fn wayland_focus(target: &str) -> String {
    if env::var_os("SWAYSOCK").is_some() && resolve_path_binary("swaymsg").is_some() {
        // sway's IPC accepts `[title="…"] focus` selectors.
        let escaped = target.replace('"', "\\\"");
        let selector = format!("[title=\"{}\"] focus", escaped);
        let cmd_args: Vec<OsString> = vec![selector.into()];
        return run_linux_command("swaymsg", cmd_args, "swaymsg", false, &[]);
    }
    linux_error_json(
        "Wayland focus is compositor-specific. SWAYSOCK is not set and swaymsg is not available; no portable CLI exists for window focus on GNOME Mutter or KDE KWin.",
        Some("Switch to an X11 session, run a wlroots compositor (Sway/Hyprland), or use the compositor's own IPC."),
    )
}

fn parse_coords(s: &str) -> Option<(i32, i32)> {
    let mut parts = s.split(',');
    let x = parts.next()?.trim().parse::<i32>().ok()?;
    let y = parts.next()?.trim().parse::<i32>().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((x, y))
}

fn map_key_xdotool(key: &str) -> String {
    match key.trim().to_lowercase().as_str() {
        "return" | "enter" => "Return".into(),
        "tab" => "Tab".into(),
        "escape" | "esc" => "Escape".into(),
        "space" | "spacebar" => "space".into(),
        "up" => "Up".into(),
        "down" => "Down".into(),
        "left" => "Left".into(),
        "right" => "Right".into(),
        "backspace" => "BackSpace".into(),
        "delete" | "del" => "Delete".into(),
        "home" => "Home".into(),
        "end" => "End".into(),
        "pageup" | "page_up" | "pgup" => "Page_Up".into(),
        "pagedown" | "page_down" | "pgdn" => "Page_Down".into(),
        // Allow XKeysym names through unchanged (e.g. "ctrl+c", "F5", "shift+Tab").
        other => other.to_string(),
    }
}

fn map_key_wtype(key: &str) -> String {
    // wtype shares XKB key names with xdotool for the common cases.
    match key.trim().to_lowercase().as_str() {
        "return" | "enter" => "Return".into(),
        "tab" => "Tab".into(),
        "escape" | "esc" => "Escape".into(),
        "space" | "spacebar" => "space".into(),
        "up" => "Up".into(),
        "down" => "Down".into(),
        "left" => "Left".into(),
        "right" => "Right".into(),
        "backspace" => "BackSpace".into(),
        "delete" | "del" => "Delete".into(),
        "home" => "Home".into(),
        "end" => "End".into(),
        "pageup" | "page_up" | "pgup" => "Page_Up".into(),
        "pagedown" | "page_down" | "pgdn" => "Page_Down".into(),
        other => other.to_string(),
    }
}

#[derive(Debug)]
struct LinuxStep {
    program: &'static str,
    args: Vec<OsString>,
}

fn run_linux_command(
    program: &str,
    args: Vec<OsString>,
    backend_label: &str,
    redact_type_text: bool,
    extra_fields: &[(&'static str, String)],
) -> String {
    let mut cmd = Command::new(program);
    cmd.args(&args);
    match cmd.output() {
        Ok(output) => {
            let ok = output.status.success();
            let code = output.status.code().unwrap_or(-1);
            let stdout = if redact_type_text {
                "<redacted for type action>".to_string()
            } else {
                String::from_utf8_lossy(&output.stdout).to_string()
            };
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            let mut fields = vec![
                ("ok", bool_json(ok)),
                ("supported", "true".to_string()),
                ("platform", json_string(env::consts::OS)),
                ("backend", json_string(backend_label)),
                ("exitCode", code.to_string()),
                (
                    "command",
                    json_array_program_args(program, &redact_args(&args, redact_type_text)),
                ),
                ("stdout", json_string(&stdout)),
                ("stdoutRedacted", bool_json(redact_type_text)),
                ("stderr", json_string(&stderr)),
            ];
            for (k, v) in extra_fields {
                fields.push((k, v.clone()));
            }
            json_obj(fields)
        }
        Err(err) => json_obj(vec![
            ("ok", "false".to_string()),
            ("supported", "true".to_string()),
            ("platform", json_string(env::consts::OS)),
            ("backend", json_string(backend_label)),
            ("error", json_string(&err.to_string())),
            (
                "hint",
                json_string(&format!(
                    "Failed to invoke `{}`. Run `coven-desktop-use doctor` for installation guidance.",
                    program
                )),
            ),
        ]),
    }
}

fn run_linux_steps(
    steps: Vec<LinuxStep>,
    backend_label: &str,
    redact_type_text: bool,
    extra_fields: &[(&'static str, String)],
) -> String {
    let mut step_jsons: Vec<String> = Vec::with_capacity(steps.len());
    let mut overall_ok = true;
    let mut last_exit: i32 = 0;
    for step in &steps {
        let mut cmd = Command::new(step.program);
        cmd.args(&step.args);
        let entry = match cmd.output() {
            Ok(output) => {
                let ok = output.status.success();
                if !ok {
                    overall_ok = false;
                }
                let code = output.status.code().unwrap_or(-1);
                last_exit = code;
                let stdout = if redact_type_text {
                    "<redacted for type action>".to_string()
                } else {
                    String::from_utf8_lossy(&output.stdout).to_string()
                };
                let stderr = String::from_utf8_lossy(&output.stderr).to_string();
                json_obj(vec![
                    ("program", json_string(step.program)),
                    (
                        "args",
                        json_array_strings(&redact_args(&step.args, redact_type_text)),
                    ),
                    ("exitCode", code.to_string()),
                    ("ok", bool_json(ok)),
                    ("stdout", json_string(&stdout)),
                    ("stderr", json_string(&stderr)),
                ])
            }
            Err(err) => {
                overall_ok = false;
                json_obj(vec![
                    ("program", json_string(step.program)),
                    ("ok", "false".to_string()),
                    ("error", json_string(&err.to_string())),
                ])
            }
        };
        step_jsons.push(entry);
    }
    let mut fields = vec![
        ("ok", bool_json(overall_ok)),
        ("supported", "true".to_string()),
        ("platform", json_string(env::consts::OS)),
        ("backend", json_string(backend_label)),
        ("exitCode", last_exit.to_string()),
        ("steps", format!("[{}]", step_jsons.join(","))),
        ("stdoutRedacted", bool_json(redact_type_text)),
    ];
    for (k, v) in extra_fields {
        fields.push((k, v.clone()));
    }
    json_obj(fields)
}

fn missing_tool_json(tool_label: &str, install_hint: &str, backend_label: &str) -> String {
    json_obj(vec![
        ("ok", "false".to_string()),
        ("supported", "true".to_string()),
        ("platform", json_string(env::consts::OS)),
        ("backend", json_string(backend_label)),
        (
            "error",
            json_string(&format!("Missing required tool: {}.", tool_label)),
        ),
        ("hint", json_string(install_hint)),
        (
            "verificationCommand",
            json_string("coven-desktop-use doctor"),
        ),
    ])
}

fn linux_error_json(message: &str, hint: Option<&str>) -> String {
    let mut fields = vec![
        ("ok", "false".to_string()),
        ("supported", "true".to_string()),
        ("platform", json_string(env::consts::OS)),
        ("backend", json_string("linux")),
        ("error", json_string(message)),
    ];
    if let Some(h) = hint {
        fields.push(("hint", json_string(h)));
    }
    json_obj(fields)
}

fn json_array_program_args(program: &str, args: &[String]) -> String {
    let mut all: Vec<String> = Vec::with_capacity(args.len() + 1);
    all.push(program.to_string());
    all.extend_from_slice(args);
    json_array_strings(&all)
}

fn redact_args(args: &[OsString], redact_type_text: bool) -> Vec<String> {
    let mut items: Vec<String> = args
        .iter()
        .map(|a| a.to_string_lossy().to_string())
        .collect();
    if redact_type_text {
        // Linux backends use `--` to separate flags from positional text
        // (xdotool type, wtype). When present, redact everything after it.
        if let Some(sep_pos) = items.iter().position(|v| v == "--") {
            for item in items.iter_mut().skip(sep_pos + 1) {
                let len = item.len();
                *item = format!("<{}-byte text>", len);
            }
        } else if let Some(pos) = items.iter().position(|v| v == "type") {
            // Peekaboo (`type TEXT`) and ydotool (`type TEXT`): redact the
            // arg right after `type`.
            if let Some(text) = items.get_mut(pos + 1) {
                let len = text.len();
                *text = format!("<{}-byte text>", len);
            }
        }
    }
    items
}

fn value(args: &[String], key: &str) -> Option<String> {
    args.windows(2).find_map(|w| {
        if w[0] == key {
            Some(w[1].clone())
        } else {
            None
        }
    })
}

fn has_flag<S: AsRef<str>>(args: &[S], key: &str) -> bool {
    args.iter().any(|arg| arg.as_ref() == key)
}

fn output_path(value: Option<String>, kind: &str, format: &str) -> String {
    if let Some(path) = value {
        return path;
    }
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let mut path: PathBuf = env::temp_dir();
    path.push(format!("opencoven-desktop-use-{}-{}.{}", kind, ts, format));
    path.to_string_lossy().to_string()
}

fn help_json() -> String {
    json_obj(vec![
        ("ok", "true".to_string()),
        ("name", json_string("coven-desktop-use")),
        ("version", json_string(VERSION)),
        (
            "commands",
            json_array_strings(&[
                "doctor".into(),
                "inspect".into(),
                "screenshot".into(),
                "click".into(),
                "type-text".into(),
                "keypress".into(),
                "scroll".into(),
                "focus".into(),
            ]),
        ),
        (
            "aliases",
            json_obj(vec![
                ("permissions", json_string("doctor")),
                ("see", json_string("inspect")),
                ("capture", json_string("screenshot")),
                ("type", json_string("type-text")),
                ("press", json_string("keypress")),
            ]),
        ),
    ])
}

fn json_obj(fields: Vec<(&str, String)>) -> String {
    let body = fields
        .into_iter()
        .map(|(k, v)| format!("{}:{}", json_string(k), v))
        .collect::<Vec<_>>()
        .join(",");
    format!("{{{}}}", body)
}

fn json_array_strings(items: &[String]) -> String {
    format!(
        "[{}]",
        items
            .iter()
            .map(|s| json_string(s))
            .collect::<Vec<_>>()
            .join(",")
    )
}

fn json_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c.is_control() => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn bool_json(value: bool) -> String {
    if value { "true" } else { "false" }.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aliases_normalize_to_canonical_commands() {
        assert_eq!(normalize_command("permissions"), Some("doctor"));
        assert_eq!(normalize_command("see"), Some("inspect"));
        assert_eq!(normalize_command("capture"), Some("screenshot"));
        assert_eq!(normalize_command("type"), Some("type-text"));
        assert_eq!(normalize_command("press"), Some("keypress"));
    }

    #[test]
    fn canonical_help_lists_new_commands() {
        let help = help_json();
        assert!(help.contains("doctor"));
        assert!(help.contains("inspect"));
        assert!(help.contains("screenshot"));
        assert!(help.contains("type-text"));
        assert!(help.contains("keypress"));
    }

    #[test]
    fn interactive_aliases_still_require_confirmation() {
        let result = run(vec![
            "press".to_string(),
            "--keys".to_string(),
            "tab".to_string(),
        ]);
        assert!(result.contains("requiresConfirmation"));
        assert!(result.contains("keypress"));
    }

    #[test]
    fn permission_guide_names_required_macos_privacy_grants() {
        let guide = permission_guide_json();
        assert!(guide.contains("Screen Recording"));
        assert!(guide.contains("Accessibility"));
        assert!(guide.contains("Privacy_ScreenCapture"));
        assert!(guide.contains("Privacy_Accessibility"));
        assert!(guide.contains("primaryBinariesToAdd"));
        assert!(guide.contains("backendBinary"));
        assert!(guide.contains("peekaboo"));
        assert!(guide.contains("coven-desktop-use doctor"));
    }

    #[test]
    fn permission_failure_detector_catches_peekaboo_denials() {
        assert!(looks_like_permission_failure(
            r#"{"code":"PERMISSION_ERROR_SCREEN_RECORDING"}"#,
        ));
        assert!(looks_like_permission_failure(
            r#"{"name":"Accessibility","isGranted":false}"#,
        ));
        assert!(!looks_like_permission_failure(r#"{"success":true}"#));
    }

    // ------------------------------------------------------------------
    // Linux backend tests
    // ------------------------------------------------------------------

    #[test]
    fn parse_coords_accepts_x_y_form_and_rejects_garbage() {
        assert_eq!(parse_coords("120,240"), Some((120, 240)));
        assert_eq!(parse_coords(" 0 , 0 "), Some((0, 0)));
        assert_eq!(parse_coords("-3,-7"), Some((-3, -7)));
        assert_eq!(parse_coords("120"), None);
        assert_eq!(parse_coords("a,b"), None);
        assert_eq!(parse_coords("1,2,3"), None);
    }

    #[test]
    fn key_mapping_translates_common_names() {
        assert_eq!(map_key_xdotool("return"), "Return");
        assert_eq!(map_key_xdotool("ENTER"), "Return");
        assert_eq!(map_key_xdotool("esc"), "Escape");
        assert_eq!(map_key_xdotool("pageup"), "Page_Up");
        // Unknown names pass through (xdotool accepts XKeysym names directly).
        assert_eq!(map_key_xdotool("F5"), "f5");
        assert_eq!(map_key_xdotool("ctrl+c"), "ctrl+c");

        assert_eq!(map_key_wtype("return"), "Return");
        assert_eq!(map_key_wtype("pgdn"), "Page_Down");
    }

    #[test]
    fn redact_args_handles_dash_dash_separator() {
        // xdotool: `type --clearmodifiers --delay 0 -- secret`.
        let args = vec![
            OsString::from("type"),
            OsString::from("--clearmodifiers"),
            OsString::from("--delay"),
            OsString::from("0"),
            OsString::from("--"),
            OsString::from("hunter2"),
        ];
        let redacted = redact_args(&args, true);
        assert_eq!(redacted.last().unwrap(), "<7-byte text>");
        // wtype: `-- TEXT`.
        let args = vec![OsString::from("--"), OsString::from("hi there")];
        let redacted = redact_args(&args, true);
        assert_eq!(redacted.last().unwrap(), "<8-byte text>");
    }

    #[test]
    fn redact_args_legacy_type_form_still_redacts() {
        // ydotool / Peekaboo: `type TEXT`.
        let args = vec![OsString::from("type"), OsString::from("hello")];
        let redacted = redact_args(&args, true);
        assert_eq!(redacted, vec!["type".to_string(), "<5-byte text>".to_string()]);
    }

    #[test]
    fn linux_doctor_envelope_advertises_session_and_install_command() {
        let x11 = linux_doctor(LinuxSession::X11);
        assert!(x11.contains("\"session\":\"x11\""));
        assert!(x11.contains("apt install scrot xdotool wmctrl"));
        assert!(x11.contains("\"backend\":\"linux\""));

        let wl = linux_doctor(LinuxSession::Wayland);
        assert!(wl.contains("\"session\":\"wayland\""));
        assert!(wl.contains("apt install grim wtype ydotool"));
        assert!(wl.contains("ydotoolNote"));
        assert!(wl.contains("focusNote"));
    }

    #[test]
    fn linux_click_without_coords_returns_actionable_error() {
        let stripped: Vec<String> = vec![];
        let result = linux_click(LinuxSession::X11, &stripped);
        assert!(result.contains("\"ok\":false"));
        assert!(result.contains("--coords"));
        assert!(result.contains("AT-SPI"));
    }

    #[test]
    fn linux_keypress_without_keys_errors() {
        let stripped: Vec<String> = vec![];
        let result = linux_keypress(LinuxSession::X11, &stripped);
        assert!(result.contains("\"ok\":false"));
        assert!(result.contains("--keys"));
    }

    #[test]
    fn linux_focus_without_target_errors() {
        let stripped: Vec<String> = vec![];
        let result = linux_focus(LinuxSession::X11, &stripped);
        assert!(result.contains("\"ok\":false"));
        assert!(result.contains("--app"));
        assert!(result.contains("--window-title"));
    }

    #[test]
    fn linux_minimum_tools_requires_capture_and_input() {
        let none = vec![
            LinuxToolStatus { name: "scrot", found: false, path: None },
            LinuxToolStatus { name: "xdotool", found: false, path: None },
        ];
        assert!(!linux_minimum_tools_present(LinuxSession::X11, &none));

        let only_capture = vec![
            LinuxToolStatus { name: "scrot", found: true, path: Some("/usr/bin/scrot".into()) },
            LinuxToolStatus { name: "xdotool", found: false, path: None },
        ];
        assert!(!linux_minimum_tools_present(LinuxSession::X11, &only_capture));

        let both = vec![
            LinuxToolStatus { name: "scrot", found: true, path: Some("/usr/bin/scrot".into()) },
            LinuxToolStatus { name: "xdotool", found: true, path: Some("/usr/bin/xdotool".into()) },
        ];
        assert!(linux_minimum_tools_present(LinuxSession::X11, &both));

        let wl_ok = vec![
            LinuxToolStatus { name: "grim", found: true, path: Some("/usr/bin/grim".into()) },
            LinuxToolStatus { name: "wtype", found: true, path: Some("/usr/bin/wtype".into()) },
            LinuxToolStatus { name: "ydotool", found: false, path: None },
        ];
        assert!(linux_minimum_tools_present(LinuxSession::Wayland, &wl_ok));
    }
}
