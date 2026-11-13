#[cfg(all(test, unix))]
mod backend_fixtures;
mod capabilities;
mod geometry;
mod linux_capabilities;
mod observation;
mod process;
use std::cell::Cell;
use std::env;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

thread_local! { static DEADLINE: Cell<Option<Instant>> = const { Cell::new(None) }; }
fn deadline() -> Instant {
    DEADLINE.with(|d| {
        let end = d
            .get()
            .unwrap_or_else(|| Instant::now() + Duration::from_secs(30));
        d.set(Some(end));
        end
    })
}

const VERSION: &str = env!("CARGO_PKG_VERSION");

fn main() {
    process::install_cancellation();
    let args: Vec<String> = env::args().skip(1).collect();
    let result = run(args);
    println!("{}", result);
}

fn run(args: Vec<String>) -> String {
    let timeout = match value(&args, "--timeout-ms") {
        None if has_flag(&args, "--timeout-ms") => {
            return json_obj(vec![
                ("ok", "false".into()),
                (
                    "error",
                    json_string("--timeout-ms requires an integer value from 1000 to 120000."),
                ),
            ])
        }
        None => 30_000,
        Some(raw) => match raw.parse::<u64>() {
            Ok(ms @ 1000..=120_000) => ms,
            _ => {
                return json_obj(vec![
                    ("ok", "false".into()),
                    (
                        "error",
                        json_string("--timeout-ms must be an integer from 1000 to 120000."),
                    ),
                ])
            }
        },
    };
    DEADLINE.with(|d| d.set(Some(Instant::now() + Duration::from_millis(timeout))));
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

    let platform = detect_platform();
    let result = match platform {
        Platform::Macos => run_macos(command, &args[1..]),
        Platform::LinuxX11 => run_linux(LinuxSession::X11, command, &args[1..]),
        Platform::LinuxWayland => run_linux(LinuxSession::Wayland, command, &args[1..]),
        Platform::LinuxNoDisplay => json_obj(vec![
            ("ok", "false".to_string()),
            ("supported", "false".to_string()),
            ("platform", json_string(env::consts::OS)),
            ("backend", json_string("linux")),
            ("error", json_string("No display session detected. XDG_SESSION_TYPE, WAYLAND_DISPLAY, and DISPLAY are all unset. coven-desktop-use requires an active graphical session (X11 or Wayland).")),
            ("hint", json_string("Connect to the machine with display forwarding (ssh -X), or run in an active graphical session. Set DISPLAY=:0 if a local X11 server is running.")),
        ]),
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
    };
    if command == "doctor" && matches!(platform, Platform::LinuxNoDisplay | Platform::Other) {
        capabilities::attach(result, &capabilities::discover(platform))
    } else {
        result
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Platform {
    Macos,
    LinuxX11,
    LinuxWayland,
    LinuxNoDisplay,
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
                // No display variables set (headless / SSH session).
                // Return LinuxNoDisplay so all commands report a clean error.
                Platform::LinuxNoDisplay
            }
        }
    }
}

fn run_macos(command: &'static str, args: &[String]) -> String {
    match command {
        "doctor" => {
            let result = run_peekaboo(vec!["permissions".into()], false, true);
            let mut facts = capabilities::discover(Platform::Macos);
            let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
            if parsed["code"] == "PERMISSION_ERROR" {
                facts.permission = "failed";
            }
            capabilities::attach(result, &facts)
        }
        "inspect" => macos_capture("inspect", args),
        "screenshot" => macos_capture("screenshot", args),
        "click" | "type-text" | "keypress" | "scroll" | "focus" if !has_flag(args, "--confirm") => {
            confirmation_required(command)
        }
        "click" => run_peekaboo(
            build_click_args(&strip_flag(args, "--confirm")),
            false,
            false,
        ),
        "type-text" => run_peekaboo(build_type_args(&strip_flag(args, "--confirm")), true, false),
        "keypress" => run_peekaboo(
            build_press_args(&strip_flag(args, "--confirm")),
            false,
            false,
        ),
        "scroll" => run_peekaboo(
            build_scroll_args(&strip_flag(args, "--confirm")),
            false,
            false,
        ),
        "focus" => run_peekaboo(
            build_focus_args(&strip_flag(args, "--confirm")),
            false,
            false,
        ),
        _ => unreachable!(
            "normalize_command returned {} but match did not handle it",
            command
        ),
    }
}

fn run_linux(session: LinuxSession, command: &'static str, args: &[String]) -> String {
    if matches!(
        command,
        "click" | "type-text" | "keypress" | "scroll" | "focus"
    ) && !has_flag(args, "--confirm")
    {
        return confirmation_required(command);
    }
    if command != "focus" && command != "doctor" {
        let unsupported = [
            "--app",
            "--window-title",
            "--window-id",
            "--screen-index",
            "--on",
            "--query",
            "--analyze",
        ]
        .iter()
        .any(|flag| value(args, flag).is_some())
            || has_flag(args, "--retina");
        if unsupported {
            return linux_capabilities::unsupported("This Linux action cannot honor the requested target or capture option. No helper was invoked. Focus a supported window separately with approval, then use untargeted input or an explicit screen capture.");
        }
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
        _ => unreachable!(
            "normalize_command returned {} but match did not handle it",
            command
        ),
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

fn takes_value(flag: &str) -> bool {
    matches!(
        flag,
        "--text"
            | "--keys"
            | "--app"
            | "--window-title"
            | "--window-id"
            | "--screen-index"
            | "--mode"
            | "--path"
            | "--format"
            | "--analyze"
            | "--on"
            | "--query"
            | "--coords"
            | "--direction"
            | "--amount"
            | "--timeout-ms"
    )
}

fn strip_flag(args: &[String], flag: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if takes_value(arg) {
            out.push(arg.clone());
            i += 1;
            if let Some(value) = args.get(i) {
                out.push(value.clone());
            }
        } else if arg != flag {
            out.push(arg.clone());
        }
        i += 1;
    }
    out
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
    if let Some(query) = value(args, "--query") {
        out.extend(["--".into(), query.into()]);
    }
    out
}

fn build_type_args(args: &[String]) -> Vec<OsString> {
    let mut out = vec![OsString::from("type")];
    if has_flag(args, "--clear") {
        out.push("--clear".into());
    }
    if has_flag(args, "--return") {
        out.push("--return".into());
    }
    add_common_target_args(&mut out, args);
    out.extend([
        "--".into(),
        value(args, "--text").unwrap_or_default().into(),
    ]);
    out
}

fn build_press_args(args: &[String]) -> Vec<OsString> {
    let mut out = vec![OsString::from("press")];
    add_common_target_args(&mut out, args);
    if let Some(keys) = value(args, "--keys") {
        out.push("--".into());
        out.extend(
            keys.split(',')
                .filter(|s| !s.is_empty())
                .map(OsString::from),
        );
    }
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
    let separator = args
        .iter()
        .position(|arg| arg == "--")
        .unwrap_or(args.len());
    args.splice(
        separator..separator,
        ["--json".into(), "--no-remote".into()],
    );
    let mut cmd = Command::new("peekaboo");
    cmd.args(&args);
    match process::run(&mut cmd, deadline()) {
        Ok(output) => peekaboo_result(output, redact_type_text, always_include_permission_guide),
        Err(err) => process_failure_json("peekaboo", &err),
    }
}

fn process_failure_json(backend: &str, error: &process::Failure) -> String {
    json_obj(vec![
        ("ok", "false".into()),
        ("supported", "true".into()),
        ("backend", json_string(backend)),
        ("code", json_string(error.code())),
        ("timedOut", bool_json(error.code() == "ETIMEDOUT")),
        ("cancelled", bool_json(error.code() == "CANCELLED")),
        (
            "error",
            json_string(
                "Helper execution failed; raw command arguments and diagnostics were withheld.",
            ),
        ),
    ])
}

fn peekaboo_result(
    output: std::process::Output,
    redact_type_text: bool,
    always_include_permission_guide: bool,
) -> String {
    let permission = looks_like_permission_failure(&String::from_utf8_lossy(&output.stdout))
        || looks_like_permission_failure(&String::from_utf8_lossy(&output.stderr));
    let parsed = serde_json::from_slice::<serde_json::Value>(&output.stdout).ok();
    let field = |name: &str| {
        parsed
            .as_ref()
            .and_then(|v| v.get(name))
            .and_then(|v| v.as_bool())
    };
    let supported = field("supported") != Some(false);
    let confirmation = field("requiresConfirmation") == Some(true);
    let backend_ok = field("ok").or_else(|| field("success")) == Some(true);
    let ok = output.status.success() && backend_ok && supported && !confirmation;
    let mut fields = vec![
        ("ok", bool_json(ok)),
        ("supported", bool_json(supported)),
        ("platform", json_string(env::consts::OS)),
        ("backend", json_string("peekaboo")),
        ("exitCode", output.status.code().unwrap_or(-1).to_string()),
        ("stdoutRedacted", bool_json(redact_type_text || !ok)),
    ];
    if confirmation {
        fields.push(("requiresConfirmation", "true".into()));
    }
    if ok && !redact_type_text {
        fields.push(("result", parsed.unwrap().to_string()));
    } else if !ok {
        let code = if permission {
            "PERMISSION_ERROR"
        } else if parsed.is_none() {
            "MALFORMED_OUTPUT"
        } else {
            "BACKEND_ERROR"
        };
        fields.push(("code", json_string(code)));
        fields.push((
            "error",
            json_string("Peekaboo did not complete the action; raw diagnostics were withheld."),
        ));
    }
    if always_include_permission_guide || permission {
        fields.push(("permissionGuide", permission_guide_json()));
    }
    json_obj(fields)
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
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        path.is_file()
            && path
                .metadata()
                .is_ok_and(|m| m.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
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
    let protocols = if session == LinuxSession::Wayland {
        linux_capabilities::protocols()
    } else {
        linux_capabilities::Protocols::default()
    };
    let capabilities = linux_capabilities::with_protocols(session, &tools, protocols);
    let mut facts = capabilities::discover(if session == LinuxSession::X11 {
        Platform::LinuxX11
    } else {
        Platform::LinuxWayland
    });
    facts.protocols = protocols;
    facts.tools = tools
        .iter()
        .filter(|tool| tool.found)
        .map(|tool| tool.name.to_owned())
        .collect();
    if let Err(error) = process::check(deadline()) {
        return capabilities::attach(process_failure_json("linux-doctor", &error), &facts);
    }
    let ok = linux_minimum_tools_present(session, &tools)
        && capabilities["screenshot"]["state"] != "unsupported"
        && capabilities["typing"]["state"] != "unsupported";
    capabilities::attach(
        json_obj(vec![
            ("ok", bool_json(ok)),
            ("supported", "true".to_string()),
            ("platform", json_string(env::consts::OS)),
            ("backend", json_string("linux")),
            ("session", json_string(session.label())),
            ("capabilities", capabilities.to_string()),
            (
                "readiness",
                json_string("unverified; installed prerequisites do not prove desktop acceptance"),
            ),
            ("tools", linux_tool_inventory_json(&tools)),
            ("setupGuide", linux_setup_guide_json(session, &tools)),
        ]),
        &facts,
    )
}

#[derive(Debug)]
struct LinuxToolStatus {
    name: &'static str,
    found: bool,
    path: Option<String>,
}

fn linux_tool_inventory(session: LinuxSession) -> Vec<LinuxToolStatus> {
    let names: &[&'static str] = match session {
        LinuxSession::X11 => &[
            "scrot",
            "maim",
            "xdotool",
            "wmctrl",
            "xprop",
            "xclip",
            "xsel",
            "xdg-open",
            "gtk-launch",
        ],
        LinuxSession::Wayland => &[
            "grim",
            "wtype",
            "ydotool",
            "wlrctl",
            "swaymsg",
            "wayland-info",
            "wl-copy",
            "wl-paste",
            "xdg-open",
            "gtk-launch",
        ],
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
        LinuxSession::Wayland => has("grim") && has("ydotool"),
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
    let has = |name| tools.iter().any(|t| t.name == name && t.found);
    let mut missing: Vec<String> = Vec::new();
    if session == LinuxSession::X11 {
        if !has("scrot") && !has("maim") {
            missing.push("scrot or maim".into());
        }
        if !has("xdotool") {
            missing.push("xdotool".into());
        }
    } else {
        if !has("grim") {
            missing.push("grim".into());
        }
        if !has("wtype") && !has("ydotool") {
            missing.push("wtype or ydotool".into());
        }
        if !has("ydotool") {
            missing.push("ydotool (pointer/wheel input)".into());
        }
    }
    let install_command = match session {
        LinuxSession::X11 => "sudo apt install scrot xdotool wmctrl",
        LinuxSession::Wayland => "sudo apt install grim wtype ydotool",
    };
    let summary = match session {
        LinuxSession::X11 => {
            "X11 desktop-use uses scrot (or maim) for screen capture, xdotool for input synthesis, and wmctrl for window focus."
        }
        LinuxSession::Wayland => {
            "Wayland desktop-use probes capture/virtual-keyboard protocols when wayland-info exists. ydotool needs ydotoold and uinput access; installed tools do not prove runtime readiness."
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
                "Only Sway focus is implemented, requiring SWAYSOCK and a successful swaymsg JSON response. Other compositors are unsupported.",
            ),
        ));
        fields.push((
            "scrollNote",
            json_string(
                "Wayland wheel input uses ydotool mousemove --wheel when installed; otherwise wtype page/arrow keys are an explicitly degraded fallback.",
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
    capture_screenshot(session, &path, &mode, "png", &extras)
}

fn linux_screenshot(session: LinuxSession, args: &[String]) -> String {
    let format = value(args, "--format").unwrap_or_else(|| "png".to_string());
    if !["png", "jpg"].contains(&format.as_str()) {
        return linux_error_json("Unsupported screenshot format; expected png or jpg.", None);
    }
    let path = output_path(value(args, "--path"), "screenshot", &format);
    let mode = value(args, "--mode").unwrap_or_else(|| "screen".to_string());
    let extras: Vec<(&'static str, String)> = vec![
        ("purpose", json_string("screenshot")),
        ("path", json_string(&path)),
    ];
    capture_screenshot(session, &path, &mode, &format, &extras)
}

struct CaptureStaging(PathBuf);
impl Drop for CaptureStaging {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn capture_screenshot(
    session: LinuxSession,
    path: &str,
    mode: &str,
    format: &str,
    extras: &[(&'static str, String)],
) -> String {
    let actual_mode = match mode {
        "screen" => Some("screen"),
        "window" | "frontmost" => Some("frontmost"),
        _ => None,
    };
    capture_transaction(
        path,
        mode,
        actual_mode,
        format,
        false,
        |image_path, scale| match session {
            LinuxSession::X11 => x11_screenshot(image_path, mode, format, extras),
            LinuxSession::Wayland => wayland_screenshot(image_path, mode, format, extras, scale),
        },
    )
}

fn macos_capture(command: &str, args: &[String]) -> String {
    let format = if command == "inspect" {
        "png".to_string()
    } else {
        value(args, "--format").unwrap_or_else(|| "png".into())
    };
    if !["png", "jpg"].contains(&format.as_str()) {
        return capture_failure_json("peekaboo", &observation::Failure::Encoding);
    }
    let path = output_path(value(args, "--path"), command, &format);
    let mode = value(args, "--mode").unwrap_or_else(|| {
        if command == "inspect" {
            "auto".into()
        } else {
            "frontmost".into()
        }
    });
    // No installed/version-qualified Peekaboo scope/geometry receipt producer is
    // available. In particular, auto must never assert an actual screen extent.
    capture_transaction(
        &path,
        &mode,
        None,
        &format,
        command == "inspect" && !has_flag(args, "--no-annotate"),
        |image_path, _scale| {
            let mut owned_args = strip_option(args, "--path");
            owned_args.extend(["--path".into(), image_path.into()]);
            let backend_args = if command == "inspect" {
                build_inspect_args(&owned_args)
            } else {
                build_screenshot_args(&owned_args)
            };
            run_peekaboo(backend_args, false, false)
        },
    )
}

fn strip_option(args: &[String], option: &str) -> Vec<String> {
    let mut result = Vec::new();
    let mut index = 0;
    while index < args.len() {
        if args[index] == option {
            index += 2;
        } else {
            result.push(args[index].clone());
            if takes_value(&args[index]) {
                index += 1;
                if let Some(value) = args.get(index) {
                    result.push(value.clone());
                }
            }
            index += 1;
        }
    }
    result
}

fn capture_failure_json(backend: &str, error: &observation::Failure) -> String {
    if let observation::Failure::Process(failure) = error {
        return process_failure_json(backend, failure);
    }
    json_obj(vec![("ok", "false".into()), ("supported", "true".into()), ("backend", json_string(backend)),
        ("code", json_string(error.code())), ("error", json_string("Capture did not produce a valid bounded owned image. The destination was not changed; image diagnostics were withheld."))])
}

fn capture_transaction<F>(
    path: &str,
    requested_mode: &str,
    actual_mode: Option<&str>,
    format: &str,
    annotation_requested: bool,
    capture: F,
) -> String
where
    F: FnOnce(&str, Option<f64>) -> String,
{
    if let Err(error) = process::check(deadline()) {
        return process_failure_json("capture", &error);
    }
    if !["auto", "screen", "window", "frontmost"].contains(&requested_mode) {
        return json_obj(vec![
            ("ok", "false".into()),
            ("supported", "false".into()),
            ("code", json_string("CAPTURE_SCOPE_UNSUPPORTED")),
            (
                "error",
                json_string("The requested capture mode is unsupported. No helper was invoked."),
            ),
        ]);
    }
    let target = Path::new(path);
    let parent = target
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let directory = parent.join(format!(".desktopuse-capture-{}", unique_suffix()));
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    if builder.create(&directory).is_err() {
        return capture_failure_json("capture", &observation::Failure::Missing);
    }
    let staging = CaptureStaging(directory);
    let image = staging.0.join(if format == "jpg" {
        "capture.jpg"
    } else {
        "capture.png"
    });
    let geometry_before = geometry::probe(requested_mode);
    let scale = geometry_before.as_ref().and_then(|s| s.scale);
    let result = capture(&image.to_string_lossy(), scale);
    let mut parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
    if parsed["ok"] != true {
        return result;
    }
    let provider = parsed["backend"].as_str().unwrap_or("unknown").to_owned();
    let validated = match observation::validate_capture(&image, format, deadline()) {
        Ok(validated) => validated,
        Err(error) => return capture_failure_json(&provider, &error),
    };
    let mut receipt =
        validated.receipt(&provider, requested_mode, actual_mode, annotation_requested);
    geometry::attach(&mut receipt, geometry_before, requested_mode, &parsed);
    if let Err(error) = validated.check_identity(&image, deadline()) {
        return capture_failure_json(&provider, &error);
    }
    if std::fs::rename(&image, target).is_err() {
        return capture_failure_json(&provider, &observation::Failure::Missing);
    }
    // Publication has completed. Do not turn this write into cancellation after
    // the fact: the caller needs the truthful completed outcome.
    rebind_peekaboo_primary_path(&mut parsed, &image.to_string_lossy(), path);
    parsed["path"] = path.into();
    parsed["observationV1"] = receipt;
    parsed.to_string()
}

// Peekaboo 69764083 SeeResult.screenshot_raw / ImageCaptureResult.files identify
// primary artifacts. Rebind only the exact helper-owned file after commit, never
// annotations, maps, arbitrary strings or an ambiguous multi-image result.
fn rebind_peekaboo_primary_path(result: &mut serde_json::Value, source: &str, target: &str) {
    if result["backend"] != "peekaboo" {
        return;
    }
    let Some(data) = result
        .get_mut("result")
        .and_then(|r| r.get_mut("data"))
        .and_then(serde_json::Value::as_object_mut)
    else {
        return;
    };
    if data
        .get("screenshot_raw")
        .and_then(serde_json::Value::as_str)
        == Some(source)
    {
        data.insert("screenshot_raw".into(), target.into());
    }
    if let Some(files) = data
        .get_mut("files")
        .and_then(serde_json::Value::as_array_mut)
    {
        if files.len() == 1 && files[0]["path"].as_str() == Some(source) {
            files[0]["path"] = target.into();
        }
    }
}

fn x11_screenshot(
    path: &str,
    mode: &str,
    format: &str,
    extras: &[(&'static str, String)],
) -> String {
    if resolve_path_binary("scrot").is_some() {
        let mut a: Vec<OsString> = vec!["--overwrite".into()];
        if matches!(mode, "window" | "frontmost") {
            a.push("--focused".into());
        }
        a.extend(["--".into(), path.into()]);
        return run_linux_command("scrot", a, "scrot", false, extras);
    }
    if resolve_path_binary("maim").is_some() {
        // maim has no built-in active-window selector; require xdotool for that.
        if matches!(mode, "window" | "frontmost") && resolve_path_binary("xdotool").is_some() {
            let mut cmd = Command::new("xdotool");
            cmd.arg("getactivewindow");
            let output = match process::run(&mut cmd, deadline()) {
                Ok(o) if o.status.success() => o,
                Ok(_) => {
                    return linux_error_json(
                        "Active window lookup failed; no screenshot was taken.",
                        None,
                    )
                }
                Err(e) => return process_failure_json("xdotool", &e),
            };
            let id = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if id.parse::<u64>().is_err() {
                return linux_error_json(
                    "Malformed active window id; no screenshot was taken.",
                    None,
                );
            }
            return run_linux_command(
                "maim",
                vec![
                    "-f".into(),
                    format.into(),
                    "-i".into(),
                    id.into(),
                    "--".into(),
                    path.into(),
                ],
                "maim",
                false,
                extras,
            );
        }
        if matches!(mode, "window" | "frontmost") {
            return missing_tool_json(
                "xdotool",
                "Window capture with maim requires xdotool.",
                "x11-screenshot",
            );
        }

        let a: Vec<OsString> = vec!["-f".into(), format.into(), "--".into(), path.into()];
        return run_linux_command("maim", a, "maim", false, extras);
    }
    missing_tool_json(
        "scrot or maim",
        "Install with: sudo apt install scrot",
        "x11-screenshot",
    )
}

fn wayland_screenshot(
    path: &str,
    mode: &str,
    format: &str,
    extras: &[(&'static str, String)],
    scale: Option<f64>,
) -> String {
    if matches!(mode, "window" | "frontmost") {
        return linux_capabilities::unsupported("Targeted Wayland capture is unsupported; request mode=screen explicitly. No screenshot was taken.");
    }
    if linux_capabilities::protocols().capture == Some(false) {
        return linux_capabilities::unsupported("The compositor advertises neither wlr-screencopy nor the ext-image-copy/output-source pair used by grim. No screenshot was taken.");
    }
    if resolve_path_binary("grim").is_none() {
        return missing_tool_json(
            "grim",
            "Install with: sudo apt install grim",
            "wayland-screenshot",
        );
    }
    let encoding = if format == "jpg" { "jpeg" } else { "png" };
    let mut capture_args: Vec<OsString> = vec!["-t".into(), encoding.into()];
    if let Some(scale) = scale {
        capture_args.extend(["-s".into(), scale.to_string().into()]);
    }
    capture_args.extend(["--".into(), path.into()]);
    run_linux_command("grim", capture_args, "grim", false, extras)
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
            return linux_error_json("--coords must be in x,y form, e.g. 120,240.", None);
        }
    };
    let button = if has_flag(args, "--right") {
        3u32
    } else {
        1u32
    };
    let times = if has_flag(args, "--double") {
        2u32
    } else {
        1u32
    };
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
    if !geometry::x11_point_in_root(x, y) {
        if let Err(error) = process::check(deadline()) {
            return process_failure_json("xdotool", &error);
        }
        return json_obj(vec![("ok","false".into()),("supported","false".into()),("code",json_string("COORDINATES_OUT_OF_RANGE")),("error",json_string("X11 coordinates must be inside the verified root extent and signed 16-bit XTest range. No input was sent."))]);
    }
    let cmd_args: Vec<OsString> = vec![
        "mousemove".into(),
        "--sync".into(),
        "--".into(),
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
    if !geometry::wayland_pointer_ready(x, y) {
        if let Err(error) = process::check(deadline()) {
            return process_failure_json("ydotool", &error);
        }
        return json_obj(vec![("ok","false".into()),("supported","false".into()),("code",json_string("POINTER_MAPPING_UNVERIFIED")),("error",json_string("Absolute pointer mapping is unverified for this helper version, compositor layout or input configuration. No input was sent."))]);
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
            args: vec!["key".into(), "--clearmodifiers".into(), "ctrl+a".into()],
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
    let use_wtype = linux_capabilities::use_wtype();
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
    // Do not clear a field before discovering that the fallback cannot represent its text.
    if !text.is_ascii() {
        return linux_capabilities::unsupported("ydotool typing is limited to ASCII and depends on the active keyboard layout. Unicode requires wtype and the virtual-keyboard protocol.");
    }
    // ydotool fallback. Separate text from options.
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
        args: vec![
            "type".into(),
            "--escape".into(),
            "0".into(),
            "--".into(),
            text.into(),
        ],
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
    let wtype = linux_capabilities::use_wtype();
    if !wtype && resolve_path_binary("ydotool").is_none() {
        return linux_capabilities::unsupported("No usable Wayland keyboard provider. wtype needs virtual-keyboard; ydotool needs ydotoold/uinput access.");
    }
    let mut steps = Vec::new();
    for key in keys {
        if wtype {
            let mut parts: Vec<&str> = key.trim().split('+').collect();
            let name = parts.pop().unwrap_or("");
            if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                return linux_error_json("Invalid Wayland key name.", None);
            }
            let mut args = Vec::new();
            for modifier in &parts {
                if !["ctrl", "shift", "alt", "logo", "super", "meta"].contains(modifier) {
                    return linux_error_json("Unsupported Wayland key modifier.", None);
                }
                let modifier = if ["super", "meta"].contains(modifier) {
                    "logo"
                } else {
                    modifier
                };
                args.extend(["-M".into(), OsString::from(modifier)]);
            }
            args.extend(["-k".into(), map_key_wtype(name).into()]);
            for modifier in parts.iter().rev() {
                let modifier = if ["super", "meta"].contains(modifier) {
                    "logo"
                } else {
                    modifier
                };
                args.extend(["-m".into(), OsString::from(modifier)]);
            }
            steps.push(LinuxStep {
                program: "wtype",
                args,
            });
        } else {
            let Some(args) = linux_capabilities::evdev_args(key) else {
                return linux_capabilities::unsupported(
                    "Key/chord is not supported by the ydotool fallback. No input was sent.",
                );
            };
            steps.push(LinuxStep {
                program: "ydotool",
                args,
            });
        }
    }
    run_linux_steps(steps, if wtype { "wtype" } else { "ydotool" }, false, &[])
}

fn linux_scroll(session: LinuxSession, args: &[String]) -> String {
    let direction = value(args, "--direction").unwrap_or_else(|| "down".to_string());
    let amount = match value(args, "--amount") {
        None => 3,
        Some(raw) => match raw.parse::<u32>() {
            Ok(n @ 1..=50) => n,
            _ => return linux_error_json("Scroll amount must be an integer from 1 to 50.", None),
        },
    };
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
        _ => return linux_error_json("Invalid scroll direction.", None),
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
    if resolve_path_binary("ydotool").is_some() {
        let n = amount as i32;
        let (x, y) = match direction {
            "up" => (0, n),
            "down" => (0, -n),
            "left" => (-n, 0),
            "right" => (n, 0),
            _ => return linux_error_json("Invalid scroll direction.", None),
        };
        return run_linux_command(
            "ydotool",
            vec![
                "mousemove".into(),
                "--wheel".into(),
                "-x".into(),
                x.to_string().into(),
                "-y".into(),
                y.to_string().into(),
            ],
            "ydotool",
            false,
            &[],
        );
    }
    let key = match direction {
        "up" => "Page_Up",
        "down" => "Page_Down",
        "left" => "Left",
        "right" => "Right",
        _ => return linux_error_json("Invalid scroll direction.", None),
    };
    let keys: Vec<&str> = (0..amount).map(|_| key).collect();
    let result = wayland_keypress(&keys);
    let mut parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
    parsed["degraded"] = serde_json::Value::String(
        "Wayland scroll sends page/arrow keys, not wheel events; amount counts key presses.".into(),
    );
    parsed.to_string()
}

fn linux_focus(session: LinuxSession, args: &[String]) -> String {
    let app = value(args, "--app");
    let title = value(args, "--window-title");
    let window_id = value(args, "--window-id");

    if window_id.is_none() && app.is_none() && title.is_none() {
        return linux_error_json(
            "focus requires --app, --window-title, or --window-id on Linux.",
            None,
        );
    }

    match session {
        LinuxSession::X11 => x11_focus(app.as_deref(), title.as_deref(), window_id.as_deref()),
        LinuxSession::Wayland => {
            wayland_focus(app.as_deref(), title.as_deref(), window_id.as_deref())
        }
    }
}

fn numeric_window_id(value: &str) -> Option<u64> {
    if let Some(hex) = value.strip_prefix("0x") {
        u64::from_str_radix(hex, 16).ok()
    } else {
        value.parse().ok()
    }
}

fn regex_literal(value: &str) -> String {
    let mut result = String::new();
    for ch in value.chars() {
        if ".^$*+?()[]{}|\\".contains(ch) {
            result.push('\\');
        }
        result.push(ch);
    }
    result
}

fn x11_focus(app: Option<&str>, title: Option<&str>, window_id: Option<&str>) -> String {
    let requested_id = match window_id {
        Some(id) => match numeric_window_id(id) {
            Some(id) => Some(id),
            None => return linux_error_json("X11 window id must be numeric.", None),
        },
        None => None,
    };
    if resolve_path_binary("wmctrl").is_some() {
        let mut command = Command::new("wmctrl");
        command.arg("-lx");
        let output = match process::run(&mut command, deadline()) {
            Ok(output) if output.status.success() => output,
            Ok(_) => {
                return linux_error_json("Window inventory failed; focus was not changed.", None)
            }
            Err(error) => return process_failure_json("wmctrl", &error),
        };
        let wanted_title = title.map(|s| s.split_whitespace().collect::<Vec<_>>().join(" "));
        let mut matches = Vec::new();
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            let fields: Vec<&str> = line.split_whitespace().collect();
            if fields.len() < 4 {
                continue;
            }
            let Some(id) = numeric_window_id(fields[0]) else {
                continue;
            };
            let class = fields[2];
            let name = fields[4..].join(" ");
            if requested_id.is_some_and(|wanted| wanted != id) {
                continue;
            }
            if app.is_some_and(|wanted| {
                !class.eq_ignore_ascii_case(wanted)
                    && !class
                        .rsplit('.')
                        .next()
                        .unwrap_or("")
                        .eq_ignore_ascii_case(wanted)
            }) {
                continue;
            }
            if wanted_title
                .as_ref()
                .is_some_and(|wanted| !name.contains(wanted))
            {
                continue;
            }
            matches.push(fields[0].to_string());
        }
        if matches.len() != 1 {
            return linux_error_json("Focus target is missing or ambiguous; specify a unique window id. Focus was not changed.", None);
        }
        return run_linux_command(
            "wmctrl",
            vec!["-i".into(), "-a".into(), matches.remove(0).into()],
            "wmctrl",
            false,
            &[],
        );
    }
    if [app.is_some(), title.is_some(), window_id.is_some()]
        .into_iter()
        .filter(|v| *v)
        .count()
        > 1
    {
        return linux_capabilities::unsupported("Combined X11 focus selectors require wmctrl. No selector was discarded and focus was not changed.");
    }
    if resolve_path_binary("xdotool").is_none() {
        return missing_tool_json(
            "wmctrl or xdotool",
            "Install a supported focus helper.",
            "x11-focus",
        );
    }
    let args = if let Some(id) = requested_id {
        vec!["windowactivate".into(), id.to_string().into()]
    } else if let Some(app) = app {
        vec![
            "search".into(),
            "--class".into(),
            format!("^{}$", regex_literal(app)).into(),
            "windowactivate".into(),
        ]
    } else if let Some(title) = title {
        vec![
            "search".into(),
            "--name".into(),
            regex_literal(title).into(),
            "windowactivate".into(),
        ]
    } else {
        return linux_error_json("Missing focus target.", None);
    };
    run_linux_command("xdotool", args, "xdotool", false, &[])
}

fn wayland_focus(app: Option<&str>, title: Option<&str>, window_id: Option<&str>) -> String {
    if env::var_os("SWAYSOCK").is_some() && resolve_path_binary("swaymsg").is_some() {
        let mut criteria = Vec::new();
        if let Some(id) = window_id {
            let Some(id) = numeric_window_id(id) else {
                return linux_error_json("Wayland window id must be numeric.", None);
            };
            criteria.push(format!("con_id={id}"));
        }
        for (field, target, exact) in [("app_id", app, true), ("title", title, false)] {
            if let Some(target) = target {
                if target.is_empty() || target.chars().any(char::is_control) {
                    return linux_error_json(
                        "Focus target must be nonempty and contain no control characters.",
                        None,
                    );
                }
                let literal = regex_literal(target);
                let pattern = if exact {
                    format!("^{literal}$")
                } else {
                    literal
                };
                criteria.push(format!(
                    "{field}={}",
                    serde_json::to_string(&pattern).unwrap()
                ));
            }
        }
        let selector = format!("[{}] focus", criteria.join(" "));
        let mut cmd = Command::new("swaymsg");
        cmd.args(["-r", "--", &selector]);
        return match process::run(&mut cmd, deadline()) {
            Err(e) => process_failure_json("swaymsg", &e),
            Ok(output) => {
                let parsed = serde_json::from_slice::<serde_json::Value>(&output.stdout).ok();
                let ok = output.status.success()
                    && parsed.as_ref().and_then(|v| v.as_array()).is_some_and(|v| {
                        !v.is_empty() && v.iter().all(|item| item["success"] == true)
                    });
                if ok {
                    json_obj(vec![
                        ("ok", "true".into()),
                        ("backend", json_string("swaymsg")),
                    ])
                } else {
                    linux_error_json("Sway IPC rejected focus or returned malformed output. Raw diagnostics withheld.", None)
                }
            }
        };
    }
    if window_id.is_some() {
        return linux_error_json(
            "Wayland --window-id focus requires SWAYSOCK and swaymsg (Sway compositor).",
            Some("Connect via Sway or use an X11 session."),
        );
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
    let trimmed = key.trim();
    match trimmed.to_lowercase().as_str() {
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
        _ => trimmed.to_string(),
    }
}

fn map_key_wtype(key: &str) -> String {
    // wtype shares XKB key names with xdotool for the common cases.
    let trimmed = key.trim();
    match trimmed.to_lowercase().as_str() {
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
        _ => trimmed.to_string(),
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
    match process::run(&mut cmd, deadline()) {
        Ok(output) => {
            let ok = output.status.success();
            let mut fields = vec![
                ("ok", bool_json(ok)),
                ("supported", "true".into()),
                ("platform", json_string(env::consts::OS)),
                ("backend", json_string(backend_label)),
                ("exitCode", output.status.code().unwrap_or(-1).to_string()),
                ("stdoutRedacted", "true".into()),
            ];
            if !ok {
                fields.push(("code", json_string("BACKEND_ERROR")));
                fields.push((
                    "error",
                    json_string("Helper rejected the action; raw diagnostics were withheld."),
                ));
            }
            // Diagnostic argv/output may contain text, titles, secrets, or subprocess echoes.
            let _ = redact_type_text;
            for (k, v) in extra_fields {
                fields.push((k, v.clone()));
            }
            json_obj(fields)
        }
        Err(err) => process_failure_json(backend_label, &err),
    }
}

fn run_linux_steps(
    steps: Vec<LinuxStep>,
    backend_label: &str,
    redact_type_text: bool,
    extra_fields: &[(&'static str, String)],
) -> String {
    let mut completed = 0;
    let mut entries = Vec::new();
    let mut failure = None;
    for (index, step) in steps.iter().enumerate() {
        let entry = run_linux_command(
            step.program,
            step.args.clone(),
            backend_label,
            redact_type_text,
            &[],
        );
        let result: serde_json::Value = serde_json::from_str(&entry).unwrap();
        let ok = result["ok"] == true;
        entries.push(entry);
        if !ok {
            failure = Some((index, result));
            break;
        }
        completed += 1;
    }
    let mut fields = vec![
        ("ok", bool_json(failure.is_none())),
        ("supported", "true".into()),
        ("platform", json_string(env::consts::OS)),
        ("backend", json_string(backend_label)),
        ("completedSteps", completed.to_string()),
        ("totalSteps", steps.len().to_string()),
        ("steps", format!("[{}]", entries.join(","))),
        ("stdoutRedacted", "true".into()),
    ];
    if let Some((index, result)) = failure {
        fields.push(("failedStep", index.to_string()));
        fields.push(("partial", bool_json(completed > 0)));
        for key in ["exitCode", "code", "error", "timedOut", "cancelled"] {
            if let Some(v) = result.get(key) {
                fields.push((key, v.to_string()));
            }
        }
    } else {
        fields.push(("exitCode", "0".into()));
    }
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

#[cfg(test)]
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
    let mut i = 0;
    while i < args.len() {
        if args[i] == key {
            return args.get(i + 1).cloned();
        }
        i += if takes_value(&args[i]) { 2 } else { 1 };
    }
    None
}

fn has_flag<S: AsRef<str>>(args: &[S], key: &str) -> bool {
    let mut i = 0;
    while i < args.len() {
        let arg = args[i].as_ref();
        if arg == key {
            return true;
        }
        i += if takes_value(arg) { 2 } else { 1 };
    }
    false
}

fn output_path(value: Option<String>, kind: &str, format: &str) -> String {
    if let Some(path) = value {
        return path;
    }
    let mut path: PathBuf = env::temp_dir();
    path.push(format!(
        "opencoven-desktop-use-{kind}-{}.{format}",
        unique_suffix()
    ));
    path.to_string_lossy().to_string()
}

fn unique_suffix() -> String {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!(
        "{}-{timestamp}-{}",
        std::process::id(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    )
}

fn help_json() -> String {
    capabilities::attach(
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
        ]),
        &capabilities::discover(detect_platform()),
    )
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
    fn help_reports_canonical_cli_surface_without_advertising_host_commands() {
        let help: serde_json::Value = serde_json::from_str(&help_json()).unwrap();
        let report = &help["capabilitiesV1"];
        assert_eq!(report["schemaVersion"], 1);
        assert_eq!(report["producer"]["surface"], "cli");
        assert_eq!(report["actions"].as_object().unwrap().len(), 18);
        assert_eq!(report["actions"]["file-read"]["state"], "unsupported");
        assert_eq!(
            report["actions"]["file-read"]["surfaces"],
            serde_json::json!(["plugin"])
        );
        assert!(!help["commands"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!("file-read")));
    }

    #[test]
    fn interactive_aliases_still_require_confirmation() {
        let command = normalize_command("press").unwrap();
        let args = vec!["--keys".to_string(), "tab".to_string()];
        // Verify every backend gate without requiring a display session on CI.
        for result in [
            run_macos(command, &args),
            run_linux(LinuxSession::X11, command, &args),
            run_linux(LinuxSession::Wayland, command, &args),
        ] {
            assert!(result.contains("requiresConfirmation"));
            assert!(result.contains("keypress"));
        }
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
        // Unknown names pass through preserving original case (xdotool accepts XKeysym names directly).
        assert_eq!(map_key_xdotool("F5"), "F5");
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
        assert_eq!(
            redacted,
            vec!["type".to_string(), "<5-byte text>".to_string()]
        );
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
        assert!(result.contains("--window-id"));
    }

    #[test]
    fn linux_minimum_tools_requires_capture_and_input() {
        let none = vec![
            LinuxToolStatus {
                name: "scrot",
                found: false,
                path: None,
            },
            LinuxToolStatus {
                name: "xdotool",
                found: false,
                path: None,
            },
        ];
        assert!(!linux_minimum_tools_present(LinuxSession::X11, &none));

        let only_capture = vec![
            LinuxToolStatus {
                name: "scrot",
                found: true,
                path: Some("/usr/bin/scrot".into()),
            },
            LinuxToolStatus {
                name: "xdotool",
                found: false,
                path: None,
            },
        ];
        assert!(!linux_minimum_tools_present(
            LinuxSession::X11,
            &only_capture
        ));

        let both = vec![
            LinuxToolStatus {
                name: "scrot",
                found: true,
                path: Some("/usr/bin/scrot".into()),
            },
            LinuxToolStatus {
                name: "xdotool",
                found: true,
                path: Some("/usr/bin/xdotool".into()),
            },
        ];
        assert!(linux_minimum_tools_present(LinuxSession::X11, &both));

        let wl_ok = vec![
            LinuxToolStatus {
                name: "grim",
                found: true,
                path: Some("/usr/bin/grim".into()),
            },
            LinuxToolStatus {
                name: "ydotool",
                found: true,
                path: Some("/usr/bin/ydotool".into()),
            },
        ];
        assert!(linux_minimum_tools_present(LinuxSession::Wayland, &wl_ok));
    }
}

#[cfg(all(test, unix))]
mod helper_regressions {
    use super::*;

    #[test]
    fn sequence_stops_at_first_failure_and_reports_partial_progress() {
        let marker =
            env::temp_dir().join(format!("desktopuse-must-not-run-{}", std::process::id()));
        let result = run_linux_steps(
            vec![
                LinuxStep {
                    program: "/bin/sh",
                    args: vec!["-c".into(), "exit 7".into()],
                },
                LinuxStep {
                    program: "/usr/bin/touch",
                    args: vec![marker.clone().into_os_string()],
                },
            ],
            "fixture",
            false,
            &[],
        );
        let ran = marker.exists();
        let _ = std::fs::remove_file(marker);
        assert!(!ran, "later action executed after first failure: {result}");
        assert!(result.contains("\"failedStep\":0"), "{result}");
        assert!(result.contains("\"completedSteps\":0"), "{result}");
    }

    #[test]
    fn partial_sequence_preserves_first_failure_and_skips_remaining_steps() {
        let result = run_linux_steps(
            vec![
                LinuxStep {
                    program: "/bin/sh",
                    args: vec!["-c".into(), "exit 0".into()],
                },
                LinuxStep {
                    program: "/bin/sh",
                    args: vec!["-c".into(), "exit 9".into()],
                },
                LinuxStep {
                    program: "/bin/sh",
                    args: vec!["-c".into(), "exit 0".into()],
                },
            ],
            "fixture",
            false,
            &[],
        );
        let value: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(value["ok"], false);
        assert_eq!(value["completedSteps"], 1);
        assert_eq!(value["failedStep"], 1);
        assert_eq!(value["partial"], true);
        assert_eq!(value["exitCode"], 9);
        assert_eq!(value["steps"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn typing_failure_never_echoes_private_output_or_stderr() {
        let result = run_linux_command(
            "/bin/sh",
            vec![
                "-c".into(),
                "printf arbitrary-private-text; printf arbitrary-private-text >&2; exit 1".into(),
            ],
            "fixture",
            true,
            &[],
        );
        assert!(!result.contains("arbitrary-private-text"), "{result}");
    }
}

#[cfg(all(test, unix))]
mod peekaboo_outcome_tests {
    use super::*;
    use std::os::unix::process::ExitStatusExt;

    #[test]
    fn exit_zero_backend_failure_is_error_without_private_diagnostics() {
        let output = std::process::Output { status: std::process::ExitStatus::from_raw(0),
            stdout: br#"{"success":false,"error":{"code":"PERMISSION_ERROR","message":"private-typed-diagnostic"}}"#.to_vec(), stderr: b"private-typed-diagnostic".to_vec() };
        let result = peekaboo_result(output, true, false);
        assert!(result.contains("\"ok\":false"));
        assert!(result.contains("PERMISSION_ERROR"));
        assert!(!result.contains("private-typed-diagnostic"));
    }

    #[test]
    fn malformed_backend_json_is_not_success() {
        let output = std::process::Output {
            status: std::process::ExitStatus::from_raw(0),
            stdout: b"private-invalid-json".to_vec(),
            stderr: vec![],
        };
        let result = peekaboo_result(output, false, false);
        assert!(result.contains("\"ok\":false"));
        assert!(result.contains("MALFORMED_OUTPUT"));
        assert!(!result.contains("private-invalid-json"));
    }
}
