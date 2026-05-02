use std::env;
use std::ffi::OsString;
use std::path::PathBuf;
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

    let command = normalize_command(args[0].as_str());
    if !cfg!(target_os = "macos") {
        return json_obj(vec![
            ("ok", "false".to_string()),
            ("supported", "false".to_string()),
            ("platform", json_string(env::consts::OS)),
            ("backend", json_string("none")),
            ("message", json_string("coven-desktop-use currently supports macOS via Peekaboo. This platform is unsupported.")),
        ]);
    }

    match command {
        Some("doctor") => run_peekaboo(vec!["permissions".into()], false, true),
        Some("inspect") => run_peekaboo(build_inspect_args(&args[1..]), false, false),
        Some("screenshot") => run_peekaboo(build_screenshot_args(&args[1..]), false, false),
        Some("click" | "type-text" | "keypress" | "scroll" | "focus")
            if !has_flag(&args[1..], "--confirm") =>
        {
            confirmation_required(command.unwrap())
        }
        Some("click") => run_peekaboo(
            build_click_args(&strip_flag(&args[1..], "--confirm")),
            false,
            false,
        ),
        Some("type-text") => run_peekaboo(
            build_type_args(&strip_flag(&args[1..], "--confirm")),
            true,
            false,
        ),
        Some("keypress") => run_peekaboo(
            build_press_args(&strip_flag(&args[1..], "--confirm")),
            false,
            false,
        ),
        Some("scroll") => run_peekaboo(
            build_scroll_args(&strip_flag(&args[1..], "--confirm")),
            false,
            false,
        ),
        Some("focus") => run_peekaboo(
            build_focus_args(&strip_flag(&args[1..], "--confirm")),
            false,
            false,
        ),
        Some(_) | None => json_obj(vec![
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
        ]),
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
        ("primaryBinaryToAdd", json_string(&adapter_path)),
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

fn redact_args(args: &[OsString], redact_type_text: bool) -> Vec<String> {
    let mut items: Vec<String> = args
        .iter()
        .map(|a| a.to_string_lossy().to_string())
        .collect();
    if redact_type_text {
        if let Some(pos) = items.iter().position(|v| v == "type") {
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
}
