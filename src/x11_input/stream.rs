//! Private duplex supervision of the qualified external xdotool script mode.
//! Only generated commands enter its parser; private scalars remain argv data.
use crate::process::{check, Failure};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio};
use std::time::Instant;

const LIMIT: usize = 1024 * 1024;
const ACK: &[u8] = b"xdotool version 3.20160805.1\n";
const CHUNK: usize = 4096;

pub(super) struct TextHelper {
    child: Child,
    input: Option<ChildStdin>,
    output: ChildStdout,
    diagnostic: ChildStderr,
    indices: BTreeMap<char, usize>,
    bytes: usize,
    reaped: bool,
}

fn wait(fd: libc::c_int, events: libc::c_short) {
    let mut poll = libc::pollfd {
        fd,
        events,
        revents: 0,
    };
    unsafe {
        libc::poll(&mut poll, 1, 1);
    }
}

impl TextHelper {
    pub(super) fn start_guarded(
        helper: &Path,
        characters: &[char],
        deadline: Instant,
        guardian: &super::guard::PrivateChild,
    ) -> Result<(Self, usize), Failure> {
        Self::start_with(helper, characters, deadline, |command| {
            guardian.attach(command, deadline)
        })
    }
    pub(super) fn input_fd(&self) -> i32 {
        self.input.as_ref().unwrap().as_raw_fd()
    }
    #[cfg(test)]
    pub(super) fn start(
        helper: &Path,
        characters: &[char],
        deadline: Instant,
    ) -> Result<(Self, usize), Failure> {
        Self::start_with(helper, characters, deadline, |_| {})
    }
    fn start_with(
        helper: &Path,
        characters: &[char],
        deadline: Instant,
        mut configure: impl FnMut(&mut Command),
    ) -> Result<(Self, usize), Failure> {
        let mut length = characters.len().min(CHUNK);
        loop {
            check(deadline)?;
            let mut indices = BTreeMap::new();
            let mut operands = Vec::new();
            for value in &characters[..length] {
                if !indices.contains_key(value) {
                    operands.push(value.to_string());
                    indices.insert(*value, operands.len());
                }
            }
            let mut command = Command::new(helper);
            command
                .arg("-")
                .args(operands)
                .env_remove("DEBUG")
                .process_group(0)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            configure(&mut command);
            let spawned = command.spawn();
            let mut child = match spawned {
                Ok(child) => child,
                Err(error) if error.raw_os_error() == Some(libc::E2BIG) && length > 1 => {
                    // A failed exec has sent no input. This is argument sizing,
                    // never an input retry; preserve the original deadline.
                    length /= 2;
                    continue;
                }
                Err(error) => return Err(Failure::Io(error.kind())),
            };
            let mut result = Self {
                input: child.stdin.take(),
                output: child.stdout.take().unwrap(),
                diagnostic: child.stderr.take().unwrap(),
                child,
                indices,
                bytes: 0,
                reaped: false,
            };
            for fd in [
                result.input.as_ref().unwrap().as_raw_fd(),
                result.output.as_raw_fd(),
                result.diagnostic.as_raw_fd(),
            ] {
                let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
                if flags < 0
                    || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0
                {
                    return Err(Failure::Io(std::io::ErrorKind::Other));
                }
            }
            // Always initialize script_main's result, including an empty text.
            result.transact(b"version\n", deadline, &mut || {})?;
            return Ok((result, length));
        }
    }

    fn diagnostics(&mut self) -> Result<(), Failure> {
        let mut buffer = [0; 4096];
        match self.diagnostic.read(&mut buffer) {
            Ok(0) => Ok(()),
            Ok(size) => {
                self.bytes += size;
                if self.bytes > LIMIT {
                    Err(Failure::OutputLimit)
                } else {
                    Err(Failure::Backend)
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                ) =>
            {
                Ok(())
            }
            Err(error) => Err(Failure::Io(error.kind())),
        }
    }

    fn transact(
        &mut self,
        command: &[u8],
        deadline: Instant,
        sent: &mut dyn FnMut(),
    ) -> Result<(), Failure> {
        let mut used = 0;
        while used < command.len() {
            check(deadline)?;
            self.diagnostics()?;
            let input = self.input.as_mut().unwrap();
            match input.write(&command[used..]) {
                Ok(0) => return Err(Failure::Backend),
                Ok(size) => {
                    used += size;
                    sent();
                }
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                    ) =>
                {
                    wait(input.as_raw_fd(), libc::POLLOUT)
                }
                Err(error) => return Err(Failure::Io(error.kind())),
            }
        }
        let mut reply = Vec::new();
        loop {
            check(deadline)?;
            self.diagnostics()?;
            let mut buffer = [0; 128];
            match self.output.read(&mut buffer) {
                Ok(0) => return Err(Failure::Backend),
                Ok(size) => {
                    self.bytes += size;
                    if self.bytes > LIMIT {
                        return Err(Failure::OutputLimit);
                    }
                    reply.extend_from_slice(&buffer[..size]);
                    if reply.len() > ACK.len() || !ACK.starts_with(&reply) {
                        return Err(Failure::Backend);
                    }
                    if reply == ACK {
                        // The helper writes a synchronous error before its ACK.
                        // Re-read stderr to close the two-pipe readiness race.
                        self.diagnostics()?;
                        check(deadline)?;
                        return Ok(());
                    }
                }
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                    ) =>
                {
                    wait(self.output.as_raw_fd(), libc::POLLIN)
                }
                Err(error) => return Err(Failure::Io(error.kind())),
            }
        }
    }

    pub(super) fn text(
        &mut self,
        value: char,
        deadline: Instant,
        sent: &mut dyn FnMut(),
    ) -> Result<(), Failure> {
        let index = self.indices.get(&value).ok_or(Failure::Backend)?;
        let command = format!("type --delay 0 --args 1 ${index} version\n");
        self.transact(command.as_bytes(), deadline, sent)
    }

    pub(super) fn finish(mut self, deadline: Instant) -> Result<(), Failure> {
        // EOF is safe only here, after the last complete frame's exact ACK.
        drop(self.input.take());
        let mut output_done = false;
        let mut diagnostic_done = false;
        loop {
            check(deadline)?;
            let mut buffer = [0; 128];
            if !output_done {
                match self.output.read(&mut buffer) {
                    Ok(0) => output_done = true,
                    Ok(_) => return Err(Failure::Backend),
                    Err(error)
                        if matches!(
                            error.kind(),
                            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                        ) => {}
                    Err(error) => return Err(Failure::Io(error.kind())),
                }
            }
            if !diagnostic_done {
                match self.diagnostic.read(&mut buffer) {
                    Ok(0) => diagnostic_done = true,
                    Ok(_) => return Err(Failure::Backend),
                    Err(error)
                        if matches!(
                            error.kind(),
                            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                        ) => {}
                    Err(error) => return Err(Failure::Io(error.kind())),
                }
            }
            if !self.reaped {
                // Observe exit without reaping first: the zombie reserves the
                // PID/group identity while any owned descendants are killed.
                let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
                let result = unsafe {
                    libc::waitid(
                        libc::P_PID,
                        self.child.id(),
                        &mut info,
                        libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                    )
                };
                if result != 0 {
                    check(deadline)?;
                    let error = std::io::Error::last_os_error();
                    if error.kind() == std::io::ErrorKind::Interrupted {
                        continue;
                    }
                    return Err(Failure::Io(error.kind()));
                }
                if unsafe { info.si_pid() } == self.child.id() as i32 {
                    unsafe {
                        libc::kill(-(self.child.id() as i32), libc::SIGKILL);
                    }
                    let status = self
                        .child
                        .wait()
                        .map_err(|error| Failure::Io(error.kind()))?;
                    self.reaped = true;
                    if !status.success() {
                        return Err(Failure::Backend);
                    }
                }
            }
            if self.reaped && output_done && diagnostic_done {
                check(deadline)?;
                return Ok(());
            }
            wait(self.output.as_raw_fd(), libc::POLLIN);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    struct Fixture {
        root: std::path::PathBuf,
    }
    impl Fixture {
        fn new(body: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "desktopuse-stream-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir(&root).unwrap();
            let path = root.join("helper");
            std::fs::write(&path, format!("#!/usr/bin/python3\nimport sys,os\nfrom pathlib import Path\nroot=Path(__file__).parent\nack={:?}\n{}", String::from_utf8(ACK.to_vec()).unwrap(), body)).unwrap();
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
            Self { root }
        }
        fn helper(&self) -> std::path::PathBuf {
            self.root.join("helper")
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn generated_frames_preserve_literal_operands_and_deduplicate_indices() {
        let fixture = Fixture::new("for line in sys.stdin:\n if line=='version\\n':sys.stdout.write(ack);sys.stdout.flush();continue\n parts=line.split();assert parts[:5]==['type','--delay','0','--args','1'] and parts[-1]=='version'\n value=sys.argv[int(parts[5][1:])+1]\n with open(root/'observed','ab') as output:output.write(value.encode())\n sys.stdout.write(ack);sys.stdout.flush()\n");
        let text = "a a\t\n'\"\\$#-é😀\u{301}";
        let characters: Vec<char> = text.chars().collect();
        let end = Instant::now() + Duration::from_secs(2);
        let (mut helper, count) = TextHelper::start(&fixture.helper(), &characters, end).unwrap();
        assert_eq!(count, characters.len());
        assert!(helper.indices.len() < characters.len());
        for value in characters {
            helper.text(value, end, &mut || {}).unwrap();
        }
        helper.finish(end).unwrap();
        assert_eq!(
            std::fs::read_to_string(fixture.root.join("observed")).unwrap(),
            text
        );
    }

    #[test]
    fn stderr_without_ack_is_a_bounded_private_backend_failure() {
        let fixture = Fixture::new("for line in sys.stdin:\n if line=='version\\n':sys.stdout.write(ack);sys.stdout.flush()\n else:sys.stderr.write('private-stream-diagnostic');sys.stderr.flush()\n");
        let end = Instant::now() + Duration::from_secs(2);
        let (mut helper, _) = TextHelper::start(&fixture.helper(), &['a'], end).unwrap();
        let pid = helper.child.id();
        let begin = Instant::now();
        let error = helper.text('a', end, &mut || {}).unwrap_err();
        assert_eq!(error.code(), "BACKEND_ERROR");
        assert!(begin.elapsed() < Duration::from_secs(1));
        drop(helper);
        assert!(!Path::new(&format!("/proc/{pid}")).exists());
        assert!(!format!("{error:?}").contains("private-stream-diagnostic"));
    }

    #[test]
    fn drop_kills_before_closing_a_partial_frame() {
        let fixture = Fixture::new("line=sys.stdin.readline();assert line=='version\\n'\nsys.stdout.write(ack);sys.stdout.flush()\nline=sys.stdin.readline()\nif line:(root/'executed').write_text('unexpected')\n");
        let end = Instant::now() + Duration::from_secs(2);
        let (mut helper, _) = TextHelper::start(&fixture.helper(), &['a'], end).unwrap();
        helper
            .input
            .as_mut()
            .unwrap()
            .write_all(b"type --delay 0 --args 1 $1")
            .unwrap();
        let pid = helper.child.id();
        drop(helper);
        assert!(!Path::new(&format!("/proc/{pid}")).exists());
        assert!(!fixture.root.join("executed").exists());
    }

    #[test]
    fn empty_text_initializes_and_finishes_the_protocol() {
        let fixture = Fixture::new("for line in sys.stdin:\n assert line=='version\\n';sys.stdout.write(ack);sys.stdout.flush()\n");
        let end = Instant::now() + Duration::from_secs(2);
        let (helper, count) = TextHelper::start(&fixture.helper(), &[], end).unwrap();
        assert_eq!(count, 0);
        helper.finish(end).unwrap();
    }

    #[test]
    fn successful_ack_cannot_mask_extra_stdout_or_nonzero_exit() {
        for ending in [
            "sys.stdout.write('unexpected');sys.stdout.flush()",
            "sys.exit(7)",
        ] {
            let fixture = Fixture::new(&format!(
                "for line in sys.stdin:\n sys.stdout.write(ack);sys.stdout.flush()\n{ending}\n"
            ));
            let end = Instant::now() + Duration::from_secs(2);
            let (helper, _) = TextHelper::start(&fixture.helper(), &[], end).unwrap();
            assert_eq!(helper.finish(end).unwrap_err().code(), "BACKEND_ERROR");
        }
    }

    #[test]
    fn chunks_preserve_all_scalars_without_exceeding_the_per_helper_output_cap() {
        let fixture = Fixture::new("for line in sys.stdin:\n if line!='version\\n':\n  with open(root/'observed','ab') as output:output.write(sys.argv[int(line.split()[5][1:])+1].encode())\n sys.stdout.write(ack);sys.stdout.flush()\n");
        let values = vec!['a'; CHUNK + 3];
        let end = Instant::now() + Duration::from_secs(3);
        let mut offset = 0;
        let mut helpers = 0;
        while offset < values.len() {
            let (mut helper, count) =
                TextHelper::start(&fixture.helper(), &values[offset..], end).unwrap();
            for value in &values[offset..offset + count] {
                helper.text(*value, end, &mut || {}).unwrap();
            }
            assert!(helper.bytes < LIMIT);
            helper.finish(end).unwrap();
            offset += count;
            helpers += 1;
        }
        assert_eq!(helpers, 2);
        assert_eq!(
            std::fs::read(fixture.root.join("observed")).unwrap(),
            vec![b'a'; values.len()]
        );
    }
}

impl Drop for TextHelper {
    fn drop(&mut self) {
        // Never close a partially written command's stdin before killing:
        // script_main executes an unterminated final line on EOF.
        if !self.reaped {
            unsafe {
                libc::kill(-(self.child.id() as i32), libc::SIGKILL);
            }
            drop(self.input.take());
            let _ = self.child.wait();
        }
    }
}
