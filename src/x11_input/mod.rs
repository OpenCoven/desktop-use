#[cfg(target_os = "linux")]
mod guard;
#[cfg(target_os = "linux")]
mod helper;
#[cfg(any(target_os = "linux", test))]
mod state;
#[cfg(target_os = "linux")]
mod stream;
#[cfg(target_os = "linux")]
mod xlib;

use std::path::Path;
use std::time::Instant;

pub(crate) struct TextHelper {
    #[cfg(target_os = "linux")]
    inner: stream::TextHelper,
}
impl TextHelper {
    pub(crate) fn start(
        helper: &Path,
        characters: &[char],
        deadline: Instant,
        guard: &mut Guard,
    ) -> Result<(Self, usize), crate::process::Failure> {
        #[cfg(target_os = "linux")]
        {
            let (inner, length) = stream::TextHelper::start_guarded(
                helper,
                characters,
                deadline,
                guard
                    .child
                    .as_ref()
                    .ok_or(crate::process::Failure::Backend)?,
            )?;
            if !guard
                .child
                .as_mut()
                .unwrap()
                .hold_input(inner.input_fd(), deadline)
            {
                return Err(crate::process::check(deadline)
                    .err()
                    .unwrap_or(crate::process::Failure::Backend));
            }
            Ok((Self { inner }, length))
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = (helper, characters, deadline, guard);
            Err(crate::process::Failure::Backend)
        }
    }
    pub(crate) fn text(
        &mut self,
        value: char,
        deadline: Instant,
        sent: &mut dyn FnMut(),
    ) -> Result<(), crate::process::Failure> {
        #[cfg(target_os = "linux")]
        {
            self.inner.text(value, deadline, sent)
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = (value, deadline, sent);
            Err(crate::process::Failure::Backend)
        }
    }
    pub(crate) fn finish(
        self,
        deadline: Instant,
        guard: &mut Guard,
    ) -> Result<(), crate::process::Failure> {
        #[cfg(target_os = "linux")]
        {
            if !guard
                .child
                .as_mut()
                .is_some_and(|child| child.release_input(deadline))
            {
                return Err(crate::process::check(deadline)
                    .err()
                    .unwrap_or(crate::process::Failure::Backend));
            }
            self.inner.finish(deadline)
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = (deadline, guard);
            Err(crate::process::Failure::Backend)
        }
    }
}

pub(crate) struct Guard {
    #[cfg(target_os = "linux")]
    child: Option<guard::PrivateChild>,
}
impl Guard {
    pub(crate) fn attach_helper(&self, command: &mut std::process::Command, deadline: Instant) {
        #[cfg(target_os = "linux")]
        if let Some(child) = &self.child {
            child.attach(command, deadline);
        }
        #[cfg(not(target_os = "linux"))]
        let _ = (command, deadline);
    }
    pub(crate) fn prepare(helper: &Path, deadline: Instant) -> Self {
        #[cfg(target_os = "linux")]
        {
            let qualified = helper.canonicalize().ok().as_deref()
                == Some(Path::new("/usr/bin/xdotool"))
                && std::fs::read(helper).is_ok_and(|bytes| {
                    bytes.starts_with(b"\x7fELF")
                        && bytes
                            .windows(b"libxdo.so.3\0".len())
                            .any(|part| part == b"libxdo.so.3\0")
                });
            Self {
                child: if qualified {
                    guard::PrivateChild::start(deadline)
                } else {
                    None
                },
            }
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = (helper, deadline);
            Self {}
        }
    }
    pub(crate) fn available(&self) -> bool {
        #[cfg(target_os = "linux")]
        {
            self.child.is_some()
        }
        #[cfg(not(target_os = "linux"))]
        {
            false
        }
    }
    pub(crate) fn begin_logical(&mut self, clear: bool, deadline: Instant) -> Option<bool> {
        #[cfg(target_os = "linux")]
        {
            self.child.as_mut()?.begin_logical(clear, deadline)
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = (clear, deadline);
            None
        }
    }
    pub(crate) fn button(&mut self, button: u8, deadline: Instant) -> bool {
        #[cfg(target_os = "linux")]
        {
            (1..=5).contains(&button)
                && self
                    .child
                    .as_mut()
                    .is_some_and(|child| child.activate(&[b'P', button], deadline))
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = (button, deadline);
            false
        }
    }
    pub(crate) fn end_logical(&mut self) -> serde_json::Value {
        #[cfg(target_os = "linux")]
        if let Some(child) = &mut self.child {
            return child.end_logical();
        }
        serde_json::json!({"schemaVersion":1,"state":"unverified","reasonCode":"X11_GUARD_UNAVAILABLE"})
    }
    pub(crate) fn text(&mut self, value: char, clear: bool, deadline: Instant) -> bool {
        #[cfg(target_os = "linux")]
        {
            let mut data = vec![b'T', u8::from(clear)];
            data.extend_from_slice(&(value as u32).to_le_bytes());
            self.child
                .as_mut()
                .is_some_and(|child| child.activate(&data, deadline))
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = (value, clear, deadline);
            false
        }
    }
    pub(crate) fn keys(&mut self, value: &str, clear: bool, deadline: Instant) -> bool {
        #[cfg(target_os = "linux")]
        {
            if value.len() > 4096 {
                return false;
            }
            let mut data = vec![b'K', u8::from(clear)];
            data.extend_from_slice(&(value.len() as u16).to_le_bytes());
            data.extend_from_slice(value.as_bytes());
            self.child
                .as_mut()
                .is_some_and(|child| child.activate(&data, deadline))
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = (value, clear, deadline);
            false
        }
    }
    pub(crate) fn completed(&mut self) {
        #[cfg(target_os = "linux")]
        if let Some(child) = &mut self.child {
            child.notify(b'C');
        }
    }
    pub(crate) fn not_started(&mut self) {
        #[cfg(target_os = "linux")]
        if let Some(child) = &mut self.child {
            child.notify(b'Z');
        }
    }
    pub(crate) fn finish(&mut self, failed: bool) -> serde_json::Value {
        #[cfg(target_os = "linux")]
        if let Some(mut child) = self.child.take() {
            return child.finish(failed);
        }
        let _ = failed;
        serde_json::json!({"schemaVersion":1,"state":"unverified","reasonCode":"X11_GUARD_UNAVAILABLE"})
    }
}
