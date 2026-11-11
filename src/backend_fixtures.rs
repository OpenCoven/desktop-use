//! Isolated subprocess fixtures: never mutate the test runner's PATH or display environment.
use super::*;
use serde_json::{json, Value};
use std::fs;
use std::os::unix::fs::PermissionsExt;

pub struct Fixture {
    pub root: PathBuf,
}
impl Fixture {
    pub fn new() -> Self {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let root = env::temp_dir().join(format!(
            "desktopuse-fixture-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        Self { root }
    }
    pub fn tool(&self, name: &str, script: &str) {
        let file = self.root.join(name);
        fs::write(&file, format!("#!/bin/sh\n{script}\n")).unwrap();
        fs::set_permissions(file, fs::Permissions::from_mode(0o700)).unwrap();
    }
    pub fn run(&self, config: Value) -> Value {
        let mut child = Command::new(env::current_exe().unwrap());
        child
            .args([
                "--ignored",
                "--exact",
                "backend_fixtures::entry",
                "--nocapture",
            ])
            .env("PATH", &self.root)
            .env("FIXTURE_CONFIG", config.to_string())
            .env("FIXTURE_OUTPUT", self.root.join("result.json"))
            .env("FIXTURE_LOG", self.root.join("argv.log"));
        for key in [
            "SWAYSOCK",
            "HYPRLAND_INSTANCE_SIGNATURE",
            "XDG_CURRENT_DESKTOP",
            "WAYLAND_DISPLAY",
            "DISPLAY",
            "XDG_SESSION_TYPE",
            "YDOTOOL_SOCKET",
        ] {
            child.env_remove(key);
        }
        if let Some(vars) = config.get("env").and_then(Value::as_object) {
            for (key, value) in vars {
                child.env(key, value.as_str().unwrap());
            }
        }
        let output = child.output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&fs::read(self.root.join("result.json")).unwrap()).unwrap()
    }
    pub fn log(&self) -> String {
        fs::read_to_string(self.root.join("argv.log")).unwrap_or_default()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
#[ignore = "subprocess fixture entry only"]
fn entry() {
    let config: Value = serde_json::from_str(&env::var("FIXTURE_CONFIG").unwrap()).unwrap();
    DEADLINE.with(|d| {
        d.set(Some(
            Instant::now() + Duration::from_millis(config["timeoutMs"].as_u64().unwrap_or(1000)),
        ))
    });
    let args: Vec<String> = config["args"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_owned())
        .collect();
    let result = match config["platform"].as_str().unwrap() {
        "macos" => run_macos(normalize_command(&args[0]).unwrap(), &args[1..]),
        "cli" => run(args),
        session => run_linux(
            if session == "x11" {
                LinuxSession::X11
            } else {
                LinuxSession::Wayland
            },
            normalize_command(&args[0]).unwrap(),
            &args[1..],
        ),
    };
    fs::write(env::var("FIXTURE_OUTPUT").unwrap(), result).unwrap();
}

#[test]
fn peekaboo_success_permission_denial_and_malformed_output() {
    let f = Fixture::new();
    f.tool("peekaboo", "printf '%s' '{\"success\":true,\"data\":{}}'");
    assert_eq!(
        f.run(json!({"platform":"macos","args":["doctor"]}))["ok"],
        true
    );
    f.tool("peekaboo", "printf '%s' '{\"success\":false,\"error\":{\"code\":\"PERMISSION_ERROR\",\"message\":\"private-diagnostic\"}}'");
    let result = f.run(json!({"platform":"macos","args":["inspect"]}));
    assert_eq!(result["ok"], false);
    assert_eq!(result["code"], "PERMISSION_ERROR");
    assert!(result.get("permissionGuide").is_some());
    assert!(!result.to_string().contains("private-diagnostic"));
    f.tool("peekaboo", "printf private-diagnostic");
    let result = f.run(json!({"platform":"macos","args":["doctor"]}));
    assert_eq!(result["code"], "MALFORMED_OUTPUT");
    assert!(!result.to_string().contains("private-diagnostic"));
}

#[test]
fn cli_flag_values_are_not_interpreted_as_confirmation() {
    let f = Fixture::new();
    let result = f.run(json!({"platform":"cli","env":{"DISPLAY":":fixture"},"args":["type-text","--text","--confirm"]}));
    assert_eq!(result["requiresConfirmation"], true);
}

#[test]
fn missing_linux_dependency_is_clear() {
    let f = Fixture::new();
    let result = f.run(json!({"platform":"x11","args":["click","--coords","1,2","--confirm"]}));
    assert_eq!(result["ok"], false);
    assert!(result["error"]
        .as_str()
        .unwrap()
        .contains("Missing required tool"));
}

#[test]
fn type_text_preserves_literal_argv_and_redacts_success_diagnostics() {
    let f = Fixture::new();
    f.tool(
        "xdotool",
        r#"printf '%s\n' "$@" >> "$FIXTURE_LOG"; printf private-diagnostic >&2; exit 0"#,
    );
    let text = "--literal $(false); `false` 'quoted'";
    let result = f.run(json!({"platform":"x11","args":["type-text","--text",text,"--confirm"]}));
    assert_eq!(result["ok"], true);
    assert!(f.log().contains(text));
    assert!(!result.to_string().contains("private-diagnostic"));
    assert!(!result.to_string().contains(text));
}

#[test]
fn wayland_uses_protocol_inventory_and_avoids_wtype_without_virtual_keyboard() {
    let f = Fixture::new();
    f.tool(
        "wayland-info",
        "printf '%s' \"interface: 'wl_compositor', version: 5, name: 1\"",
    );
    f.tool("wtype", r#"printf 'wtype\n' >> "$FIXTURE_LOG"; exit 1"#);
    f.tool("ydotool", r#"printf '%s\n' "$@" >> "$FIXTURE_LOG"; exit 0"#);
    let result = f.run(json!({"platform":"wayland","env":{"XDG_CURRENT_DESKTOP":"GNOME"},"args":["type-text","--text","--private-literal","--confirm"]}));
    assert_eq!(result["ok"], true);
    assert_eq!(result["backend"], "ydotool");
    assert!(!f.log().contains("wtype"));
    assert!(f.log().contains("type\n--escape\n0\n--\n--private-literal"));
}

#[test]
fn wayland_doctor_does_not_claim_installed_tools_prove_protocols_or_daemon_access() {
    let f = Fixture::new();
    for name in ["grim", "wtype", "ydotool"] {
        f.tool(name, "exit 0");
    }
    f.tool(
        "wayland-info",
        "printf '%s' \"interface: 'wl_compositor', version: 5, name: 1\"",
    );
    let result = f.run(json!({"platform":"wayland","args":["doctor"]}));
    assert_eq!(result["ok"], false);
    assert_eq!(result["capabilities"]["screenshot"]["state"], "unsupported");
    assert_eq!(result["capabilities"]["typing"]["state"], "unverified");
    assert_eq!(result["capabilities"]["focus"]["state"], "unsupported");
}

#[test]
fn wayland_scroll_degrades_to_page_keys_with_only_wtype() {
    let f = Fixture::new();
    f.tool("wtype", r#"printf '%s\n' "$@" >> "$FIXTURE_LOG"; exit 0"#);
    let result = f.run(json!({"platform":"wayland","args":["scroll","--direction","down","--amount","2","--confirm"]}));
    assert_eq!(result["ok"], true);
    assert!(result["degraded"].is_string());
    assert_eq!(f.log(), "-k\nPage_Down\n-k\nPage_Down\n");
}

#[test]
fn wayland_targeted_screenshot_never_silently_captures_entire_desktop() {
    let f = Fixture::new();
    f.tool("grim", r#"printf called >> "$FIXTURE_LOG"; exit 0"#);
    let result = f.run(json!({"platform":"wayland","args":["screenshot","--mode","window"]}));
    assert_eq!(result["ok"], false);
    assert_eq!(result["supported"], false);
    assert!(f.log().is_empty());
}

#[test]
fn sway_focus_rejects_command_injection_and_exit_zero_failure_json() {
    let f = Fixture::new();
    f.tool("swaymsg", r#"printf '%s\n' "$@" >> "$FIXTURE_LOG"; printf '[{"success":false,"error":"private-diagnostic"}]'"#);
    let env = json!({"SWAYSOCK":"/fixture-sway"});
    let result = f.run(json!({"platform":"wayland","env":env,"args":["focus","--window-id","1] focus; exec private-command","--confirm"]}));
    assert_eq!(result["ok"], false);
    assert!(f.log().is_empty());
    let result = f.run(
        json!({"platform":"wayland","env":env,"args":["focus","--window-id","123","--confirm"]}),
    );
    assert_eq!(result["ok"], false);
    assert!(!result.to_string().contains("private-diagnostic"));
}

#[test]
fn ydotool_wheel_and_literal_typing_options_are_correct() {
    let f = Fixture::new();
    f.tool("ydotool", r#"printf '%s\n' "$@" >> "$FIXTURE_LOG"; exit 0"#);
    let result = f.run(json!({"platform":"wayland","args":["scroll","--direction","down","--amount","2","--confirm"]}));
    assert_eq!(result["ok"], true);
    assert!(result.get("degraded").is_none());
    assert_eq!(f.log(), "mousemove\n--wheel\n-x\n0\n-y\n-2\n");
    fs::write(f.root.join("argv.log"), "").unwrap();
    let result = f.run(json!({"platform":"wayland","args":["type-text","--text",r"literal\n$(false)","--confirm"]}));
    assert_eq!(result["ok"], true);
    assert!(f.log().contains("--escape\n0\n--\nliteral\\n$(false)"));
}

#[test]
fn screenshot_paths_cannot_become_helper_options() {
    let f = Fixture::new();
    let script = r#"for arg in "$@"; do
if [ "$arg" = '--' ]; then break; fi
case "$arg" in --exec=*) printf unsafe-option >> "$FIXTURE_LOG";; esac
done
printf '%s\n' "$@" >> "$FIXTURE_LOG"
exit 0"#;
    for helper in ["scrot", "maim"] {
        f.tool(helper, script);
        let result = f
            .run(json!({"platform":"x11","args":["screenshot","--path","--exec=private-command"]}));
        assert_eq!(result["code"], "CAPTURE_MISSING");
        assert!(!f.log().contains("unsafe-option"));
        assert!(f.log().contains("--\n--exec=private-command"));
        let _ = fs::remove_file(f.root.join(helper));
        fs::write(f.root.join("argv.log"), "").unwrap();
    }
}

#[test]
fn linux_rejects_unimplemented_target_selectors_before_any_desktop_helper() {
    let f = Fixture::new();
    for helper in ["scrot", "grim", "xdotool", "ydotool", "wtype"] {
        f.tool(helper, r#"printf called >> "$FIXTURE_LOG"; exit 0"#);
    }
    for platform in ["x11", "wayland"] {
        for args in [
            vec!["screenshot", "--window-id", "12"],
            vec!["inspect", "--screen-index", "1"],
            vec![
                "type-text",
                "--app",
                "fixture-app",
                "--text",
                "test",
                "--clear",
                "--return",
                "--confirm",
            ],
            vec![
                "click",
                "--coords",
                "1,1",
                "--app",
                "fixture-app",
                "--confirm",
            ],
            vec!["scroll", "--on", "B1", "--confirm"],
            vec![
                "keypress",
                "--keys",
                "tab",
                "--window-title",
                "fixture",
                "--confirm",
            ],
        ] {
            let result = f.run(json!({"platform":platform,"args":args}));
            assert_eq!(result["supported"], false, "{result}");
            assert!(f.log().is_empty());
        }
    }
}

#[test]
fn invalid_scroll_direction_never_reaches_xdotool() {
    let f = Fixture::new();
    f.tool("xdotool", r#"printf called >> "$FIXTURE_LOG"; exit 0"#);
    let result =
        f.run(json!({"platform":"x11","args":["scroll","--direction","invalid","--confirm"]}));
    assert_eq!(result["ok"], false);
    assert!(f.log().is_empty());
}

#[test]
fn macos_type_passes_flag_like_text_as_literal_positional_input() {
    let f = Fixture::new();
    f.tool(
        "peekaboo",
        r#"printf '%s\n' "$@" >> "$FIXTURE_LOG"; printf '{"success":true}'"#,
    );
    let result = f.run(json!({"platform":"macos","args":["type-text","--text","--help","--clear","--return","--confirm"]}));
    assert_eq!(result["ok"], true);
    assert_eq!(
        f.log(),
        "type\n--clear\n--return\n--json\n--no-remote\n--\n--help\n"
    );
}

#[test]
fn ext_capture_protocol_is_unverified_helper_compatibility_instead_of_falsely_unsupported() {
    let f = Fixture::new();
    f.tool("wayland-info", "printf '%s' \"interface: 'ext_image_copy_capture_manager_v1' interface: 'ext_output_image_capture_source_manager_v1'\"");
    f.tool("grim", r#"printf '%s\n' "$@" >> "$FIXTURE_LOG"; for arg in "$@"; do target="$arg"; done; printf fixture-image > "$target""#);
    let result = f.run(json!({"platform":"wayland","args":["doctor"]}));
    assert_eq!(result["capabilities"]["screenshot"]["state"], "unverified");
    let result = f.run(json!({"platform":"wayland","args":["screenshot","--mode","screen","--path",f.root.join("capture.png").to_string_lossy()]}));
    assert_eq!(result["ok"], true);
    assert!(!f.log().is_empty());
}

#[test]
fn advertised_virtual_keyboard_prefers_wtype_and_supports_chords() {
    let f = Fixture::new();
    f.tool("wayland-info", "printf '%s' \"interface: 'zwp_virtual_keyboard_manager_v1' interface: 'zwlr_screencopy_manager_v1'\"");
    f.tool("wtype", r#"printf '%s\n' "$@" >> "$FIXTURE_LOG"; exit 0"#);
    f.tool("ydotool", "exit 9");
    let result =
        f.run(json!({"platform":"wayland","args":["type-text","--text","unicode-é","--confirm"]}));
    assert_eq!(result["ok"], true);
    assert_eq!(result["backend"], "wtype");
    fs::write(f.root.join("argv.log"), "").unwrap();
    let result =
        f.run(json!({"platform":"wayland","args":["keypress","--keys","ctrl+a","--confirm"]}));
    assert_eq!(result["ok"], true);
    assert_eq!(f.log(), "-M\nctrl\n-k\na\n-m\nctrl\n");
}

#[test]
fn screenshot_exit_zero_without_an_artifact_is_not_success() {
    let f = Fixture::new();
    f.tool("scrot", "exit 0");
    let path = f.root.join("capture.png").to_string_lossy().to_string();
    let result = f.run(json!({"platform":"x11","args":["screenshot","--path",path]}));
    assert_eq!(result["ok"], false);
    assert_eq!(result["code"], "CAPTURE_MISSING");
    f.tool(
        "scrot",
        r#"for arg in "$@"; do target="$arg"; done; printf fixture-image > "$target""#,
    );
    let result = f.run(json!({"platform":"x11","args":["screenshot","--path",path]}));
    assert_eq!(result["ok"], true);
}
