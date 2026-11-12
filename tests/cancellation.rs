#[cfg(unix)]
#[test]
fn cli_sigterm_cancels_and_reaps_its_active_helper() {
    use std::{
        env, fs,
        os::unix::fs::PermissionsExt,
        process::{Command, Stdio},
        thread,
        time::{Duration, Instant, SystemTime, UNIX_EPOCH},
    };
    let root = env::temp_dir().join(format!(
        "desktopuse-cli-cancel-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir(&root).unwrap();
    let script = "#!/bin/sh\ntrap '' TERM\n: > \"$FIXTURE_PID\"\n/bin/sleep 0.1\nprintf '%s' \"$$\" > \"$FIXTURE_PID\"\n/bin/sleep 10\n";
    for name in ["peekaboo", "xdotool"] {
        let file = root.join(name);
        fs::write(&file, script).unwrap();
        fs::set_permissions(file, fs::Permissions::from_mode(0o700)).unwrap();
    }
    let mut child = Command::new(env!("CARGO_BIN_EXE_coven-desktop-use"))
        .args(["type-text", "--text", "fixture", "--confirm"])
        .env("PATH", &root)
        .env("FIXTURE_PID", root.join("pid"))
        .env("XDG_SESSION_TYPE", "x11")
        .env("DISPLAY", ":fixture")
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let ready_by = Instant::now() + Duration::from_secs(2);
    // Creation is observable before the PID has been written. Wait for a
    // complete positive PID, never an empty file or a marker from an older run.
    let helper = loop {
        if let Some(pid) = fs::read_to_string(root.join("pid"))
            .ok()
            .and_then(|value| value.parse::<i32>().ok())
            .filter(|pid| *pid > 0)
        {
            break pid;
        }
        if Instant::now() >= ready_by {
            let _ = child.kill();
            let _ = child.wait();
            panic!("fixture helper did not publish its PID");
        }
        thread::sleep(Duration::from_millis(5));
    };
    unsafe {
        libc::kill(child.id() as i32, libc::SIGTERM);
    }
    let finish_by = Instant::now() + Duration::from_secs(2);
    while child.try_wait().unwrap().is_none() && Instant::now() < finish_by {
        thread::sleep(Duration::from_millis(5));
    }
    if child.try_wait().unwrap().is_none() {
        let _ = child.kill();
        panic!("CLI failed to settle after cancellation");
    }
    let result = child.wait_with_output().unwrap();
    let json: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(json["ok"], false);
    assert_eq!(json["code"], "CANCELLED");
    assert_eq!(json["cancelled"], true);
    assert_eq!(
        unsafe { libc::kill(helper, 0) },
        -1,
        "owned helper survived cancellation"
    );
    fs::remove_dir_all(root).unwrap();
}
