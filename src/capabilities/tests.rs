use super::*;

// Facts are controlled observations; expectations below are independently derived from backend constraints.
fn fixtures() -> Vec<(&'static str, Facts)> {
    let make =
        |platform, session, tools: &[&str], keyboard, capture, sway_socket, permission| Facts {
            platform,
            session,
            tools: tools.iter().map(|s| s.to_string()).collect(),
            protocols: linux_capabilities::Protocols { keyboard, capture },
            grim_jpeg_support: None,
            sway_socket,
            permission,
            observed_at_ms: Some(1_700_000_000_000),
        };
    let mut cases = vec![
        (
            "macos",
            make("macos", None, &["peekaboo"], None, None, false, "unknown"),
        ),
        (
            "macos-permission-denied",
            make("macos", None, &["peekaboo"], None, None, false, "failed"),
        ),
        (
            "macos-permission-granted",
            make("macos", None, &["peekaboo"], None, None, false, "passed"),
        ),
        (
            "missing-helper",
            make("macos", None, &[], None, None, false, "unknown"),
        ),
        (
            "x11-empty",
            make(
                "linux",
                Some(LinuxSession::X11),
                &[],
                None,
                None,
                false,
                "unknown",
            ),
        ),
        (
            "x11-xdotool-only",
            make(
                "linux",
                Some(LinuxSession::X11),
                &["xdotool"],
                None,
                None,
                false,
                "unknown",
            ),
        ),
        (
            "x11",
            make(
                "linux",
                Some(LinuxSession::X11),
                &["scrot", "xdotool", "wmctrl"],
                None,
                None,
                false,
                "unknown",
            ),
        ),
        (
            "x11-maim",
            make(
                "linux",
                Some(LinuxSession::X11),
                &["maim", "xdotool"],
                None,
                None,
                false,
                "unknown",
            ),
        ),
        (
            "x11-maim-missing-lookup",
            make(
                "linux",
                Some(LinuxSession::X11),
                &["maim"],
                None,
                None,
                false,
                "unknown",
            ),
        ),
        (
            "wayland-advertised",
            make(
                "linux",
                Some(LinuxSession::Wayland),
                &["grim", "wtype", "ydotool", "swaymsg"],
                Some(true),
                Some(true),
                true,
                "unknown",
            ),
        ),
        (
            "wayland-unavailable",
            make(
                "linux",
                Some(LinuxSession::Wayland),
                &["grim", "wtype"],
                Some(false),
                Some(false),
                false,
                "unknown",
            ),
        ),
        (
            "wayland-unknown",
            make(
                "linux",
                Some(LinuxSession::Wayland),
                &["grim", "wtype", "ydotool"],
                None,
                None,
                false,
                "unknown",
            ),
        ),
        (
            "headless",
            make("linux", None, &[], None, None, false, "unknown"),
        ),
        (
            "windows",
            make("windows", None, &[], None, None, false, "unknown"),
        ),
        (
            "other",
            make("other", None, &[], None, None, false, "unknown"),
        ),
    ];
    for (name, supported) in [
        ("wayland-grim-jpeg-disabled", false),
        ("wayland-grim-jpeg-enabled", true),
    ] {
        let mut facts = make(
            "linux",
            Some(LinuxSession::Wayland),
            &["grim"],
            None,
            Some(true),
            false,
            "unknown",
        );
        facts.grim_jpeg_support = Some(supported);
        cases.push((name, facts));
    }
    cases
}

#[test]
fn platform_fixtures_validate_schema_and_remain_shared() {
    let schema: Value =
        serde_json::from_str(include_str!("../../contracts/v1/capabilities.schema.json")).unwrap();
    let validator = jsonschema::validator_for(&schema).unwrap();
    for (name, facts) in fixtures() {
        let report = report(&facts);
        let errors: Vec<_> = validator
            .iter_errors(&report)
            .map(|e| e.to_string())
            .collect();
        assert!(errors.is_empty(), "{name}: {errors:?}");
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("contracts/v1/fixtures/capabilities")
            .join(format!("{name}.json"));
        if env::var_os("UPDATE_CAPABILITIES_FIXTURES").is_some() {
            std::fs::write(
                &path,
                serde_json::to_string_pretty(&json!({"report":report})).unwrap() + "\n",
            )
            .unwrap();
        }
        let shared: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(
            report, shared["report"],
            "{name}: regenerate fixtures deliberately after checking backend semantics"
        );
        assert_eq!(report["actions"].as_object().unwrap().len(), 18);
        for action in report["actions"].as_object().unwrap().values() {
            assert_eq!(action["policy"]["profile"], "unknown");
            assert_eq!(action["policy"]["gatewayPolicy"], "not-reported");
            assert!(!action["surfaces"]
                .as_array()
                .unwrap()
                .iter()
                .any(|s| s == "sdk" || s == "mcp"));
            assert!(action["evidence"]
                .as_array()
                .unwrap()
                .iter()
                .any(|e| e["kind"] == "actual-action" && e["status"] == "not-run"));
        }
        let mut invalid = report.clone();
        invalid["actions"]
            .as_object_mut()
            .unwrap()
            .remove("type-text");
        assert!(!validator.is_valid(&invalid));
        invalid = report.clone();
        invalid["schemaVersion"] = json!(2);
        assert!(!validator.is_valid(&invalid));
    }
}

#[test]
fn x11_variants_require_active_lookup_and_do_not_promote_pointer_geometry() {
    for (name, facts) in fixtures()
        .into_iter()
        .filter(|(name, _)| matches!(*name, "x11" | "x11-maim" | "x11-maim-missing-lookup"))
    {
        let r = report(&facts);
        assert_eq!(
            r["actions"]["screenshot"]["variants"][0]["state"],
            "available"
        );
        assert_eq!(
            r["actions"]["screenshot"]["variants"][1]["state"],
            match name {
                "x11" => "available",
                "x11-maim" => "unverified",
                _ => "unsupported",
            }
        );
        assert_eq!(r["actions"]["inspect"]["state"], "degraded");
        assert_eq!(
            r["actions"]["click"]["state"],
            if name == "x11-maim-missing-lookup" {
                "unsupported"
            } else {
                "unverified"
            }
        );
        assert_eq!(
            r["actions"]["click"]["variants"][0]["limits"]["parameters"]["coords"]["maximum"],
            32767
        );
        assert_eq!(
            r["actions"]["click"]["variants"][0]["limits"]["parameters"]["coords"]["minimum"],
            0
        );
        assert_eq!(
            r["actions"]["screenshot"]["variants"][0]["limits"]["parameters"]["image"]["maxBytes"],
            8_388_608
        );
        assert_eq!(
            r["actions"]["type-text"]["variants"][0]["selectors"],
            json!([])
        );
        assert_eq!(
            r["actions"]["type-text"]["variants"][1]["state"],
            "unsupported"
        );
    }
}

#[test]
fn x11_missing_capture_helpers_stay_unsupported_with_unique_schema_valid_reasons() {
    let schema: Value =
        serde_json::from_str(include_str!("../../contracts/v1/capabilities.schema.json")).unwrap();
    let validator = jsonschema::validator_for(&schema).unwrap();
    for (name, facts) in fixtures()
        .into_iter()
        .filter(|(name, _)| matches!(*name, "x11-empty" | "x11-xdotool-only"))
    {
        let r = report(&facts);
        let errors: Vec<_> = validator
            .iter_errors(&r)
            .map(|error| error.to_string())
            .collect();
        assert!(errors.is_empty(), "{name}: {errors:?}");
        for action in ["inspect", "screenshot"] {
            assert_eq!(
                r["actions"][action]["state"], "unsupported",
                "{name}/{action}"
            );
            for v in r["actions"][action]["variants"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|v| !v["mode"].is_null())
            {
                assert_eq!(v["state"], "unsupported", "{name}/{action}/{v}");
                assert_eq!(
                    v["reasonCodes"],
                    json!(["HELPER_MISSING"]),
                    "{name}/{action}/{v}"
                );
            }
        }
        assert_eq!(
            r["actions"]["click"]["state"],
            if name == "x11-empty" {
                "unsupported"
            } else {
                "unverified"
            }
        );
        assert_eq!(r["actions"]["doctor"]["state"], "available");
    }
}

#[test]
fn grim_unknown_build_never_advertises_jpeg_in_an_available_variant() {
    let (_, facts) = fixtures()
        .into_iter()
        .find(|(name, _)| *name == "wayland-advertised")
        .unwrap();
    let r = report(&facts);
    let screen: Vec<_> = r["actions"]["screenshot"]["variants"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|v| v["mode"] == "screen")
        .collect();
    let available: Vec<_> = screen
        .iter()
        .filter(|v| v["state"] == "available")
        .collect();
    assert_eq!(available.len(), 1);
    assert_eq!(
        available[0]["limits"]["parameters"]["format"]["values"],
        json!(["png"])
    );
    let jpeg = screen
        .iter()
        .find(|v| v["limits"]["parameters"]["format"]["values"] == json!(["jpg"]))
        .expect("separate encoding-specific JPEG variant");
    assert_eq!(jpeg["state"], "unverified");
    assert_eq!(jpeg["reasonCodes"], json!(["ENCODING_SUPPORT_UNVERIFIED"]));
    assert_eq!(
        jpeg["limits"]["parameters"]["format"]["knowledge"],
        "unknown"
    );
    assert!(jpeg["limits"]["constraints"]
        .as_array()
        .unwrap()
        .contains(&json!("GRIM_JPEG_BUILD_SUPPORT_REQUIRED")));
}

#[test]
fn grim_encoding_support_is_separate_and_cannot_override_capture_prerequisites() {
    let schema: Value =
        serde_json::from_str(include_str!("../../contracts/v1/capabilities.schema.json")).unwrap();
    for (name, mut facts) in fixtures()
        .into_iter()
        .filter(|(name, _)| name.starts_with("wayland-grim-jpeg-"))
    {
        for prerequisites in [
            "ready",
            "missing-helper",
            "missing-protocol",
            "unknown-protocol",
        ] {
            match prerequisites {
                "missing-helper" => facts.tools.clear(),
                "missing-protocol" => {
                    facts.tools = vec!["grim".into()];
                    facts.protocols.capture = Some(false);
                }
                "unknown-protocol" => facts.protocols.capture = None,
                _ => (),
            }
            let r = report(&facts);
            assert!(jsonschema::is_valid(&schema, &r), "{name}/{prerequisites}");
            let screenshot = &r["actions"]["screenshot"];
            let jpeg = screenshot["variants"]
                .as_array()
                .unwrap()
                .iter()
                .find(|v| {
                    v["mode"] == "screen"
                        && v["limits"]["parameters"]["format"]["values"] == json!(["jpg"])
                })
                .expect("separate JPEG support state");
            let expected = if name == "wayland-grim-jpeg-disabled"
                || matches!(prerequisites, "missing-helper" | "missing-protocol")
            {
                "unsupported"
            } else if prerequisites == "unknown-protocol" {
                "unverified"
            } else {
                "available"
            };
            assert_eq!(jpeg["state"], expected, "{name}/{prerequisites}");
            assert_eq!(jpeg["limits"]["parameters"]["format"]["knowledge"], "known");
            if name == "wayland-grim-jpeg-disabled" {
                assert!(jpeg["reasonCodes"]
                    .as_array()
                    .unwrap()
                    .contains(&json!("ENCODING_BUILD_DISABLED")));
            }
            for v in screenshot["variants"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|v| matches!(v["mode"].as_str(), Some("window" | "frontmost")))
            {
                assert_eq!(v["state"], "unsupported", "{name}/{prerequisites}");
            }
            assert!(r["actions"]["inspect"]["variants"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|v| !v["mode"].is_null())
                .all(|v| v["limits"]["parameters"]["format"]["values"] == json!(["png"])));
        }
    }
}

#[test]
fn wtype_protocol_denial_is_not_mislabeled_as_an_alternate_provider() {
    let (_, mut facts) = fixtures()
        .into_iter()
        .find(|(name, _)| *name == "wayland-unavailable")
        .unwrap();
    for action in ["type-text", "keypress", "scroll"] {
        let r = report(&facts);
        assert_eq!(
            r["actions"][action]["variants"][0]["reasonCodes"],
            json!(["PROTOCOL_UNAVAILABLE"])
        );
    }
    facts.tools.push("ydotool".into());
    for action in ["type-text", "keypress", "scroll"] {
        let r = report(&facts);
        assert_eq!(
            r["actions"][action]["variants"][0]["reasonCodes"],
            json!(["PROTOCOL_UNAVAILABLE", "PROVIDER_NOT_SELECTED"])
        );
        assert_eq!(r["actions"][action]["variants"][1]["state"], "unverified");
    }
}

#[test]
fn geometry_evidence_distinguishes_x11_input_bounds_from_capture_qualification() {
    let (_, facts) = fixtures()
        .into_iter()
        .find(|(name, _)| *name == "x11")
        .unwrap();
    let r = report(&facts);
    let geometry = |action: &str| {
        r["actions"][action]["evidence"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["kind"] == "geometry")
            .unwrap()
    };
    assert_eq!(
        geometry("click")["scope"],
        "current-x11-root-extent-and-signed-16-bit-input-bounds; not-probed"
    );
    assert_eq!(
        geometry("screenshot")["scope"],
        "version-qualified-stable-geometry-required; see-image-geometry-contract"
    );
    assert_eq!(geometry("click")["status"], "not-run");
}

#[test]
fn wayland_advertisement_never_expands_capture_or_proves_ydotool_effects() {
    for (name, facts) in fixtures().into_iter().filter(|(name, _)| {
        matches!(
            *name,
            "wayland-advertised" | "wayland-unavailable" | "wayland-unknown"
        )
    }) {
        let r = report(&facts);
        let state = match name {
            "wayland-advertised" => "available",
            "wayland-unavailable" => "unsupported",
            _ => "unverified",
        };
        assert_eq!(r["actions"]["screenshot"]["state"], state);
        assert_eq!(
            r["actions"]["screenshot"]["variants"][1]["state"],
            "unsupported"
        );
        assert_eq!(
            r["actions"]["screenshot"]["variants"][2]["state"],
            "unsupported"
        );
        assert_eq!(
            r["actions"]["type-text"]["variants"][0]["state"],
            if name == "wayland-unknown" {
                "unsupported"
            } else {
                state
            }
        );
        assert_eq!(
            r["actions"]["type-text"]["variants"][1]["state"],
            if name == "wayland-unknown" {
                "unverified"
            } else {
                "unsupported"
            }
        );
        assert_eq!(
            r["actions"]["scroll"]["variants"][0]["state"],
            "unsupported"
        );
        assert_eq!(
            r["actions"]["type-text"]["variants"][1]["limits"]["parameters"]["text"]["encoding"],
            "ascii"
        );
        let scroll = &r["actions"]["scroll"]["variants"][1]["limits"]["parameters"];
        assert_eq!(scroll["amount"]["maximum"], 50);
        assert_eq!(
            scroll["direction"]["values"],
            json!(["up", "down", "left", "right"])
        );
        let tokens =
            &r["actions"]["keypress"]["variants"][1]["limits"]["parameters"]["keyToken"]["values"];
        assert!(tokens.as_array().unwrap().contains(&json!("enter")));
        assert!(!tokens.as_array().unwrap().contains(&json!("f12")));
        for token in tokens.as_array().unwrap() {
            assert!(linux_capabilities::evdev_args(token.as_str().unwrap()).is_some());
        }
        assert_eq!(
            r["actions"]["click"]["state"],
            if name == "wayland-unavailable" {
                "unsupported"
            } else {
                "unverified"
            }
        );
        assert_eq!(
            r["actions"]["focus"]["state"],
            if name == "wayland-advertised" {
                "unverified"
            } else {
                "unsupported"
            }
        );
    }
}

#[test]
fn granted_permissions_still_do_not_prove_macos_actions_or_unknown_provider_versions() {
    for (name, facts) in fixtures()
        .into_iter()
        .filter(|(name, _)| name.starts_with("macos") || *name == "missing-helper")
    {
        let r = report(&facts);
        assert_eq!(
            r["actions"]["click"]["state"],
            if name == "missing-helper" {
                "unsupported"
            } else {
                "unverified"
            }
        );
        assert_eq!(
            r["actions"]["screenshot"]["variants"][0]["provider"]["version"],
            Value::Null
        );
        assert_eq!(
            r["actions"]["inspect"]["variants"][0]["limits"]["parameters"]["format"]["values"],
            json!(["png"])
        );
        if name == "macos-permission-denied" {
            assert_eq!(
                r["actions"]["click"]["reasonCodes"],
                json!(["PERMISSION_DENIED"])
            );
        }
    }
}

#[test]
fn no_display_does_not_erase_host_implementation_or_claim_cli_host_dispatch() {
    for (_, facts) in fixtures()
        .into_iter()
        .filter(|(_, facts)| facts.session.is_none() && facts.platform != "macos")
    {
        let r = report(&facts);
        assert_eq!(r["actions"]["doctor"]["state"], "available");
        assert_eq!(r["actions"]["screenshot"]["state"], "unsupported");
        for name in ["stop", "file-list", "file-read", "file-write"] {
            assert_eq!(r["actions"][name]["state"], "unsupported");
            assert_eq!(r["actions"][name]["surfaces"], json!(["plugin"]));
            assert_eq!(r["actions"][name]["evidence"][0]["status"], "passed");
        }
    }
}
