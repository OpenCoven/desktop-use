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
