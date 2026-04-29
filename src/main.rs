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

    let command = args[0].as_str();
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
        "permissions" => run_peekaboo(vec!["permissions".into()], false),
        "see" => run_peekaboo(build_see_args(&args[1..]), false),
        "capture" => run_peekaboo(build_capture_args(&args[1..]), false),
        "click" | "type" | "press" | "scroll" | "focus" if !has_flag(&args[1..], "--confirm") => {
            confirmation_required(command)
        }
        "click" => run_peekaboo(
            build_click_args(&strip_flag(&args[1..], "--confirm")),
            false,
        ),
        "type" => run_peekaboo(build_type_args(&strip_flag(&args[1..], "--confirm")), true),
        "press" => run_peekaboo(
            build_press_args(&strip_flag(&args[1..], "--confirm")),
            false,
        ),
        "scroll" => run_peekaboo(
            build_scroll_args(&strip_flag(&args[1..], "--confirm")),
            false,
        ),
        "focus" => run_peekaboo(
            build_focus_args(&strip_flag(&args[1..], "--confirm")),
            false,
        ),
        _ => json_obj(vec![
            ("ok", "false".to_string()),
            (
                "error",
                json_string(&format!("unknown command: {}", command)),
            ),
            (
                "help",
                json_string(
                    "commands: permissions, see, capture, click, type, press, scroll, focus",
                ),
            ),
        ]),
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

fn build_see_args(args: &[String]) -> Vec<OsString> {
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
        output_path(value(args, "--path"), "see", "png").into(),
    ]);
    if let Some(analyze) = value(args, "--analyze") {
        out.extend(["--analyze".into(), analyze.into()]);
    }
    out
}

fn build_capture_args(args: &[String]) -> Vec<OsString> {
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
        output_path(value(args, "--path"), "capture", &format).into(),
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

fn run_peekaboo(mut args: Vec<OsString>, redact_type_text: bool) -> String {
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
            json_obj(vec![
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
                (
                    "stderr",
                    json_string(&String::from_utf8_lossy(&output.stderr)),
                ),
            ])
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
        ]),
    }
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
                "permissions".into(),
                "see".into(),
                "capture".into(),
                "click".into(),
                "type".into(),
                "press".into(),
                "scroll".into(),
                "focus".into(),
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
