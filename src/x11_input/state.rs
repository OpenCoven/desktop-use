use std::collections::BTreeSet;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) struct Snapshot {
    pub down: BTreeSet<u8>,
    pub modifiers: BTreeSet<u8>,
    pub buttons: u8,
    pub pointer: (i32, i32),
    pub locked_mods: u8,
    pub locked_group: u8,
    pub base_group: u16,
    pub latched_group: u16,
}

#[derive(Clone, Debug, Default)]
pub(super) struct Scope {
    // Only the imminent helper unit may authorize a new key release.
    pub release_candidates: BTreeSet<u8>,
    // Earlier helper units may have cleared/touched these preheld keys.
    pub restore_candidates: BTreeSet<u8>,
    pub cleared_modifiers: bool,
    pub explicit_caps_lock: bool,
    pub temporary_groups: BTreeSet<u8>,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct Compensation {
    pub release: Vec<u8>,
    pub restore: Vec<u8>,
    pub restore_buttons: Vec<u8>,
    pub restore_lock: bool,
    pub restore_group: Option<u8>,
    pub unverified: bool,
}

pub(super) fn compensation(initial: &Snapshot, now: &Snapshot, scope: &Scope) -> Compensation {
    let mut result = Compensation::default();
    result.release = scope
        .release_candidates
        .intersection(&now.down)
        .filter(|key| !initial.down.contains(key))
        .copied()
        .collect();
    let mut restorable = scope.restore_candidates.clone();
    if scope.cleared_modifiers {
        restorable.extend(initial.modifiers.iter().copied());
    }
    result.restore = restorable
        .intersection(&initial.down)
        .filter(|key| !now.down.contains(key))
        .copied()
        .collect();
    if scope.cleared_modifiers {
        let missing = initial.buttons & !now.buttons;
        if missing != 0 {
            if initial.pointer == now.pointer {
                result.restore_buttons = (1..=5)
                    .filter(|button| missing & (1 << (button - 1)) != 0)
                    .collect();
            } else {
                result.unverified = true;
            }
        }
        // The qualified helper clears only Caps Lock, not every locked modifier.
        result.restore_lock =
            !scope.explicit_caps_lock && initial.locked_mods & 2 != 0 && now.locked_mods & 2 == 0;
    }
    if initial.locked_group != now.locked_group
        && scope.temporary_groups.contains(&now.locked_group)
    {
        if initial.base_group == now.base_group && initial.latched_group == now.latched_group {
            result.restore_group = Some(initial.locked_group);
        } else {
            result.unverified = true;
        }
    }
    result
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum MappingDecision {
    Unchanged,
    Restore,
    Unverified,
}
pub(super) fn same_mapping(initial: &[u64], now: &[u64]) -> bool {
    (0..initial.len().max(now.len())).all(|index| {
        initial.get(index).copied().unwrap_or(0) == now.get(index).copied().unwrap_or(0)
    })
}
pub(super) fn scratch_mapping(
    initial: &[u64],
    now: &[u64],
    allowed: &BTreeSet<u64>,
) -> MappingDecision {
    if same_mapping(initial, now) {
        MappingDecision::Unchanged
    } else if initial.first() == Some(&0)
        && !allowed.is_empty()
        && (now.first().is_some_and(|symbol| allowed.contains(symbol))
            || now.iter().all(|symbol| *symbol == 0))
        && now.iter().skip(1).all(|symbol| *symbol == 0)
    {
        MappingDecision::Restore
    } else {
        MappingDecision::Unverified
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn set(keys: &[u8]) -> BTreeSet<u8> {
        keys.iter().copied().collect()
    }

    #[test]
    fn releases_only_new_current_intent_and_preserves_unrelated_and_future_keys() {
        let initial = Snapshot {
            down: set(&[50]),
            modifiers: set(&[50]),
            ..Snapshot::default()
        };
        let now = Snapshot {
            down: set(&[38, 50, 52, 53]),
            ..initial.clone()
        };
        let scope = Scope {
            release_candidates: set(&[38, 50]),
            ..Scope::default()
        };
        let result = compensation(&initial, &now, &scope);
        assert_eq!(result.release, [38]);
        assert!(result.restore.is_empty());
        assert!(!result.unverified);
    }

    #[test]
    fn restores_only_preheld_keys_that_a_helper_unit_could_touch() {
        let initial = Snapshot {
            down: set(&[38, 50, 62, 64]),
            modifiers: set(&[50, 62]),
            ..Snapshot::default()
        };
        let now = Snapshot::default();
        let scope = Scope {
            restore_candidates: set(&[38]),
            cleared_modifiers: true,
            ..Scope::default()
        };
        assert_eq!(compensation(&initial, &now, &scope).restore, [38, 50, 62]);
    }

    #[test]
    fn does_not_restore_missing_unrelated_keys_without_modifier_clearing() {
        let initial = Snapshot {
            down: set(&[50]),
            modifiers: set(&[50]),
            ..Snapshot::default()
        };
        assert!(
            compensation(&initial, &Snapshot::default(), &Scope::default())
                .restore
                .is_empty()
        );
    }

    #[test]
    fn restores_helper_cleared_preheld_buttons_only_at_the_unchanged_pointer() {
        let initial = Snapshot {
            buttons: 0b00101,
            pointer: (20, 30),
            ..Snapshot::default()
        };
        let mut now = Snapshot {
            buttons: 0b00010,
            ..initial.clone()
        };
        let scope = Scope {
            cleared_modifiers: true,
            ..Scope::default()
        };
        assert_eq!(compensation(&initial, &now, &scope).restore_buttons, [1, 3]);
        now.pointer.0 += 1;
        let result = compensation(&initial, &now, &scope);
        assert!(result.restore_buttons.is_empty());
        assert!(result.unverified);
    }

    #[test]
    fn only_restores_the_caps_lock_bit_that_the_helper_could_clear() {
        let initial = Snapshot {
            locked_mods: 0b10010,
            ..Snapshot::default()
        };
        let now = Snapshot {
            locked_mods: 0b10000,
            ..Snapshot::default()
        };
        let mut scope = Scope {
            cleared_modifiers: true,
            ..Scope::default()
        };
        assert!(compensation(&initial, &now, &scope).restore_lock);
        scope.explicit_caps_lock = true;
        assert!(!compensation(&initial, &now, &scope).restore_lock);
        assert!(!compensation(&Snapshot::default(), &initial, &scope).restore_lock);
    }

    #[test]
    fn restores_only_a_qualified_temporary_group_without_external_base_changes() {
        let initial = Snapshot {
            locked_group: 1,
            ..Snapshot::default()
        };
        let mut now = Snapshot {
            locked_group: 2,
            ..Snapshot::default()
        };
        let scope = Scope {
            temporary_groups: set(&[2]),
            ..Scope::default()
        };
        assert_eq!(compensation(&initial, &now, &scope).restore_group, Some(1));
        now.base_group = 1;
        let result = compensation(&initial, &now, &scope);
        assert_eq!(result.restore_group, None);
        assert!(result.unverified);
    }

    #[test]
    fn preserves_an_unrelated_group_switch() {
        let initial = Snapshot::default();
        let now = Snapshot {
            locked_group: 3,
            ..Snapshot::default()
        };
        assert_eq!(
            compensation(&initial, &now, &Scope::default()).restore_group,
            None
        );
    }

    #[test]
    fn scratch_restore_requires_the_exact_qualified_helper_shape() {
        let allowed = BTreeSet::from([0x0101f600]);
        assert_eq!(
            scratch_mapping(&[0, 17], &[0x0101f600, 0], &allowed),
            MappingDecision::Restore
        );
        assert_eq!(
            scratch_mapping(&[0, 17], &[42, 0], &allowed),
            MappingDecision::Unverified
        );
        assert_eq!(
            scratch_mapping(&[0, 17], &[0x0101f600, 55], &allowed),
            MappingDecision::Unverified
        );
        assert_eq!(
            scratch_mapping(&[0, 17], &[0, 17, 0, 0], &allowed),
            MappingDecision::Unchanged
        );
    }

    #[test]
    fn restores_a_used_scratch_row_after_the_helper_zeroes_its_original_later_columns() {
        assert_eq!(
            scratch_mapping(&[0, 17], &[0, 0], &BTreeSet::from([0x0101f600])),
            MappingDecision::Restore
        );
        assert_eq!(
            scratch_mapping(&[0, 17], &[0, 0], &BTreeSet::new()),
            MappingDecision::Unverified
        );
    }
}
