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
        fs::write(
            root.join("input-image"),
            include_bytes!("../contracts/v1/fixtures/images/valid.png"),
        )
        .unwrap();
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
            .env("FIXTURE_READY", self.root.join("ready"))
            .env("FIXTURE_LOG", self.root.join("argv.log"))
            .env("FIXTURE_IMAGE", self.root.join("input-image"));
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
        child
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let mut running = child.spawn().unwrap();
        if let Some(ms) = config["cancelAfterMs"].as_u64() {
            let ready = self.root.join("ready");
            let end = Instant::now() + Duration::from_secs(2);
            while !ready.exists() && Instant::now() < end {
                std::thread::sleep(Duration::from_millis(5));
            }
            if !ready.exists() {
                let _ = running.kill();
                panic!("fixture did not initialize cancellation");
            }
            std::thread::sleep(Duration::from_millis(ms));
            unsafe {
                libc::kill(running.id() as i32, libc::SIGTERM);
            }
        }
        let output = running.wait_with_output().unwrap();
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
    process::install_cancellation();
    fs::write(env::var("FIXTURE_READY").unwrap(), "ready").unwrap();
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
        assert!(f.log().contains("--\n"));
        assert!(!f.log().contains("--exec=private-command"));
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
    f.tool("grim", r#"printf '%s\n' "$@" >> "$FIXTURE_LOG"; for arg in "$@"; do target="$arg"; done; /bin/cp "$FIXTURE_IMAGE" "$target""#);
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
        r#"for arg in "$@"; do target="$arg"; done; /bin/cp "$FIXTURE_IMAGE" "$target""#,
    );
    let result = f.run(json!({"platform":"x11","args":["screenshot","--path",path]}));
    assert_eq!(result["ok"], true);
}

#[test]
fn desktop_name_without_registry_evidence_leaves_protocols_unverified() {
    let f = Fixture::new();
    f.tool("wtype", "exit 1");
    f.tool("grim", "exit 1");
    let result =
        f.run(json!({"platform":"wayland","env":{"XDG_CURRENT_DESKTOP":"KDE"},"args":["doctor"]}));
    assert_eq!(result["capabilities"]["typing"]["state"], "unverified");
    assert_eq!(result["capabilities"]["screenshot"]["state"], "unverified");
}

#[test]
fn capture_does_not_accept_a_stale_destination_as_new_evidence() {
    let f = Fixture::new();
    let path = f.root.join("old.png");
    fs::write(&path, "old-image").unwrap();
    f.tool("scrot", "exit 0");
    let result =
        f.run(json!({"platform":"x11","args":["screenshot","--path",path.to_string_lossy()]}));
    assert_eq!(result["ok"], false);
    assert_eq!(result["code"], "CAPTURE_MISSING");
    assert_eq!(fs::read_to_string(&path).unwrap(), "old-image");
}

#[test]
fn sway_focus_combines_targets_and_treats_regex_punctuation_literally() {
    let f = Fixture::new();
    f.tool(
        "swaymsg",
        r#"printf '%s\n' "$@" >> "$FIXTURE_LOG"; printf '[{"success":true}]'"#,
    );
    let result = f.run(json!({"platform":"wayland","env":{"SWAYSOCK":"/fixture"},"args":["focus","--app","org.example.App","--window-title","Draft [1]","--confirm"]}));
    assert_eq!(result["ok"], true);
    assert_eq!(
        f.log().lines().last().unwrap(),
        r#"[app_id="^org\\.example\\.App$" title="Draft \\[1\\]"] focus"#
    );
}

#[test]
fn x11_focus_matches_app_and_title_together_without_regex_broadening() {
    let f = Fixture::new();
    f.tool("wmctrl", r#"if [ "$1" = '-lx' ]; then
printf '%s\n' '0x00000001 0 org.example.App fixture-host Other' '0x00000002 0 org.example.App fixture-host Draft [1]' '0x00000003 0 orgXexampleXApp fixture-host Draft [1]'
else printf '%s\n' "$@" >> "$FIXTURE_LOG"; fi"#);
    let result = f.run(json!({"platform":"x11","args":["focus","--app","org.example.App","--window-title","Draft [1]","--confirm"]}));
    assert_eq!(result["ok"], true);
    assert_eq!(f.log(), "-i\n-a\n0x00000002\n");
}

#[test]
fn cancelled_wayland_doctor_never_becomes_successful_unknown_capabilities() {
    let f = Fixture::new();
    for name in ["grim", "ydotool"] {
        f.tool(name, "exit 0");
    }
    f.tool("wayland-info", "/bin/sleep 5");
    let result = f.run(json!({"platform":"wayland","args":["doctor"],"cancelAfterMs":50}));
    assert_eq!(result["ok"], false);
    assert_eq!(result["code"], "CANCELLED");
}

#[test]
fn peekaboo_query_and_key_positionals_cannot_become_options() {
    let f = Fixture::new();
    f.tool(
        "peekaboo",
        r#"printf '%s\n' "$@" >> "$FIXTURE_LOG"; printf '{"success":true}'"#,
    );
    let result = f.run(json!({"platform":"macos","args":["click","--query","--help","--confirm"]}));
    assert_eq!(result["ok"], true);
    assert_eq!(f.log(), "click\n--json\n--no-remote\n--\n--help\n");
    fs::write(f.root.join("argv.log"), "").unwrap();
    let result =
        f.run(json!({"platform":"macos","args":["keypress","--keys","--help,tab","--confirm"]}));
    assert_eq!(result["ok"], true);
    assert_eq!(f.log(), "press\n--json\n--no-remote\n--\n--help\ntab\n");
}

#[test]
fn ydotool_only_input_skips_irrelevant_wayland_registry_probe() {
    let f = Fixture::new();
    f.tool(
        "wayland-info",
        r#"printf 'probe\n' >> "$FIXTURE_LOG"; /bin/sleep 5"#,
    );
    f.tool("ydotool", r#"printf 'input\n' >> "$FIXTURE_LOG"; exit 0"#);
    let result=f.run(json!({"platform":"wayland","args":["type-text","--text","fixture","--confirm"],"timeoutMs":1000}));
    assert_eq!(result["ok"], true);
    assert_eq!(f.log(), "input\n");
}

#[test]
fn wayland_capture_encoding_follows_requested_format_not_destination_suffix() {
    let f = Fixture::new();
    f.tool("grim",r#"printf '%s\n' "$@" >> "$FIXTURE_LOG"; for arg in "$@"; do target="$arg"; done; /bin/cp "$FIXTURE_IMAGE" "$target""#);
    for (format, name, encoding) in [
        ("png", "capture.jpg", "png"),
        ("jpg", "capture.png", "jpeg"),
    ] {
        fs::write(
            f.root.join("input-image"),
            if format == "png" {
                include_bytes!("../contracts/v1/fixtures/images/valid.png").as_slice()
            } else {
                include_bytes!("../contracts/v1/fixtures/images/valid.jpg").as_slice()
            },
        )
        .unwrap();
        fs::write(f.root.join("argv.log"), "").unwrap();
        let result=f.run(json!({"platform":"wayland","args":["screenshot","--format",format,"--path",f.root.join(name).to_string_lossy()]}));
        assert_eq!(result["ok"], true);
        assert!(
            f.log().starts_with(&format!("-t\n{encoding}\n")),
            "{}",
            f.log()
        );
    }
}

#[test]
fn timeout_flag_without_value_is_rejected_before_input_dispatch() {
    let f = Fixture::new();
    for tool in ["peekaboo", "xdotool"] {
        f.tool(tool, r#"printf called >> "$FIXTURE_LOG"; exit 0"#);
    }
    let result=f.run(json!({"platform":"cli","env":{"DISPLAY":":fixture"},"args":["type-text","--text","hello","--confirm","--timeout-ms"]}));
    assert_eq!(result["ok"], false);
    assert!(result["error"].as_str().unwrap().contains("--timeout-ms"));
    assert!(f.log().is_empty());
}

// Removing owned full-image validation must make these tests fail: helpers here
// really write the supplied fixture to the exact argv destination.
fn capture_fixture(f: &Fixture, helper: &str, bytes: &[u8]) {
    fs::write(f.root.join("input-image"), bytes).unwrap();
    f.tool(helper, r#"printf '%s\n' "$@" >> "$FIXTURE_LOG"
previous=; for arg in "$@"; do if [ "$previous" = --path ]; then target="$arg"; fi; previous="$arg"; done
if [ -z "$target" ]; then for arg in "$@"; do target="$arg"; done; fi
/bin/cp "$FIXTURE_IMAGE" "$target"
printf '{"success":true,"data":{"path":"/unrelated/private.png"}}'"#);
}

#[test]
fn validated_owned_png_and_jpeg_receipts_ignore_destination_suffix() {
    for (format, bytes, mime) in [
        (
            "png",
            include_bytes!("../contracts/v1/fixtures/images/valid.png").as_slice(),
            "image/png",
        ),
        (
            "jpg",
            include_bytes!("../contracts/v1/fixtures/images/valid.jpg").as_slice(),
            "image/jpeg",
        ),
    ] {
        for (platform, helper) in [
            ("x11", "scrot"),
            ("x11", "maim"),
            ("wayland", "grim"),
            ("macos", "peekaboo"),
        ] {
            let f = Fixture::new();
            capture_fixture(&f, helper, bytes);
            let path = f.root.join("destination.wrong-extension");
            let result = f.run(json!({"platform":platform,"args":["screenshot","--mode","screen","--format",format,"--path",path]}));
            assert_eq!(result["ok"], true, "{platform} {format}: {result}");
            let receipt = &result["observationV1"];
            assert_eq!(receipt["schemaVersion"], 1, "{result}");
            assert_eq!(receipt["primaryImage"]["mimeType"], mime);
            assert_eq!(receipt["primaryImage"]["byteLength"], bytes.len());
            assert_eq!(
                receipt["primaryImage"]["sourceDimensions"],
                json!({"width":32,"height":24})
            );
            assert_eq!(receipt["geometry"]["state"], "unavailable");
            assert_eq!(receipt["provider"]["version"], Value::Null);
            assert_eq!(fs::read(path).unwrap(), bytes);
        }
    }
}

#[test]
fn malformed_or_wrong_encoding_capture_never_publishes_a_receipt_or_destination() {
    let png = include_bytes!("../contracts/v1/fixtures/images/valid.png");
    let jpg = include_bytes!("../contracts/v1/fixtures/images/valid.jpg");
    for (format, bytes) in [
        ("png", b"not-an-image".as_slice()),
        ("png", b"".as_slice()),
        ("png", &png[..33]),
        ("png", &png[..png.len() - 8]),
        ("png", jpg.as_slice()),
        ("jpg", png.as_slice()),
        (
            "jpg",
            include_bytes!("../contracts/v1/fixtures/images/jpeg-missing-eoi.jpg").as_slice(),
        ),
        (
            "jpg",
            include_bytes!("../contracts/v1/fixtures/images/jpeg-truncated-entropy.jpg").as_slice(),
        ),
    ] {
        for (platform, helper) in [("x11", "scrot"), ("macos", "peekaboo")] {
            let f = Fixture::new();
            capture_fixture(&f, helper, bytes);
            let path = f.root.join("capture.png");
            fs::write(&path, "old-image").unwrap();
            let result = f.run(json!({"platform":platform,"args":["screenshot","--mode","screen","--format",format,"--path",path]}));
            assert_eq!(result["ok"], false, "{format} {platform}: {result}");
            assert!(result.get("observationV1").is_none());
            assert_eq!(fs::read(path).unwrap(), b"old-image");
            assert!(!result.to_string().contains("unrelated"));
        }
    }
}

#[test]
fn cancelled_capture_keeps_previous_destination_and_cleans_staging() {
    for (platform, helper) in [("x11", "scrot"), ("macos", "peekaboo")] {
        let f = Fixture::new();
        fs::write(
            f.root.join("input-image"),
            include_bytes!("../contracts/v1/fixtures/images/valid.png"),
        )
        .unwrap();
        f.tool(helper, r#"printf '%s\n' "$@" >> "$FIXTURE_LOG"
previous=; for arg in "$@"; do if [ "$previous" = --path ]; then target="$arg"; fi; previous="$arg"; done
if [ -z "$target" ]; then for arg in "$@"; do target="$arg"; done; fi
/bin/cp "$FIXTURE_IMAGE" "$target"
/bin/sleep 5
printf '{"success":true}'"#);
        let path = f.root.join("capture.png");
        fs::write(&path, "old-image").unwrap();
        let result = f.run(json!({"platform":platform,"args":["screenshot","--mode","screen","--path",path],"cancelAfterMs":50}));
        assert_eq!(result["code"], "CANCELLED");
        assert!(result.get("observationV1").is_none());
        assert_eq!(fs::read(path).unwrap(), b"old-image");
        assert!(!fs::read_dir(&f.root).unwrap().any(|e| e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".desktopuse-capture-")));
    }
}

#[test]
fn capture_bounds_and_unsafe_files_fail_before_publish() {
    use std::os::unix::fs::symlink;
    let png = include_bytes!("../contracts/v1/fixtures/images/valid.png");
    for kind in [
        "encoded-limit",
        "dimension-limit",
        "pixel-limit",
        "symlink",
        "fifo",
        "directory",
    ] {
        let f = Fixture::new();
        let mut bytes = png.to_vec();
        if kind == "encoded-limit" {
            bytes.resize(8 * 1024 * 1024 + 1, 0);
        }
        if kind == "dimension-limit" {
            bytes[16..20].copy_from_slice(&16385u32.to_be_bytes());
        }
        if kind == "pixel-limit" {
            bytes[16..20].copy_from_slice(&8192u32.to_be_bytes());
            bytes[20..24].copy_from_slice(&8192u32.to_be_bytes());
        }
        capture_fixture(&f, "scrot", &bytes);
        if kind == "symlink" {
            symlink(f.root.join("input-image"), f.root.join("image-link")).unwrap();
            f.tool(
                "scrot",
                r#"for arg in "$@"; do target="$arg"; done; /bin/ln -s "$FIXTURE_IMAGE" "$target""#,
            );
        }
        if kind == "fifo" {
            f.tool(
                "scrot",
                r#"for arg in "$@"; do target="$arg"; done; /usr/bin/mkfifo "$target""#,
            );
        }
        if kind == "directory" {
            f.tool(
                "scrot",
                r#"for arg in "$@"; do target="$arg"; done; /bin/mkdir "$target""#,
            );
        }
        let path = f.root.join("capture.png");
        let result = f.run(json!({"platform":"x11","args":["screenshot","--path",path]}));
        assert_eq!(result["ok"], false, "{kind}: {result}");
        assert_eq!(
            result["code"],
            if kind.ends_with("limit") {
                "IMAGE_LIMIT"
            } else {
                "CAPTURE_MISSING"
            },
            "{kind}: {result}"
        );
        assert!(!path.exists());
    }
}

#[test]
fn replacing_owned_path_preserves_option_like_target_values() {
    let args = vec![
        "--app".into(),
        "--path".into(),
        "--path".into(),
        "destination".into(),
    ];
    assert_eq!(strip_option(&args, "--path"), vec!["--app", "--path"]);
}

#[test]
fn macos_inspect_reports_unknown_annotation_and_scope_without_substituting_paths() {
    for no_annotate in [false, true] {
        let f = Fixture::new();
        capture_fixture(
            &f,
            "peekaboo",
            include_bytes!("../contracts/v1/fixtures/images/valid.png"),
        );
        let path = f.root.join("inspect.png");
        let mut args = vec![
            "inspect".into(),
            "--path".into(),
            path.to_string_lossy().into_owned(),
        ];
        if no_annotate {
            args.push("--no-annotate".into());
        }
        let result = f.run(json!({"platform":"macos","args":args}));
        assert_eq!(result["ok"], true, "{result}");
        let receipt = &result["observationV1"];
        assert_eq!(receipt["requestedScope"]["mode"], "auto");
        assert_eq!(
            receipt["actualScope"],
            json!({"state":"unavailable","reasonCode":"PROVIDER_SCOPE_UNVERIFIED"})
        );
        assert_eq!(
            receipt["primaryImage"]["annotationKind"],
            if no_annotate { "raw" } else { "unverified" }
        );
        assert_eq!(
            receipt["requestedScope"]["annotationRequested"],
            !no_annotate
        );
        assert_eq!(result["path"], path.to_string_lossy().as_ref());
    }
}

#[test]
fn macos_stale_destination_and_helper_json_path_are_not_capture_evidence() {
    let f = Fixture::new();
    f.tool(
        "peekaboo",
        r#"printf '{"success":true,"data":{"path":"/unrelated/private.png"}}'"#,
    );
    let path = f.root.join("old.png");
    fs::write(
        &path,
        include_bytes!("../contracts/v1/fixtures/images/valid.png"),
    )
    .unwrap();
    let before = fs::read(&path).unwrap();
    let result = f.run(json!({"platform":"macos","args":["screenshot","--path",path]}));
    assert_eq!(result["code"], "CAPTURE_MISSING");
    assert!(result.get("observationV1").is_none());
    assert_eq!(fs::read(path).unwrap(), before);
    assert!(!result.to_string().contains("unrelated"));
}

#[test]
fn undeclared_capture_modes_never_invoke_or_broaden_a_helper() {
    for (platform, helper) in [("macos", "peekaboo"), ("x11", "scrot"), ("wayland", "grim")] {
        let f = Fixture::new();
        capture_fixture(
            &f,
            helper,
            include_bytes!("../contracts/v1/fixtures/images/valid.png"),
        );
        let path = f.root.join("capture.png");
        let result = f.run(json!({"platform":platform,"args":["screenshot","--mode","unknown-mode","--path",path]}));
        assert_eq!(result["ok"], false, "{result}");
        assert_eq!(result["supported"], false);
        assert!(f.log().is_empty());
        assert!(!path.exists());
    }
}

#[test]
fn x11_coordinates_cannot_wrap_or_silently_clip_to_a_root_edge() {
    for coords in ["-1920,-80", "32768,80", "1600,80"] {
        let f = Fixture::new();
        f.tool("xdotool", r#"if [ "$1" = getdisplaygeometry ]; then printf '1600 900'; else printf input > "$FIXTURE_LOG"; fi"#);
        let result =
            f.run(json!({"platform":"x11","args":["click","--coords",coords,"--confirm"]}));
        assert_eq!(result["ok"], false);
        assert_eq!(result["code"], "COORDINATES_OUT_OF_RANGE");
        assert!(f.log().is_empty());
    }
}

#[test]
fn wayland_pointer_without_versioned_geometry_never_sends_input() {
    let f = Fixture::new();
    f.tool("ydotool", "printf input > \"$FIXTURE_LOG\"");
    let result =
        f.run(json!({"platform":"wayland","args":["click","--coords","-720,60","--confirm"]}));
    assert_eq!(result["ok"], false);
    assert_eq!(result["code"], "POINTER_MAPPING_UNVERIFIED");
    assert!(f.log().is_empty());
}

// Removing the exact owned-primary rebind must leave these paths pointing at deleted staging.
#[test]
fn macos_primary_artifact_paths_follow_committed_capture_without_relabeling_other_files() {
    for shape in ["raw", "files", "unrelated", "multiple", "missing", "scalar"] {
        let f = Fixture::new();
        f.tool("peekaboo", &format!(r#"previous=; for arg in "$@"; do if [ "$previous" = --path ]; then target="$arg"; fi; previous="$arg"; done
/bin/cp "$FIXTURE_IMAGE" "$target"
case {} in
raw) printf '{{"success":true,"data":{{"screenshot_raw":"%s","screenshot_annotated":"%s","ui_map":"%s","analysis":{{"text":"%s"}}}}}}' "$target" "$target" "$target" "$target";;
files) printf '{{"success":true,"data":{{"files":[{{"path":"%s","item_label":"Display 1 (Index 0)","mime_type":"image/png"}}],"observations":[],"snapshot_id":"fixture"}}}}' "$target";;
unrelated) printf '{{"success":true,"data":{{"screenshot_raw":"/untrusted/raw.png","files":[{{"path":"/untrusted/other.png"}}]}}}}';;
multiple) printf '{{"success":true,"data":{{"files":[{{"path":"%s"}},{{"path":"/untrusted/second.png"}}]}}}}' "$target";;
missing) printf '{{"success":true}}';;
scalar) printf '{{"success":true,"data":"unrelated data"}}';;
esac"#, shape));
        let path = f.root.join("published.png");
        let result =
            f.run(json!({"platform":"macos","args":["inspect","--mode","screen","--path",path]}));
        assert_eq!(result["ok"], true, "{result}");
        assert_eq!(result["path"], path.to_string_lossy().as_ref());
        assert_eq!(
            fs::read(&path).unwrap(),
            include_bytes!("../contracts/v1/fixtures/images/valid.png")
        );
        let data = &result["result"]["data"];
        match shape {
            "raw" => {
                assert_eq!(data["screenshot_raw"], path.to_string_lossy().as_ref());
                assert_eq!(data["screenshot_annotated"], data["ui_map"]);
                assert_eq!(data["ui_map"], data["analysis"]["text"]);
                assert_ne!(data["screenshot_annotated"], data["screenshot_raw"]);
                assert!(!Path::new(data["screenshot_annotated"].as_str().unwrap()).exists());
            }
            "files" => {
                assert_eq!(data["files"][0]["path"], path.to_string_lossy().as_ref());
                assert_eq!(data["files"][0]["item_label"], "Display 1 (Index 0)");
            }
            "unrelated" => {
                assert_eq!(data["screenshot_raw"], "/untrusted/raw.png");
                assert_eq!(data["files"][0]["path"], "/untrusted/other.png");
            }
            "multiple" => {
                assert_ne!(data["files"][0]["path"], path.to_string_lossy().as_ref());
                assert_eq!(data["files"][1]["path"], "/untrusted/second.png");
            }
            "missing" => assert!(result["result"].get("data").is_none()),
            "scalar" => assert_eq!(data, "unrelated data"),
            _ => unreachable!(),
        }
    }
}
