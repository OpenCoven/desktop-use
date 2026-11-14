use super::helper::Helper;
use super::xlib::Context;
use std::os::fd::RawFd;
use std::os::unix::process::CommandExt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

const CLEANUP: Duration = Duration::from_millis(100);
const REAP: Duration = Duration::from_millis(40);
// Distinct from every one-byte acknowledgement, including an ACK that arrives
// just after cancellation interrupted its original read.
const REPORT: u8 = 0xd1;
static PARENT_GONE: AtomicBool = AtomicBool::new(false);

extern "C" fn parent_died(_: libc::c_int) {
    // Linux-only raw syscalls and stack data: safe while an Xlib call is
    // blocked. Never extend an already shorter cleanup watchdog.
    unsafe {
        PARENT_GONE.store(true, Ordering::Relaxed);
        let errno = *libc::__errno_location();
        let mut current: libc::itimerval = std::mem::zeroed();
        let read = libc::syscall(libc::SYS_getitimer, libc::ITIMER_REAL, &mut current);
        if read != 0
            || current.it_value.tv_sec > 0
            || current.it_value.tv_usec == 0
            || current.it_value.tv_usec > 100_000
        {
            let watchdog = libc::itimerval {
                it_interval: libc::timeval {
                    tv_sec: 0,
                    tv_usec: 0,
                },
                it_value: libc::timeval {
                    tv_sec: 0,
                    tv_usec: 100_000,
                },
            };
            libc::syscall(
                libc::SYS_setitimer,
                libc::ITIMER_REAL,
                &watchdog,
                std::ptr::null_mut::<libc::itimerval>(),
            );
        }
        *libc::__errno_location() = errno;
    }
}

pub(super) struct PrivateChild {
    pid: libc::pid_t,
    command: RawFd,
    reply: RawFd,
    settled: bool,
    cleanup_allowed: bool,
}

struct ParentSignalMask(libc::sigset_t);
impl ParentSignalMask {
    fn block() -> Self {
        unsafe {
            let mut mask: libc::sigset_t = std::mem::zeroed();
            let mut previous: libc::sigset_t = std::mem::zeroed();
            libc::sigemptyset(&mut mask);
            libc::sigaddset(&mut mask, libc::SIGUSR1);
            if libc::sigprocmask(libc::SIG_BLOCK, &mask, &mut previous) != 0 {
                libc::_exit(1);
            }
            Self(previous)
        }
    }
}
impl Drop for ParentSignalMask {
    fn drop(&mut self) {
        unsafe {
            libc::sigprocmask(libc::SIG_SETMASK, &self.0, std::ptr::null_mut());
        }
    }
}
fn timer(mut duration: Duration) {
    // A parent-death handler must not cap the timer between this decision and
    // a later normal timer write which would accidentally extend that cap.
    let _mask = ParentSignalMask::block();
    if PARENT_GONE.load(Ordering::Relaxed) {
        let mut current: libc::itimerval = unsafe { std::mem::zeroed() };
        if unsafe { libc::getitimer(libc::ITIMER_REAL, &mut current) } == 0 {
            let left = Duration::from_secs(current.it_value.tv_sec as u64)
                + Duration::from_micros(current.it_value.tv_usec as u64);
            if left.is_zero() {
                return;
            }
            duration = duration.min(left);
        }
        duration = duration.min(CLEANUP);
    }
    let timer = libc::itimerval {
        it_interval: libc::timeval {
            tv_sec: 0,
            tv_usec: 0,
        },
        it_value: libc::timeval {
            tv_sec: duration.as_secs() as _,
            tv_usec: duration.subsec_micros().max(1) as _,
        },
    };
    unsafe {
        libc::setitimer(libc::ITIMER_REAL, &timer, std::ptr::null_mut());
    }
}
fn read_exact(fd: RawFd, data: &mut [u8]) -> bool {
    let mut used = 0;
    while used < data.len() {
        let size = unsafe { libc::read(fd, data[used..].as_mut_ptr().cast(), data.len() - used) };
        if size > 0 {
            used += size as usize;
        } else if size < 0
            && std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted
        {
            continue;
        } else {
            return false;
        }
    }
    true
}
fn write_child(fd: RawFd, data: &[u8]) -> bool {
    let mut used = 0;
    while used < data.len() {
        let size = unsafe { libc::write(fd, data[used..].as_ptr().cast(), data.len() - used) };
        if size > 0 {
            used += size as usize;
        } else if size < 0
            && std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted
        {
            continue;
        } else {
            return false;
        }
    }
    true
}
fn write_report(fd: RawFd, mut report: [u8; 8]) -> bool {
    report[0] = REPORT;
    write_child(fd, &report)
}
fn wait_pipe(fd: RawFd, events: libc::c_short) {
    let mut ready = libc::pollfd {
        fd,
        events,
        revents: 0,
    };
    unsafe {
        libc::poll(&mut ready, 1, 1);
    }
}
unsafe fn child(command: RawFd, reply: RawFd, lifetime: Duration, owner: libc::pid_t) -> ! {
    libc::setpgid(0, 0);
    libc::prctl(libc::PR_SET_NAME, c"coven-x11-guard".as_ptr(), 0, 0, 0);
    libc::signal(libc::SIGTERM, libc::SIG_DFL);
    libc::signal(libc::SIGINT, libc::SIG_DFL);
    libc::signal(libc::SIGALRM, libc::SIG_DFL);
    libc::signal(libc::SIGPIPE, libc::SIG_IGN);
    libc::signal(
        libc::SIGUSR1,
        parent_died as *const () as libc::sighandler_t,
    );
    let mut wake: libc::sigset_t = std::mem::zeroed();
    libc::sigemptyset(&mut wake);
    libc::sigaddset(&mut wake, libc::SIGUSR1);
    if libc::sigprocmask(libc::SIG_UNBLOCK, &wake, std::ptr::null_mut()) != 0 {
        libc::_exit(1);
    }
    if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGUSR1, 0, 0, 0) != 0 || libc::getppid() != owner
    {
        libc::_exit(1);
    }
    let no_core = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    libc::setrlimit(libc::RLIMIT_CORE, &no_core);
    libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0);
    let null = libc::open(c"/dev/null".as_ptr(), libc::O_RDWR | libc::O_CLOEXEC);
    if null < 0 {
        libc::_exit(1);
    }
    for fd in 0..=2 {
        libc::dup2(null, fd);
    }
    if null > 2 {
        libc::close(null);
    }
    let lifetime_end = Instant::now() + lifetime;
    timer(lifetime);
    if !Helper::supported() {
        write_child(reply, b"U");
        libc::_exit(0);
    }
    let Some(mut context) = Context::open() else {
        write_child(reply, b"U");
        libc::_exit(0);
    };
    if !write_child(reply, b"R") {
        libc::_exit(0);
    }
    let mut helper: Option<Helper> = None;
    loop {
        let mut kind = [0u8; 1];
        if !read_exact(command, &mut kind) {
            break;
        }
        match kind[0] {
            b'H' => {
                let mut bytes = [0; 4];
                if !read_exact(command, &mut bytes) {
                    break;
                }
                let pid = u32::from_le_bytes(bytes) as i32;
                let prepared = if helper.as_ref().is_none_or(Helper::exited) {
                    Helper::bind(pid, owner)
                } else {
                    None
                };
                let ack = if let Some(prepared) = prepared {
                    helper = Some(prepared);
                    b'A'
                } else {
                    b'U'
                };
                if !write_child(reply, &[ack]) {
                    break;
                }
            }
            b'W' => {
                let mut bytes = [0; 4];
                if !read_exact(command, &mut bytes) {
                    break;
                }
                let held = helper.as_mut().is_some_and(|helper| {
                    helper.hold_input(owner, u32::from_le_bytes(bytes) as i32)
                });
                if !write_child(reply, &[if held { b'A' } else { b'U' }]) {
                    break;
                }
            }
            b'D' => {
                if let Some(helper) = &mut helper {
                    helper.release_input();
                }
                if !write_child(reply, b"A") {
                    break;
                }
            }
            b'O' => {
                let mut clear = [0];
                if !read_exact(command, &mut clear) {
                    break;
                }
                let ack = match context.begin_logical(clear[0] != 0) {
                    Some(false) => b'A',
                    Some(true) => b'B',
                    None => b'U',
                };
                if !write_child(reply, &[ack]) {
                    break;
                }
            }
            b'E' => {
                timer(CLEANUP);
                let stopped = helper
                    .as_mut()
                    .is_none_or(|helper| helper.quiesce(Instant::now() + CLEANUP));
                let report = if stopped {
                    context.end_logical()
                } else {
                    [1, 2, 0, 0, 0, 0, 0, 0]
                };
                if !write_report(reply, report) {
                    break;
                }
                let remaining = lifetime_end.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    break;
                }
                timer(remaining);
            }
            b'T' => {
                let mut data = [0u8; 5];
                if !read_exact(command, &mut data) {
                    break;
                }
                context.activate_text(
                    u32::from_le_bytes(data[1..5].try_into().unwrap()),
                    data[0] != 0,
                );
                if !write_child(reply, b"A") {
                    break;
                }
            }
            b'K' => {
                let mut header = [0u8; 3];
                if !read_exact(command, &mut header) {
                    break;
                }
                let size = u16::from_le_bytes([header[1], header[2]]) as usize;
                if size > 4096 {
                    break;
                }
                let mut data = vec![0u8; size];
                if !read_exact(command, &mut data) {
                    break;
                }
                let Ok(value) = std::str::from_utf8(&data) else {
                    break;
                };
                context.activate_keys(value, header[0] != 0);
                if !write_child(reply, b"A") {
                    break;
                }
            }
            b'C' => context.complete_unit(),
            b'Z' => context.not_started(),
            b'F' | b'S' => break,
            _ => break,
        }
    }
    timer(CLEANUP);
    let stopped = helper
        .as_mut()
        .is_none_or(|helper| helper.quiesce(Instant::now() + CLEANUP));
    let report = if stopped {
        context.end_logical()
    } else {
        [1, 2, 0, 0, 0, 0, 0, 0]
    };
    drop(context);
    write_report(reply, report);
    libc::_exit(0);
}

impl PrivateChild {
    pub(super) fn start(deadline: Instant) -> Option<Self> {
        if crate::process::check(deadline).is_err() {
            return None;
        }
        let mut command = [0; 2];
        let mut reply = [0; 2];
        unsafe {
            let owner = libc::getpid();
            if libc::pipe2(command.as_mut_ptr(), libc::O_CLOEXEC) != 0 {
                return None;
            }
            if libc::pipe2(reply.as_mut_ptr(), libc::O_CLOEXEC) != 0 {
                libc::close(command[0]);
                libc::close(command[1]);
                return None;
            }
            let pid = libc::fork();
            if pid == 0 {
                libc::close(command[1]);
                libc::close(reply[0]);
                // The production CLI is single-threaded at this boundary. No
                // host runtime is forked; only the standalone Rust adapter.
                child(
                    command[0],
                    reply[1],
                    deadline.saturating_duration_since(Instant::now()) + Duration::from_millis(200),
                    owner,
                );
            }
            libc::close(command[0]);
            libc::close(reply[1]);
            if pid < 0 {
                libc::close(command[1]);
                libc::close(reply[0]);
                return None;
            }
            libc::setpgid(pid, pid);
            let mut result = Self {
                pid,
                command: command[1],
                reply: reply[0],
                settled: false,
                cleanup_allowed: false,
            };
            for fd in [command[1], reply[0]] {
                let flags = libc::fcntl(fd, libc::F_GETFL);
                if flags < 0 || libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) < 0 {
                    result.terminate();
                    return None;
                }
            }
            let mut ready = [0u8; 1];
            if result.read(
                &mut ready,
                deadline.min(Instant::now() + Duration::from_secs(1)),
                true,
            ) && ready == *b"R"
            {
                result.cleanup_allowed = true;
                Some(result)
            } else {
                result.terminate();
                None
            }
        }
    }
    fn send(&mut self, data: &[u8], deadline: Instant, honour_cancel: bool) -> bool {
        let mut used = 0;
        while used < data.len() && Instant::now() < deadline {
            if honour_cancel && crate::process::check(deadline).is_err() {
                return false;
            }
            let size = unsafe {
                libc::write(
                    self.command,
                    data[used..].as_ptr().cast(),
                    data.len() - used,
                )
            };
            if size > 0 {
                used += size as usize;
            } else if size < 0
                && matches!(
                    std::io::Error::last_os_error().kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                )
            {
                wait_pipe(self.command, libc::POLLOUT);
            } else {
                return false;
            }
        }
        used == data.len()
    }
    fn read(&mut self, data: &mut [u8], deadline: Instant, honour_cancel: bool) -> bool {
        let mut used = 0;
        while used < data.len() && Instant::now() < deadline {
            if honour_cancel && crate::process::check(deadline).is_err() {
                return false;
            }
            let size = unsafe {
                libc::read(
                    self.reply,
                    data[used..].as_mut_ptr().cast(),
                    data.len() - used,
                )
            };
            if size > 0 {
                used += size as usize;
            } else if size < 0
                && matches!(
                    std::io::Error::last_os_error().kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                )
            {
                wait_pipe(self.reply, libc::POLLIN);
            } else {
                return false;
            }
        }
        used == data.len()
    }
    pub(super) fn activate(&mut self, data: &[u8], deadline: Instant) -> bool {
        let mut ack = [0u8; 1];
        self.send(data, deadline, true) && self.read(&mut ack, deadline, true) && ack == *b"A"
    }
    pub(super) fn attach(&self, command: &mut std::process::Command, deadline: Instant) {
        let (write_fd, read_fd) = (self.command, self.reply);
        let owner = unsafe { libc::getpid() };
        let end = deadline.min(Instant::now() + CLEANUP);
        unsafe {
            command.pre_exec(move || {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::getppid() != owner {
                    libc::_exit(125);
                }
                let mut frame = [b'H', 0, 0, 0, 0];
                frame[1..].copy_from_slice(&(libc::getpid() as u32).to_le_bytes());
                let mut written = 0;
                while written < frame.len() && Instant::now() < end {
                    let size = libc::write(
                        write_fd,
                        frame[written..].as_ptr().cast(),
                        frame.len() - written,
                    );
                    if size > 0 {
                        written += size as usize;
                    } else if size < 0
                        && matches!(
                            std::io::Error::last_os_error().kind(),
                            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                        )
                    {
                        wait_pipe(write_fd, libc::POLLOUT);
                    } else {
                        return Err(std::io::Error::from_raw_os_error(libc::EPIPE));
                    }
                }
                let mut ack = [0];
                while written == frame.len() && Instant::now() < end {
                    let size = libc::read(read_fd, ack.as_mut_ptr().cast(), 1);
                    if size == 1 {
                        return if ack == *b"A" {
                            Ok(())
                        } else {
                            Err(std::io::Error::from_raw_os_error(libc::EIO))
                        };
                    }
                    if size == 0 {
                        break;
                    }
                    if !matches!(
                        std::io::Error::last_os_error().kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                    ) {
                        break;
                    }
                    wait_pipe(read_fd, libc::POLLIN);
                }
                Err(std::io::Error::from_raw_os_error(libc::ETIMEDOUT))
            });
        }
    }
    pub(super) fn hold_input(&mut self, fd: i32, deadline: Instant) -> bool {
        let mut frame = vec![b'W'];
        frame.extend_from_slice(&(fd as u32).to_le_bytes());
        self.activate(&frame, deadline)
    }
    pub(super) fn release_input(&mut self, deadline: Instant) -> bool {
        self.activate(b"D", deadline)
    }
    pub(super) fn begin_logical(&mut self, clear: bool, deadline: Instant) -> Option<bool> {
        let mut ack = [0];
        if !self.send(&[b'O', u8::from(clear)], deadline, true)
            || !self.read(&mut ack, deadline, true)
        {
            return None;
        }
        match ack[0] {
            b'A' => Some(false),
            b'B' => Some(true),
            _ => None,
        }
    }
    fn read_report(&mut self, deadline: Instant) -> Option<[u8; 8]> {
        // At most one pending command acknowledgement precedes the report. A
        // bounded scan also handles readiness on a failed startup path.
        for _ in 0..4 {
            let mut head = [0];
            if !self.read(&mut head, deadline, false) {
                return None;
            }
            if head[0] == REPORT {
                let mut report = [1, 0, 0, 0, 0, 0, 0, 0];
                return self
                    .read(&mut report[1..], deadline, false)
                    .then_some(report);
            }
            if !b"ABRU".contains(&head[0]) {
                return None;
            }
        }
        None
    }
    pub(super) fn end_logical(&mut self) -> serde_json::Value {
        let end = Instant::now() + CLEANUP;
        let report = if self.send(b"E", end, false) {
            self.read_report(end)
        } else {
            None
        };
        report.map(project_report).unwrap_or_else(timeout_report)
    }
    pub(super) fn notify(&mut self, kind: u8) {
        let _ = self.send(&[kind], Instant::now() + Duration::from_millis(5), false);
    }
    fn reap(&mut self, deadline: Instant) -> bool {
        while Instant::now() < deadline {
            let mut status = 0;
            let result = unsafe { libc::waitpid(self.pid, &mut status, libc::WNOHANG) };
            if result == self.pid
                || result < 0
                    && std::io::Error::last_os_error().raw_os_error() == Some(libc::ECHILD)
            {
                self.settled = true;
                return true;
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        false
    }
    fn terminate(&mut self) -> bool {
        unsafe {
            libc::kill(-self.pid, libc::SIGKILL);
        }
        self.reap(Instant::now() + REAP)
    }
    pub(super) fn finish(&mut self, failed: bool) -> serde_json::Value {
        self.cleanup_allowed = false;
        let end = Instant::now() + CLEANUP;
        let report = if self.send(&[if failed { b'F' } else { b'S' }], end, false) {
            self.read_report(end)
        } else {
            None
        };
        let reaped = if self.reap(end) {
            true
        } else {
            self.terminate()
        };
        if !reaped {
            return timeout_report();
        }
        report.map(project_report).unwrap_or_else(timeout_report)
    }
}
fn timeout_report() -> serde_json::Value {
    serde_json::json!({"schemaVersion":1,"state":"unverified","reasonCode":"X11_GUARD_TIMEOUT"})
}
fn project_report(report: [u8; 8]) -> serde_json::Value {
    if report[0] != 1 || ![1, 2, 3].contains(&report[1]) {
        return serde_json::json!({"schemaVersion":1,"state":"unverified","reasonCode":"X11_CLEANUP_FAILED"});
    }
    if report[1] == 3 {
        return serde_json::json!({"schemaVersion":1,"state":"not-needed"});
    }
    let mut value = serde_json::json!({"schemaVersion":1,"state":if report[1]==1 {"verified"} else {"unverified"},"releasedKeys":report[2],"restoredKeys":report[3],"restoredButtons":report[4],"restoredLock":report[5]!=0,"restoredGroup":report[6]!=0,"restoredMappings":report[7]});
    if report[1] == 2 {
        value["reasonCode"] = serde_json::json!("X11_STATE_CHANGED");
    }
    value
}
impl Drop for PrivateChild {
    fn drop(&mut self) {
        if !self.settled {
            if self.cleanup_allowed {
                let _ = self.finish(true);
            } else {
                self.terminate();
            }
        }
        unsafe {
            libc::close(self.command);
            libc::close(self.reply);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Exercise actual owned IPC and waitpid without requiring an X server.
    unsafe fn synthetic_child(block_cleanup: bool) -> PrivateChild {
        let (mut command, mut reply) = ([0; 2], [0; 2]);
        assert_eq!(libc::pipe2(command.as_mut_ptr(), libc::O_CLOEXEC), 0);
        assert_eq!(libc::pipe2(reply.as_mut_ptr(), libc::O_CLOEXEC), 0);
        let pid = libc::fork();
        assert!(pid >= 0);
        if pid == 0 {
            libc::close(command[1]);
            libc::close(reply[0]);
            libc::setpgid(0, 0);
            libc::signal(libc::SIGALRM, libc::SIG_DFL);
            timer(Duration::from_secs(2));
            write_child(reply[1], b"A"); // Activation ACK not consumed before cancellation.
            let mut kind = [0];
            read_exact(command[0], &mut kind);
            if block_cleanup {
                loop {
                    libc::pause();
                }
            }
            write_child(reply[1], &[0xd1, 1, 1, 0, 0, 0, 0, 0]);
            libc::_exit(0);
        }
        libc::setpgid(pid, pid);
        libc::close(command[0]);
        libc::close(reply[1]);
        for fd in [command[1], reply[0]] {
            let flags = libc::fcntl(fd, libc::F_GETFL);
            assert_eq!(libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK), 0);
        }
        PrivateChild {
            pid,
            command: command[1],
            reply: reply[0],
            settled: false,
            cleanup_allowed: true,
        }
    }

    #[test]
    fn pending_activation_ack_does_not_shift_cleanup_report() {
        let mut child = unsafe { synthetic_child(false) };
        let report = child.finish(true);
        assert!(child.settled);
        assert_eq!(report["state"], "verified");
        assert_eq!(report["releasedKeys"], 1);
    }

    #[test]
    fn blocked_cleanup_is_bounded_and_owned_child_is_reaped() {
        let mut child = unsafe { synthetic_child(true) };
        let start = Instant::now();
        let report = child.finish(true);
        assert!(start.elapsed() < Duration::from_secs(1));
        assert_eq!(report["state"], "unverified");
        assert!(child.settled);
        let mut status = 0;
        assert_eq!(
            unsafe { libc::waitpid(child.pid, &mut status, libc::WNOHANG) },
            -1
        );
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ECHILD)
        );
    }
}
