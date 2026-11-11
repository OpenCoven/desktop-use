use std::process::{Command, Output};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

static CANCELLED: AtomicBool = AtomicBool::new(false);

#[derive(Debug)]
pub enum Failure {
    Io(std::io::ErrorKind),
    Timeout,
    Cancelled,
    OutputLimit,
}
impl Failure {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Io(std::io::ErrorKind::NotFound) => "ENOENT",
            Self::Io(std::io::ErrorKind::PermissionDenied) => "EACCES",
            Self::Io(_) => "PROCESS_ERROR",
            Self::Timeout => "ETIMEDOUT",
            Self::Cancelled => "CANCELLED",
            Self::OutputLimit => "OUTPUT_LIMIT",
        }
    }
}

#[cfg(unix)]
extern "C" fn cancel(_: libc::c_int) {
    CANCELLED.store(true, Ordering::Relaxed);
}

pub fn install_cancellation() {
    #[cfg(unix)]
    unsafe {
        // Signal handler does only a lock-free atomic store. Cleanup runs in the polling loop.
        libc::signal(libc::SIGTERM, cancel as *const () as libc::sighandler_t);
        libc::signal(libc::SIGINT, cancel as *const () as libc::sighandler_t);
    }
}

#[cfg(unix)]
pub fn run(command: &mut Command, deadline: Instant) -> Result<Output, Failure> {
    use std::io::Read;
    use std::os::fd::AsRawFd;
    use std::os::unix::process::CommandExt;
    use std::process::Stdio;
    use std::time::Duration;
    const LIMIT: usize = 1024 * 1024;
    if CANCELLED.load(Ordering::Relaxed) {
        return Err(Failure::Cancelled);
    }
    if Instant::now() >= deadline {
        return Err(Failure::Timeout);
    }
    let mut child = command
        .process_group(0)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| Failure::Io(e.kind()))?;
    // Only this child's newly allocated process group is owned by the adapter.
    let group = child.id() as i32;
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let result = (|| {
        for fd in [stdout.as_raw_fd(), stderr.as_raw_fd()] {
            let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
            if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0
            {
                return Err(Failure::Io(std::io::ErrorKind::Other));
            }
        }
        let mut out = Vec::new();
        let mut err = Vec::new();
        let mut out_done = false;
        let mut err_done = false;
        let mut status = None;
        loop {
            if CANCELLED.load(Ordering::Relaxed) {
                return Err(Failure::Cancelled);
            }
            if Instant::now() >= deadline {
                return Err(Failure::Timeout);
            }
            let mut buffer = [0; 16384];
            for (reader, bytes, done) in [
                (&mut stdout as &mut dyn Read, &mut out, &mut out_done),
                (&mut stderr as &mut dyn Read, &mut err, &mut err_done),
            ] {
                if *done {
                    continue;
                }
                match reader.read(&mut buffer) {
                    Ok(0) => *done = true,
                    Ok(n) => bytes.extend_from_slice(&buffer[..n]),
                    Err(e)
                        if e.kind() == std::io::ErrorKind::WouldBlock
                            || e.kind() == std::io::ErrorKind::Interrupted => {}
                    Err(e) => return Err(Failure::Io(e.kind())),
                }
            }
            if out.len() + err.len() > LIMIT {
                return Err(Failure::OutputLimit);
            }
            if status.is_none() {
                status = child.try_wait().map_err(|e| Failure::Io(e.kind()))?;
            }
            if let Some(status) = status {
                if out_done && err_done {
                    return Ok(Output {
                        status,
                        stdout: out,
                        stderr: err,
                    });
                }
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    })();
    unsafe {
        libc::kill(-group, libc::SIGKILL);
    }
    let _ = child.wait();
    result
}

#[cfg(not(unix))]
pub fn run(_: &mut Command, _: Instant) -> Result<Output, Failure> {
    Err(Failure::Io(std::io::ErrorKind::Unsupported))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::process::Command;
    use std::time::{Duration, Instant};

    #[test]
    fn executes_literal_argv_without_shell_interpolation() {
        let mut cmd = Command::new("/usr/bin/printf");
        cmd.args(["%s", "--literal $(false); `false` 'quoted'"]);
        let output = run(&mut cmd, Instant::now() + Duration::from_secs(1)).unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, b"--literal $(false); `false` 'quoted'");
    }

    #[test]
    fn missing_executable_has_safe_code() {
        let error = run(
            &mut Command::new("/nonexistent/desktopuse-helper"),
            Instant::now() + Duration::from_secs(1),
        )
        .unwrap_err();
        assert_eq!(error.code(), "ENOENT");
    }

    #[test]
    fn timeout_kills_term_ignoring_group_even_when_parent_exits() {
        let started = Instant::now();
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", "(trap '' TERM; sleep 5) & exit 0"]);
        let result = run(&mut cmd, started + Duration::from_millis(80));
        assert_eq!(result.unwrap_err().code(), "ETIMEDOUT");
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn nonzero_exit_is_not_process_success() {
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", "printf 'permission denied' >&2; exit 13"]);
        let output = run(&mut cmd, Instant::now() + Duration::from_secs(1)).unwrap();
        assert_eq!(output.status.code(), Some(13));
    }
}
