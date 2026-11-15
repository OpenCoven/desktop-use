//! Stable process identity and retained stdin owned by the surviving guard.
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::fs::MetadataExt;
use std::time::Instant;

pub(super) struct Helper {
    pid: libc::pid_t,
    identity: OwnedFd,
    held_input: Option<OwnedFd>,
}

impl Drop for Helper {
    fn drop(&mut self) {
        let _ = self.quiesce(Instant::now() + std::time::Duration::from_millis(100));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::process::{Command, Stdio};
    use std::time::Duration;

    #[test]
    fn retained_writer_prevents_eof_execution_until_identity_bound_helper_is_dead() {
        assert!(Helper::supported());
        let mut child = Command::new("/bin/sh")
            .args(["-c", "IFS= read -r value; printf executed"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let pid = child.id();
        let mut input = child.stdin.take().unwrap();
        let mut output = child.stdout.take().unwrap();
        let mut helper = Helper::bind(pid as i32, unsafe { libc::getpid() }).unwrap();
        assert!(helper.hold_input(unsafe { libc::getpid() }, input.as_raw_fd()));
        input.write_all(b"partial-frame-without-newline").unwrap();
        drop(input); // Simulate the owner's descriptors closing on death.
        let flags = unsafe { libc::fcntl(output.as_raw_fd(), libc::F_GETFL) };
        unsafe {
            libc::fcntl(output.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK);
        }
        std::thread::sleep(Duration::from_millis(10));
        let mut byte = [0];
        assert!(output
            .read(&mut byte)
            .is_err_and(|error| error.kind() == std::io::ErrorKind::WouldBlock));
        assert!(helper.quiesce(Instant::now() + Duration::from_millis(100)));
        assert!(!child.wait().unwrap().success());
        assert_eq!(output.read(&mut byte).unwrap(), 0);
    }

    #[test]
    fn registration_rejects_a_process_outside_the_owner_child_relationship() {
        assert!(Helper::bind(1, unsafe { libc::getpid() }).is_none());
        assert!(Helper::bind(unsafe { libc::getpid() }, unsafe { libc::getpid() }).is_none());
    }
}
impl Helper {
    pub(super) fn supported() -> bool {
        unsafe {
            let fd = libc::syscall(libc::SYS_pidfd_open, libc::getpid(), 0) as i32;
            if fd < 0 {
                return false;
            }
            let result = libc::syscall(
                libc::SYS_pidfd_send_signal,
                fd,
                0,
                std::ptr::null::<libc::siginfo_t>(),
                0,
            );
            libc::close(fd);
            result == 0
        }
    }
    pub(super) fn bind(pid: libc::pid_t, owner: libc::pid_t) -> Option<Self> {
        if pid <= 1 || pid == owner {
            return None;
        }
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        let parent: i32 = stat
            .rsplit_once(')')?
            .1
            .split_whitespace()
            .nth(1)?
            .parse()
            .ok()?;
        if parent != owner {
            return None;
        }
        // The owner cannot reap/reuse this PID while waiting for our ACK.
        let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) } as i32;
        if fd < 0 {
            return None;
        }
        Some(Self {
            pid,
            identity: unsafe { OwnedFd::from_raw_fd(fd) },
            held_input: None,
        })
    }
    pub(super) fn exited(&self) -> bool {
        let mut event = libc::pollfd {
            fd: self.identity.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        unsafe { libc::poll(&mut event, 1, 0) > 0 && event.revents & libc::POLLIN != 0 }
    }
    pub(super) fn hold_input(&mut self, owner: libc::pid_t, fd: i32) -> bool {
        if self.exited() || self.held_input.is_some() || fd < 0 {
            return false;
        }
        let parent_path = format!("/proc/{owner}/fd/{fd}");
        let helper_path = format!("/proc/{}/fd/0", self.pid);
        let (Ok(parent), Ok(helper)) = (
            std::fs::metadata(&parent_path),
            std::fs::metadata(helper_path),
        ) else {
            return false;
        };
        if parent.mode() & libc::S_IFMT != libc::S_IFIFO
            || parent.dev() != helper.dev()
            || parent.ino() != helper.ino()
        {
            return false;
        }
        let Ok(path) = std::ffi::CString::new(parent_path) else {
            return false;
        };
        let duplicate = unsafe {
            libc::open(
                path.as_ptr(),
                libc::O_WRONLY | libc::O_NONBLOCK | libc::O_CLOEXEC,
            )
        };
        if duplicate < 0 {
            return false;
        }
        let held = unsafe { OwnedFd::from_raw_fd(duplicate) };
        let mut actual: libc::stat = unsafe { std::mem::zeroed() };
        if unsafe { libc::fstat(held.as_raw_fd(), &mut actual) } != 0
            || actual.st_dev != parent.dev()
            || actual.st_ino != parent.ino()
        {
            return false;
        }
        self.held_input = Some(held);
        true
    }
    pub(super) fn release_input(&mut self) {
        self.held_input.take();
    }
    pub(super) fn quiesce(&mut self, deadline: Instant) -> bool {
        if !self.exited() {
            // pidfd targets this process identity even if its numeric PID is reused.
            unsafe {
                libc::syscall(
                    libc::SYS_pidfd_send_signal,
                    self.identity.as_raw_fd(),
                    libc::SIGKILL,
                    std::ptr::null::<libc::siginfo_t>(),
                    0,
                );
            }
        }
        while !self.exited() && Instant::now() < deadline {
            let mut event = libc::pollfd {
                fd: self.identity.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            unsafe {
                libc::poll(&mut event, 1, 1);
            }
        }
        if !self.exited() {
            return false;
        }
        // Retaining this writer until after exit prevents a partial frame from
        // executing when the dead parent closes its copy of the pipe.
        self.release_input();
        true
    }
}
