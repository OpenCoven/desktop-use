//! This ABI is qualified only for libxdo 3.20160805.1, in an owned child.
//! Never run display operations in the supervising adapter's polling thread.
use super::state::{compensation, same_mapping, scratch_mapping, MappingDecision, Scope, Snapshot};
use libc::{c_char, c_int, c_uint, c_ulong, c_void};
use std::collections::BTreeSet;
use std::ffi::{CStr, CString};

#[repr(C)]
#[derive(Clone, Copy)]
struct CharCode {
    key: libc::wchar_t,
    code: u8,
    symbol: c_ulong,
    group: c_int,
    modmask: c_int,
    needs_binding: c_int,
}
#[repr(C)]
struct Xdo {
    display: *mut c_void,
    display_name: *mut c_char,
    chars: *mut CharCode,
    chars_len: c_int,
}
#[repr(C)]
struct ModifierMap {
    width: c_int,
    codes: *mut u8,
}
#[repr(C)]
#[derive(Default)]
struct XkbState {
    group: u8,
    locked_group: u8,
    base_group: u16,
    latched_group: u16,
    mods: u8,
    base_mods: u8,
    latched_mods: u8,
    locked_mods: u8,
    compat: u8,
    grab: u8,
    compat_grab: u8,
    lookup: u8,
    compat_lookup: u8,
    buttons: u16,
}

struct Api {
    handles: [*mut c_void; 3],
    new: unsafe extern "C" fn(*const c_char) -> *mut Xdo,
    with_display: unsafe extern "C" fn(*mut c_void, *const c_char, c_int) -> *mut Xdo,
    free: unsafe extern "C" fn(*mut Xdo),
    version: unsafe extern "C" fn() -> *const c_char,
    aliases: unsafe extern "C" fn() -> *const *const c_char,
    query_keys: unsafe extern "C" fn(*mut c_void, *mut c_char) -> c_int,
    keycodes: unsafe extern "C" fn(*mut c_void, *mut c_int, *mut c_int) -> c_int,
    get_modifiers: unsafe extern "C" fn(*mut c_void) -> *mut ModifierMap,
    free_modifiers: unsafe extern "C" fn(*mut ModifierMap) -> c_int,
    get_mapping: unsafe extern "C" fn(*mut c_void, u8, c_int, *mut c_int) -> *mut c_ulong,
    set_mapping: unsafe extern "C" fn(*mut c_void, c_int, c_int, *mut c_ulong, c_int) -> c_int,
    xfree: unsafe extern "C" fn(*mut c_void) -> c_int,
    root: unsafe extern "C" fn(*mut c_void) -> c_ulong,
    pointer: unsafe extern "C" fn(
        *mut c_void,
        c_ulong,
        *mut c_ulong,
        *mut c_ulong,
        *mut c_int,
        *mut c_int,
        *mut c_int,
        *mut c_int,
        *mut c_uint,
    ) -> c_int,
    get_state: unsafe extern "C" fn(*mut c_void, c_uint, *mut XkbState) -> c_int,
    lock_mods: unsafe extern "C" fn(*mut c_void, c_uint, c_uint, c_uint) -> c_int,
    lock_group: unsafe extern "C" fn(*mut c_void, c_uint, c_uint) -> c_int,
    key: unsafe extern "C" fn(*mut c_void, c_uint, c_int, c_ulong) -> c_int,
    button: unsafe extern "C" fn(*mut c_void, c_uint, c_int, c_ulong) -> c_int,
    sync: unsafe extern "C" fn(*mut c_void, c_int) -> c_int,
    string_symbol: unsafe extern "C" fn(*const c_char) -> c_ulong,
    symbol_string: unsafe extern "C" fn(c_ulong) -> *const c_char,
}
unsafe fn symbol<T: Copy>(library: *mut c_void, name: &[u8]) -> Option<T> {
    let pointer = libc::dlsym(library, name.as_ptr().cast());
    if pointer.is_null() || std::mem::size_of::<T>() != std::mem::size_of_val(&pointer) {
        None
    } else {
        Some(std::mem::transmute_copy(&pointer))
    }
}
macro_rules! function {
    ($library:expr, $name:literal) => {
        symbol($library, concat!($name, "\0").as_bytes())?
    };
}
impl Api {
    unsafe fn load() -> Option<Self> {
        let xdo = libc::dlopen(c"libxdo.so.3".as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL);
        let x11 = libc::dlopen(c"libX11.so.6".as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL);
        let xtst = libc::dlopen(c"libXtst.so.6".as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL);
        if [xdo, x11, xtst].iter().any(|handle| handle.is_null()) {
            return None;
        }
        Some(Self {
            handles: [xdo, x11, xtst],
            new: function!(xdo, "xdo_new"),
            with_display: function!(xdo, "xdo_new_with_opened_display"),
            free: function!(xdo, "xdo_free"),
            version: function!(xdo, "xdo_version"),
            aliases: function!(xdo, "xdo_get_symbol_map"),
            query_keys: function!(x11, "XQueryKeymap"),
            keycodes: function!(x11, "XDisplayKeycodes"),
            get_modifiers: function!(x11, "XGetModifierMapping"),
            free_modifiers: function!(x11, "XFreeModifiermap"),
            get_mapping: function!(x11, "XGetKeyboardMapping"),
            set_mapping: function!(x11, "XChangeKeyboardMapping"),
            xfree: function!(x11, "XFree"),
            root: function!(x11, "XDefaultRootWindow"),
            pointer: function!(x11, "XQueryPointer"),
            get_state: function!(x11, "XkbGetState"),
            lock_mods: function!(x11, "XkbLockModifiers"),
            lock_group: function!(x11, "XkbLockGroup"),
            key: function!(xtst, "XTestFakeKeyEvent"),
            button: function!(xtst, "XTestFakeButtonEvent"),
            sync: function!(x11, "XSync"),
            string_symbol: function!(x11, "XStringToKeysym"),
            symbol_string: function!(x11, "XKeysymToString"),
        })
    }
}

struct Mapping {
    low: u8,
    rows: Vec<Vec<c_ulong>>,
}
impl Mapping {
    fn row(&self, key: u8) -> Option<&[c_ulong]> {
        self.rows
            .get(usize::from(key.checked_sub(self.low)?))
            .map(Vec::as_slice)
    }
}
pub(super) struct Context {
    api: Api,
    xdo: *mut Xdo,
    owner: *mut Xdo,
    low: u8,
    high: u8,
    initial: Snapshot,
    mapping: Mapping,
    modifiers: Vec<Vec<u8>>,
    scope: Scope,
    previous_scope: Scope,
    confident: bool,
    scratch: Option<u8>,
    scratch_symbols: BTreeSet<u64>,
    logical_active: bool,
    pointer_active: bool,
    last_report: [u8; 8],
}
impl Drop for Context {
    fn drop(&mut self) {
        unsafe {
            if self.xdo != self.owner {
                (self.api.free)(self.xdo);
            }
            (self.api.free)(self.owner);
            for handle in self.api.handles {
                libc::dlclose(handle);
            }
        }
    }
}

impl Context {
    pub(super) unsafe fn open() -> Option<Self> {
        let api = Api::load()?;
        let version = (api.version)();
        if version.is_null() || CStr::from_ptr(version).to_bytes() != b"3.20160805.1" {
            return None;
        }
        let xdo = (api.new)(std::ptr::null());
        if xdo.is_null() {
            return None;
        }
        let context = &mut *xdo;
        if context.display.is_null()
            || context.chars.is_null()
            || !(1..=16384).contains(&context.chars_len)
        {
            (api.free)(xdo);
            return None;
        }
        let (mut low, mut high) = (0, 0);
        (api.keycodes)(context.display, &mut low, &mut high);
        if low < 8 || high > 255 || low > high {
            (api.free)(xdo);
            return None;
        }
        let mut result = Self {
            api,
            xdo,
            owner: xdo,
            low: low as u8,
            high: high as u8,
            initial: Snapshot::default(),
            mapping: Mapping {
                low: 0,
                rows: vec![],
            },
            modifiers: vec![],
            scope: Scope::default(),
            previous_scope: Scope::default(),
            confident: true,
            scratch: None,
            scratch_symbols: BTreeSet::new(),
            logical_active: false,
            pointer_active: false,
            last_report: [1, 3, 0, 0, 0, 0, 0, 0],
        };
        result.initial = result.snapshot()?;
        result.modifiers = result.modifier_map()?;
        result.mapping = result.keyboard_map()?;
        // Match the qualified helper's first-zero-row selection, including its
        // first-column behavior. Do not replace it with a guessed empty row.
        result.scratch = result
            .mapping
            .rows
            .iter()
            .enumerate()
            .find(|(index, row)| {
                *index + usize::from(result.mapping.low) < usize::from(result.high)
                    && row.first() == Some(&0)
            })
            .map(|(index, _)| result.mapping.low + index as u8);
        // Keyboard-only qualification happens in begin_logical. A pointer
        // transaction never restores or otherwise changes keyboard state.
        Some(result)
    }

    pub(super) unsafe fn begin_pointer(&mut self, button: u8) -> bool {
        if self.logical_active || !(1..=5).contains(&button) {
            return false;
        }
        let Some(initial) = self.pointer_snapshot() else {
            return false;
        };
        self.initial = initial;
        self.previous_scope = Scope::default();
        self.scope = Scope::default();
        self.scope.button_release_candidates.insert(button);
        if self.initial.buttons & (1 << (button - 1)) != 0 {
            self.scope.button_restore_candidates.insert(button);
        }
        self.pointer_active = true;
        self.logical_active = true;
        true
    }

    pub(super) unsafe fn begin_logical(&mut self, clear: bool) -> Option<bool> {
        if self.logical_active {
            return None;
        }
        // Rebuild the helper's ordered map on the SAME owned connection. The
        // owner context alone closes it; borrowed contexts own only their map.
        let fresh = (self.api.with_display)((*self.owner).display, std::ptr::null(), 0);
        if fresh.is_null() || (*fresh).chars.is_null() || !(1..=16384).contains(&(*fresh).chars_len)
        {
            if !fresh.is_null() {
                (self.api.free)(fresh);
            }
            return None;
        }
        if self.xdo != self.owner {
            (self.api.free)(self.xdo);
        }
        self.xdo = fresh;
        self.initial = self.snapshot()?;
        self.modifiers = self.modifier_map()?;
        self.mapping = self.keyboard_map()?;
        if self.entries().iter().any(|entry| {
            self.initial.down.contains(&entry.code) && [0xff7f, 0xff14].contains(&entry.symbol)
        }) {
            return None;
        }
        self.scratch = self
            .mapping
            .rows
            .iter()
            .enumerate()
            .find(|(index, row)| {
                *index + usize::from(self.low) < usize::from(self.high) && row.first() == Some(&0)
            })
            .map(|(index, _)| self.low + index as u8);
        self.scope = Scope {
            cleared_modifiers: clear,
            ..Scope::default()
        };
        self.previous_scope = self.scope.clone();
        self.scratch_symbols.clear();
        self.confident = true;
        self.pointer_active = false;
        self.logical_active = true;
        if !clear {
            return Some(false);
        }
        let display = (*self.xdo).display;
        let mut changed = false;
        for key in self.initial.down.intersection(&self.initial.modifiers) {
            if (self.api.key)(display, c_uint::from(*key), 0, 0) == 0 {
                return None;
            }
            changed = true;
        }
        for button in 1..=5 {
            if self.initial.buttons & (1 << (button - 1)) != 0 {
                if (self.api.button)(display, button, 0, 0) == 0 {
                    return None;
                }
                changed = true;
            }
        }
        if self.initial.locked_mods & 2 != 0 {
            if (self.api.lock_mods)(display, 0x100, 2, 0) == 0 {
                return None;
            }
            changed = true;
        }
        (self.api.sync)(display, 0);
        Some(changed)
    }

    pub(super) unsafe fn end_logical(&mut self) -> [u8; 8] {
        if self.logical_active {
            self.last_report = self.cleanup();
            self.logical_active = false;
        }
        self.last_report
    }
    unsafe fn entries(&self) -> &[CharCode] {
        std::slice::from_raw_parts((*self.xdo).chars, (*self.xdo).chars_len as usize)
    }
    unsafe fn modifier_map(&self) -> Option<Vec<Vec<u8>>> {
        let pointer = (self.api.get_modifiers)((*self.xdo).display);
        if pointer.is_null() {
            return None;
        }
        let width = (*pointer).width;
        let result = if (1..=32).contains(&width) && !(*pointer).codes.is_null() {
            Some(
                std::slice::from_raw_parts((*pointer).codes, 8 * width as usize)
                    .chunks(width as usize)
                    .map(|row| row.to_vec())
                    .collect(),
            )
        } else {
            None
        };
        (self.api.free_modifiers)(pointer);
        result
    }
    unsafe fn keyboard_map(&self) -> Option<Mapping> {
        let low = c_int::from(self.low);
        let count = c_int::from(self.high) - low + 1;
        let mut width = 0;
        let pointer = (self.api.get_mapping)((*self.xdo).display, low as u8, count, &mut width);
        if pointer.is_null() {
            return None;
        }
        let result = if (1..=32).contains(&width) {
            Some(Mapping {
                low: low as u8,
                rows: std::slice::from_raw_parts(pointer, count as usize * width as usize)
                    .chunks(width as usize)
                    .map(|row| row.to_vec())
                    .collect(),
            })
        } else {
            None
        };
        (self.api.xfree)(pointer.cast());
        result
    }
    unsafe fn snapshot(&self) -> Option<Snapshot> {
        let display = (*self.xdo).display;
        let mut keymap = [0u8; 32];
        if (self.api.query_keys)(display, keymap.as_mut_ptr().cast()) == 0 {
            return None;
        }
        let mut state = XkbState::default();
        if (self.api.get_state)(display, 0x100, &mut state) != 0 {
            return None;
        }
        let (mut root, mut child, mut rx, mut ry, mut wx, mut wy, mut mask) = (0, 0, 0, 0, 0, 0, 0);
        if (self.api.pointer)(
            display,
            (self.api.root)(display),
            &mut root,
            &mut child,
            &mut rx,
            &mut ry,
            &mut wx,
            &mut wy,
            &mut mask,
        ) == 0
        {
            return None;
        }
        let modifiers = self
            .modifier_map()?
            .into_iter()
            .flatten()
            .filter(|key| *key != 0)
            .collect();
        Some(Snapshot {
            down: (0..=255u8)
                .filter(|key| keymap[usize::from(*key) / 8] & (1 << (*key % 8)) != 0)
                .collect(),
            modifiers,
            buttons: ((mask >> 8) & 31) as u8,
            pointer: (rx, ry),
            locked_mods: state.locked_mods,
            locked_group: state.locked_group,
            base_group: state.base_group,
            latched_group: state.latched_group,
        })
    }

    unsafe fn pointer_snapshot(&self) -> Option<Snapshot> {
        let display = (*self.xdo).display;
        let (mut root, mut child, mut rx, mut ry, mut wx, mut wy, mut mask) = (0, 0, 0, 0, 0, 0, 0);
        if (self.api.pointer)(
            display,
            (self.api.root)(display),
            &mut root,
            &mut child,
            &mut rx,
            &mut ry,
            &mut wx,
            &mut wy,
            &mut mask,
        ) == 0
        {
            return None;
        }
        Some(Snapshot {
            buttons: ((mask >> 8) & 31) as u8,
            pointer: (rx, ry),
            ..Snapshot::default()
        })
    }
    unsafe fn add_symbol(&mut self, symbol: c_ulong) -> bool {
        if symbol == 0 {
            return false;
        }
        let selected = self
            .entries()
            .iter()
            .find(|entry| entry.symbol == symbol)
            .copied();
        let (code, group, mask) = if let Some(entry) = selected {
            if entry.code < self.low
                || entry.code > self.high
                || !(0..=3).contains(&entry.group)
                || !(0..=255).contains(&entry.modmask)
            {
                return false;
            }
            (entry.code, entry.group as u8, entry.modmask as u8)
        } else if let Some(code) = self.scratch {
            self.scratch_symbols.insert(symbol as u64);
            (code, 0, 0)
        } else {
            return false;
        };
        self.scope.release_candidates.insert(code);
        self.scope.temporary_groups.insert(group);
        for index in 0..8 {
            if mask & (1 << index) != 0 {
                if let Some(key) = self.modifiers[index].iter().copied().find(|key| *key != 0) {
                    self.scope.release_candidates.insert(key);
                } else {
                    return false;
                }
            }
        }
        if symbol == 0xffe5 {
            self.scope.explicit_caps_lock = true;
        }
        if (0xfe06..=0xfe0f).contains(&symbol) || symbol == 0xff7e {
            self.scope.temporary_groups.clear();
            return false;
        }
        true
    }
    pub(super) unsafe fn activate_text(&mut self, value: u32, clear: bool) {
        self.begin(clear);
        let symbol = self
            .entries()
            .iter()
            .find(|entry| entry.key as u32 == value)
            .map(|entry| entry.symbol)
            .unwrap_or_else(|| {
                if value >= 0x100 {
                    c_ulong::from(value) + 0x01000000
                } else {
                    c_ulong::from(value)
                }
            });
        if (self.api.symbol_string)(symbol).is_null() || !self.add_symbol(symbol) {
            self.confident = false;
        }
        self.remember_preheld();
    }
    pub(super) unsafe fn activate_keys(&mut self, sequence: &str, clear: bool) {
        self.begin(clear);
        if sequence
            .bytes()
            .any(|byte| b" \t\n.-[]{}\\|".contains(&byte))
        {
            self.confident = false;
            return;
        }
        for token in sequence.split('+').filter(|token| !token.is_empty()) {
            let aliases = (self.api.aliases)();
            let mut mapped = token.to_owned();
            if aliases.is_null() {
                self.confident = false;
                break;
            }
            for index in 0..128 {
                let from = *aliases.add(index * 2);
                if from.is_null() {
                    break;
                }
                let to = *aliases.add(index * 2 + 1);
                if to.is_null() {
                    self.confident = false;
                    break;
                }
                if CStr::from_ptr(from)
                    .to_bytes()
                    .eq_ignore_ascii_case(token.as_bytes())
                {
                    mapped = CStr::from_ptr(to).to_string_lossy().into_owned();
                    break;
                }
            }
            let Ok(name) = CString::new(mapped.clone()) else {
                self.confident = false;
                break;
            };
            let symbol = (self.api.string_symbol)(name.as_ptr());
            if symbol != 0 {
                if !self.add_symbol(symbol) {
                    self.confident = false;
                }
            } else {
                let digits: String = mapped.chars().take_while(char::is_ascii_digit).collect();
                if let Ok(code) = digits.parse::<u8>() {
                    if code >= self.low && code <= self.high {
                        self.scope.release_candidates.insert(code);
                    } else {
                        self.confident = false;
                    }
                } else {
                    self.confident = false;
                }
            }
        }
        self.remember_preheld();
    }
    fn begin(&mut self, clear: bool) {
        self.previous_scope = self.scope.clone();
        self.scope.release_candidates.clear();
        self.scope.temporary_groups.clear();
        self.scope.cleared_modifiers |= clear;
    }
    fn remember_preheld(&mut self) {
        self.scope.restore_candidates.extend(
            self.scope
                .release_candidates
                .intersection(&self.initial.down)
                .copied(),
        );
    }
    pub(super) fn complete_unit(&mut self) {
        self.scope.release_candidates.clear();
        self.scope.button_release_candidates.clear();
        self.scope.temporary_groups.clear();
    }
    pub(super) fn not_started(&mut self) {
        self.scope = self.previous_scope.clone();
        self.complete_unit();
    }

    // Only safe counts cross the private channel. No key ids, mapping or text.
    pub(super) unsafe fn cleanup(&mut self) -> [u8; 8] {
        if self.pointer_active {
            return self.cleanup_pointer();
        }
        let mut report = [1, 1, 0, 0, 0, 0, 0, 0];
        let Some(current) = self.snapshot() else {
            report[1] = 2;
            return report;
        };
        let Some(mapping) = self.keyboard_map() else {
            report[1] = 2;
            return report;
        };
        if self.modifier_map().as_ref() != Some(&self.modifiers) {
            report[1] = 2;
            return report;
        }
        let affected: BTreeSet<u8> = self
            .scope
            .release_candidates
            .union(&self.scope.restore_candidates)
            .copied()
            .chain(if self.scope.cleared_modifiers {
                self.initial.modifiers.iter().copied().collect::<Vec<_>>()
            } else {
                vec![]
            })
            .collect();
        for code in &affected {
            if Some(*code) == self.scratch {
                continue;
            }
            if !self
                .mapping
                .row(*code)
                .zip(mapping.row(*code))
                .is_some_and(|(initial, now)| same_mapping(initial, now))
            {
                report[1] = 2;
                return report;
            }
        }
        let mut restore_mapping = None;
        if let Some(code) = self.scratch {
            if !self.scratch_symbols.is_empty() {
                let (Some(initial), Some(now)) = (self.mapping.row(code), mapping.row(code)) else {
                    report[1] = 2;
                    return report;
                };
                match scratch_mapping(initial, now, &self.scratch_symbols) {
                    MappingDecision::Unchanged => {}
                    MappingDecision::Restore => restore_mapping = Some((code, initial.to_vec())),
                    MappingDecision::Unverified => {
                        report[1] = 2;
                        return report;
                    }
                }
            }
        }
        let plan = compensation(&self.initial, &current, &self.scope);
        let display = (*self.xdo).display;
        let mut okay = self.confident && !plan.unverified;
        for code in &plan.release {
            okay &= (self.api.key)(display, c_uint::from(*code), 0, 0) != 0;
        }
        for code in &plan.restore {
            okay &= (self.api.key)(display, c_uint::from(*code), 1, 0) != 0;
        }
        for button in &plan.restore_buttons {
            okay &= (self.api.button)(display, c_uint::from(*button), 1, 0) != 0;
        }
        if plan.restore_lock {
            okay &= (self.api.lock_mods)(display, 0x100, 2, 2) != 0;
        }
        if let Some(group) = plan.restore_group {
            okay &= (self.api.lock_group)(display, 0x100, c_uint::from(group)) != 0;
        }
        (self.api.sync)(display, 0);
        if let Some((code, mut row)) = restore_mapping {
            (self.api.set_mapping)(
                display,
                c_int::from(code),
                row.len() as c_int,
                row.as_mut_ptr(),
                1,
            );
            (self.api.sync)(display, 0);
            report[7] = 1;
        }
        report[2] = plan.release.len() as u8;
        report[3] = plan.restore.len() as u8;
        report[4] = plan.restore_buttons.len() as u8;
        report[5] = u8::from(plan.restore_lock);
        report[6] = u8::from(plan.restore_group.is_some());
        if let Some(after) = self.snapshot() {
            okay &= plan.release.iter().all(|key| !after.down.contains(key))
                && plan.restore.iter().all(|key| after.down.contains(key));
            okay &= plan
                .restore_buttons
                .iter()
                .all(|button| after.buttons & (1 << (button - 1)) != 0);
            okay &= !plan.restore_lock || after.locked_mods & 2 == self.initial.locked_mods & 2;
            okay &= plan
                .restore_group
                .is_none_or(|group| after.locked_group == group);
            okay &= current
                .down
                .difference(&affected)
                .all(|key| after.down.contains(key));
        } else {
            okay = false;
        }
        if report[7] != 0 {
            okay &= self
                .keyboard_map()
                .and_then(|after| {
                    self.scratch.and_then(|code| {
                        Some(
                            scratch_mapping(
                                self.mapping.row(code)?,
                                after.row(code)?,
                                &self.scratch_symbols,
                            ) == MappingDecision::Unchanged,
                        )
                    })
                })
                .unwrap_or(false);
        }
        if !okay {
            report[1] = 2;
        }
        report
    }

    unsafe fn cleanup_pointer(&mut self) -> [u8; 8] {
        let mut report = [2, 1, 0, 0, 0, 0, 0, 0];
        let Some(current) = self.pointer_snapshot() else {
            report[1] = 2;
            return report;
        };
        let plan = compensation(&self.initial, &current, &self.scope);
        let display = (*self.xdo).display;
        let mut okay = !plan.unverified;
        let mut expected = current.buttons;
        for button in &plan.release_buttons {
            okay &= (self.api.button)(display, c_uint::from(*button), 0, 0) != 0;
            expected &= !(1 << (button - 1));
        }
        for button in &plan.restore_buttons {
            okay &= (self.api.button)(display, c_uint::from(*button), 1, 0) != 0;
            expected |= 1 << (button - 1);
        }
        (self.api.sync)(display, 0);
        okay &= self
            .pointer_snapshot()
            .is_some_and(|after| after.buttons == expected && after.pointer == current.pointer);
        report[2] = plan.release_buttons.len() as u8;
        report[4] = plan.restore_buttons.len() as u8;
        if !okay {
            report[1] = 2;
        }
        report
    }
}
