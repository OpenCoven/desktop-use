//! Versioned CLI discovery. Inventory/protocol/permission facts never prove input effects.
use super::*;
use serde_json::{json, Map, Value};

const ACTIONS: &str = include_str!("../contracts/v1/canonical-actions.json");

pub struct Facts {
    pub platform: &'static str,
    pub session: Option<LinuxSession>,
    pub tools: Vec<String>,
    pub protocols: linux_capabilities::Protocols,
    pub sway_socket: bool,
    pub permission: &'static str,
    pub observed_at_ms: Option<u64>,
}

fn provider(name: &str) -> Value {
    json!({"name":name,"version":if name == "coven-desktop-use" { Some(VERSION) } else { None }})
}

fn evidence(kind: &str, status: &str, scope: &str, name: &str, time: Option<u64>) -> Value {
    let mut v = json!({"kind":kind,"status":status,"scope":scope,"provider":provider(name)});
    if let Some(time) = time {
        v["observedAtMs"] = json!(time);
    }
    v
}

fn variant(
    mode: Option<&str>,
    selectors: &[&str],
    name: &str,
    state: &str,
    reasons: &[&str],
    constraints: &[&str],
    parameters: Value,
) -> Value {
    json!({"mode":mode,"selectors":selectors,"provider":provider(name),"state":state,"reasonCodes":reasons,"limits":{"constraints":constraints,"parameters":parameters}})
}

impl Facts {
    fn has(&self, name: &str) -> bool {
        self.tools.iter().any(|tool| tool == name)
    }
    fn binary_state(&self, name: &str) -> &'static str {
        if self.has(name) {
            "available"
        } else {
            "unsupported"
        }
    }
    fn prerequisites(&self, name: &str, protocol: Option<bool>) -> &'static str {
        if !self.has(name) || protocol == Some(false) {
            "unsupported"
        } else if protocol == Some(true) {
            "available"
        } else {
            "unverified"
        }
    }
}

pub fn report(facts: &Facts) -> Value {
    let names: Vec<String> = serde_json::from_str(ACTIONS).expect("generated canonical actions");
    let mut actions = Map::new();
    for name in names {
        let cli = matches!(
            name.as_str(),
            "doctor"
                | "inspect"
                | "screenshot"
                | "click"
                | "type-text"
                | "keypress"
                | "scroll"
                | "focus"
        );
        let approval = match name.as_str() {
            "doctor" | "health" | "stop" => "none",
            "inspect" | "screenshot" | "file-list" | "file-read" => "request-dependent",
            _ => "required",
        };
        let mut action = json!({
            "surfaces": if cli { vec!["cli","plugin"] } else { vec!["plugin"] },
            "state":"unsupported", "reasonCodes":["SURFACE_UNAVAILABLE"], "variants":[],
            "evidence":[evidence("implementation","passed",if cli { "cli-and-plugin-dispatch" } else { "plugin-dispatch-only" },"coven-desktop-use",None)],
            "policy":{"profile":"unknown","approval":approval,"gatewayPolicy":"not-reported"}
        });
        if cli {
            action["reasonCodes"] = json!([]);
            if name == "doctor" {
                action["state"] = json!("available");
                action["variants"] = json!([variant(
                    None,
                    &[],
                    "coven-desktop-use",
                    "available",
                    &[],
                    &["OBSERVATIONAL_ONLY"],
                    json!({"timeoutMs":{"minimum":1000,"maximum":120000,"units":"milliseconds"}})
                )]);
            } else if facts.platform == "macos" {
                macos_action(&name, facts, &mut action);
            } else if facts.platform == "linux" && facts.session.is_some() {
                linux_action(&name, facts, &mut action);
            } else {
                action["reasonCodes"] = json!([if facts.platform == "linux" {
                    "NO_DISPLAY_SESSION"
                } else {
                    "PLATFORM_UNSUPPORTED"
                }]);
            }
        }
        action["evidence"].as_array_mut().unwrap().push(evidence(
            "actual-action",
            "not-run",
            "no-desktop-action-during-discovery",
            "coven-desktop-use",
            None,
        ));
        actions.insert(name, action);
    }
    json!({"schemaVersion":1,"producer":{"name":"coven-desktop-use","version":VERSION,"surface":"cli"},"environment":{"platform":facts.platform,"session":facts.session.map(LinuxSession::label)},"actions":actions})
}

fn image_limits(inspect: bool) -> Value {
    json!({"format":{"values":if inspect { vec!["png"] } else { vec!["png","jpg"] }},"image":{"maxBytes":observation::MAX_ENCODED,"maxWidth":observation::MAX_DIMENSION,"maxHeight":observation::MAX_DIMENSION,"maxPixels":observation::MAX_PIXELS,"maxDecodedBytes":observation::MAX_ALLOCATION}})
}

fn macos_action(name: &str, facts: &Facts, action: &mut Value) {
    let state = if !facts.has("peekaboo") {
        "unsupported"
    } else {
        "unverified"
    };
    let reason = if !facts.has("peekaboo") {
        "HELPER_MISSING"
    } else if facts.permission == "failed" {
        "PERMISSION_DENIED"
    } else {
        "BACKEND_ACCESS_UNVERIFIED"
    };
    let mut variants = Vec::new();
    let targets = &["app", "windowTitle", "windowId"];
    if matches!(name, "inspect" | "screenshot") {
        for mode in ["screen", "window", "frontmost"] {
            variants.push(variant(
                Some(mode),
                targets,
                "peekaboo",
                state,
                &[reason],
                &[
                    "PROVIDER_VERSION_UNKNOWN",
                    "CAPTURE_SCOPE_UNVERIFIED",
                    "COORDINATE_MAPPING_REQUIRES_GEOMETRY_RECEIPT",
                ],
                image_limits(name == "inspect"),
            ));
        }
        variants.push(variant(
            Some("screen"),
            &["screenIndex"],
            "peekaboo",
            state,
            &[reason],
            &[
                "PROVIDER_VERSION_UNKNOWN",
                "COORDINATE_MAPPING_REQUIRES_GEOMETRY_RECEIPT",
            ],
            image_limits(name == "inspect"),
        ));
    } else {
        let selectors = match name {
            "click" => vec!["app", "windowTitle", "windowId", "coords", "on", "query"],
            "scroll" => vec!["app", "windowTitle", "windowId", "on"],
            _ => targets.to_vec(),
        };
        variants.push(variant(
            None,
            &selectors,
            "peekaboo",
            state,
            &[reason],
            &["PROVIDER_VERSION_UNKNOWN", "DESKTOP_EFFECT_UNVERIFIED"],
            json!({}),
        ));
    }
    action["state"] = json!(state);
    action["reasonCodes"] = json!([reason]);
    action["variants"] = json!(variants);
    let evidence_items = action["evidence"].as_array_mut().unwrap();
    evidence_items.push(evidence(
        "binary",
        if facts.has("peekaboo") {
            "passed"
        } else {
            "failed"
        },
        "executable-on-path-only",
        "peekaboo",
        facts.observed_at_ms,
    ));
    evidence_items.push(evidence(
        "permission",
        facts.permission,
        "macos-privacy-grants; grants-do-not-prove-action",
        "peekaboo",
        facts.observed_at_ms,
    ));
}

fn linux_action(name: &str, facts: &Facts, action: &mut Value) {
    let wayland = facts.session == Some(LinuxSession::Wayland);
    let mut variants = Vec::new();
    if matches!(name, "inspect" | "screenshot") {
        let capture = if wayland {
            "grim"
        } else if facts.has("scrot") {
            "scrot"
        } else {
            "maim"
        };
        let state = if wayland {
            facts.prerequisites(capture, facts.protocols.capture)
        } else {
            facts.binary_state(capture)
        };
        for mode in ["screen", "window", "frontmost"] {
            let mut state = state;
            let mut reasons = Vec::new();
            let mut constraints = vec![
                "DISPLAY_ACCESS_UNVERIFIED",
                "COORDINATE_MAPPING_REQUIRES_GEOMETRY_RECEIPT",
            ];
            if wayland && mode != "screen" {
                state = "unsupported";
                reasons.push("CAPTURE_MODE_UNSUPPORTED");
            } else if !facts.has(capture) {
                reasons.push("HELPER_MISSING");
            } else if wayland && facts.protocols.capture == Some(false) {
                reasons.push("PROTOCOL_UNAVAILABLE");
            } else if wayland && facts.protocols.capture.is_none() {
                reasons.push("PROTOCOL_UNVERIFIED");
            }
            if !wayland && capture == "maim" && mode != "screen" {
                constraints.push("SUCCESSFUL_NUMERIC_ACTIVE_WINDOW_LOOKUP_REQUIRED");
                if !facts.has("xdotool") {
                    state = "unsupported";
                    reasons.push("HELPER_MISSING");
                } else {
                    state = "unverified";
                    reasons.push("ACTIVE_WINDOW_LOOKUP_NOT_RUN");
                }
            }
            if name == "inspect" {
                constraints.push("NO_SEMANTIC_ELEMENT_IDS");
                if state == "available" {
                    state = "degraded";
                }
            }
            variants.push(variant(
                Some(mode),
                &[],
                capture,
                state,
                &reasons,
                &constraints,
                image_limits(name == "inspect"),
            ));
        }
    } else if !wayland {
        if name == "focus" {
            for (helper, selectors, constraints) in [
                (
                    "wmctrl",
                    vec!["app", "windowTitle", "windowId"],
                    vec!["COMBINED_SELECTORS", "UNAMBIGUOUS_MATCH_REQUIRED"],
                ),
                ("xdotool", vec!["app"], vec!["SINGLE_SELECTOR_ONLY"]),
                ("xdotool", vec!["windowTitle"], vec!["SINGLE_SELECTOR_ONLY"]),
                ("xdotool", vec!["windowId"], vec!["SINGLE_SELECTOR_ONLY"]),
            ] {
                variants.push(variant(
                    None,
                    &selectors,
                    helper,
                    if helper == "xdotool" && facts.has("wmctrl") {
                        "unsupported"
                    } else {
                        facts.binary_state(helper)
                    },
                    if helper == "xdotool" && facts.has("wmctrl") {
                        &["PROVIDER_NOT_SELECTED"][..]
                    } else {
                        &[]
                    },
                    &constraints,
                    json!({}),
                ));
            }
        } else {
            let (selectors, mut constraints, params) = if name == "click" {
                (
                    vec!["coords"],
                    vec![
                        "CURRENT_ROOT_EXTENT_REQUIRED",
                        "SIGNED_I32_COORDINATE_SYNTAX",
                    ],
                    json!({"coords":{"minimum":0,"maximum":32767,"units":"desktop-pixels"}}),
                )
            } else {
                (vec![], vec![], json!({}))
            };
            constraints.push("DISPLAY_ACCESS_UNVERIFIED");
            variants.push(variant(
                None,
                &selectors,
                "xdotool",
                if name == "click" && facts.has("xdotool") {
                    "unverified"
                } else {
                    facts.binary_state("xdotool")
                },
                &[],
                &constraints,
                params,
            ));
        }
    } else {
        let keyboard = facts.prerequisites("wtype", facts.protocols.keyboard);
        match name {
            "focus" => variants.push(variant(
                None,
                &["app", "windowTitle", "windowId"],
                "swaymsg",
                if facts.has("swaymsg") && facts.sway_socket {
                    "unverified"
                } else {
                    "unsupported"
                },
                &["SWAY_IPC_ACCESS_UNVERIFIED"],
                &[
                    "SWAY_ONLY",
                    "SWAYSOCK_REQUIRED",
                    "COMBINED_LITERAL_SELECTORS",
                    "NUMERIC_WINDOW_ID",
                    "IPC_SUCCESS_REQUIRED",
                ],
                json!({}),
            )),
            "click" => variants.push(variant(
                None,
                &["coords"],
                "ydotool",
                if facts.has("ydotool") {
                    "unverified"
                } else {
                    "unsupported"
                },
                &["POINTER_MAPPING_UNVERIFIED"],
                &[
                    "YDOTOOLD_UINPUT_REQUIRED",
                    "DEBIAN_YDOTOOL_1_0_4_REGISTERED_PATH",
                    "SWAY_1_7_ENDPOINT_IDENTITY_REQUIRED",
                    "SINGLE_SCALE_1_OUTPUT_AT_ORIGIN",
                    "REGISTERED_VIRTUAL_POINTER_REQUIRED",
                    "FLAT_ACCELERATION_SPEED_ZERO",
                    "IN_BOUNDS_TARGET_REQUIRED",
                    "NO_NEGATIVE_OR_MIXED_SCALE_MAPPING",
                ],
                json!({"coords":{"minimum":0,"maximum":2147483647,"units":"desktop-pixels"}}),
            )),
            "type-text" | "keypress" | "scroll" => {
                let fallback = name == "scroll";
                let wtype_selected = facts.has("wtype")
                    && facts.protocols.keyboard != Some(false)
                    && (facts.protocols.keyboard == Some(true) || !facts.has("ydotool"))
                    && (!fallback || !facts.has("ydotool"));
                variants.push(variant(
                    None,
                    &[],
                    "wtype",
                    if !wtype_selected {
                        "unsupported"
                    } else if fallback && keyboard == "available" {
                        "degraded"
                    } else {
                        keyboard
                    },
                    if !wtype_selected && facts.has("wtype") {
                        &["PROVIDER_NOT_SELECTED"][..]
                    } else {
                        &[]
                    },
                    if fallback {
                        &[
                            "PAGE_ARROW_KEY_FALLBACK",
                            "AMOUNT_COUNTS_KEYPRESSES",
                            "VIRTUAL_KEYBOARD_PROTOCOL_REQUIRED",
                        ][..]
                    } else {
                        &["VIRTUAL_KEYBOARD_PROTOCOL_REQUIRED", "KEYSYMS_AND_CHORDS"][..]
                    },
                    if name == "type-text" {
                        json!({"text":{"encoding":"utf-8"}})
                    } else {
                        json!({})
                    },
                ));
                let mut constraints = vec![
                    "YDOTOOLD_UINPUT_REQUIRED",
                    "ACTIVE_KEYBOARD_LAYOUT",
                    "NO_AUTOMATIC_INPUT_REPLAY",
                ];
                let params = if name == "type-text" {
                    constraints.push("LITERAL_BACKSLASH_ESCAPES_DISABLED");
                    json!({"text":{"encoding":"ascii"}})
                } else if name == "keypress" {
                    constraints.push("COMMON_EVDEV_KEYS_ONLY");
                    json!({"keys":{"knowledge":"unknown"}})
                } else {
                    constraints.push("WHEEL_EVENTS");
                    json!({})
                };
                variants.push(variant(
                    None,
                    &[],
                    "ydotool",
                    if facts.has("ydotool") && !wtype_selected {
                        "unverified"
                    } else {
                        "unsupported"
                    },
                    if wtype_selected && facts.has("ydotool") {
                        &["PROVIDER_NOT_SELECTED"][..]
                    } else {
                        &[]
                    },
                    &constraints,
                    params,
                ));
            }
            _ => unreachable!(),
        }
    }
    // Linux never accepts these selectors on non-focus requests; do not let a coarse ready state imply them.
    if name != "focus" {
        variants.push(variant(
            None,
            &[
                "app",
                "windowTitle",
                "windowId",
                "screenIndex",
                "on",
                "query",
            ],
            "linux",
            "unsupported",
            &["SELECTOR_UNSUPPORTED"],
            &["NO_SEMANTIC_ELEMENT_IDS"],
            json!({}),
        ));
    }
    if name == "scroll" {
        for v in &mut variants {
            v["limits"]["parameters"]["amount"] = json!({"minimum":1,"maximum":50,"units":if v["provider"]["name"]=="wtype" {"key-presses"} else {"wheel-steps"}});
            v["limits"]["parameters"]["direction"] = json!({"values":["up","down","left","right"]});
        }
    }
    if name == "keypress" && wayland {
        for v in &mut variants {
            if v["provider"]["name"] == "ydotool" {
                v["limits"]["parameters"]
                    .as_object_mut()
                    .unwrap()
                    .remove("keys");
                v["limits"]["parameters"]["keyToken"] = json!({"values":linux_capabilities::evdev_key_names(),"units":"case-insensitive-chord-token"});
                v["limits"]["constraints"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!("CHORDS_FROM_LISTED_KEY_TOKENS"));
            }
        }
    }
    let state = ["available", "degraded", "unverified", "unsupported"]
        .into_iter()
        .find(|state| variants.iter().any(|v| v["state"] == *state))
        .unwrap_or("unsupported");
    action["state"] = json!(state);
    action["reasonCodes"] = json!(if state == "unsupported" {
        vec!["BACKEND_UNAVAILABLE"]
    } else if state == "unverified" {
        vec!["BACKEND_ACCESS_UNVERIFIED"]
    } else if name == "inspect" {
        vec!["NO_SEMANTIC_ELEMENT_IDS"]
    } else {
        vec![]
    });
    let evidence_items = action["evidence"].as_array_mut().unwrap();
    let mut providers = std::collections::BTreeSet::new();
    for v in &variants {
        let helper = v["provider"]["name"].as_str().unwrap();
        if helper != "linux" && providers.insert(helper) {
            evidence_items.push(evidence(
                "binary",
                if facts.has(helper) {
                    "passed"
                } else {
                    "failed"
                },
                "executable-on-path-only",
                helper,
                facts.observed_at_ms,
            ));
        }
    }
    evidence_items.push(evidence(
        "permission",
        "unknown",
        "display-daemon-uinput-access; not-probed",
        "linux",
        None,
    ));
    if wayland
        && matches!(
            name,
            "inspect" | "screenshot" | "type-text" | "keypress" | "scroll"
        )
    {
        let capture = matches!(name, "inspect" | "screenshot");
        let p = if capture {
            facts.protocols.capture
        } else {
            facts.protocols.keyboard
        };
        evidence_items.push(evidence(
            "protocol",
            match p {
                Some(true) => "passed",
                Some(false) => "failed",
                None => "unknown",
            },
            if capture {
                "wlr-screencopy; ext-only-helper-compatibility-unverified"
            } else {
                "zwp_virtual_keyboard_manager_v1"
            },
            "wayland-info",
            facts.observed_at_ms,
        ));
    }
    if name == "click" || matches!(name, "inspect" | "screenshot") {
        evidence_items.push(evidence(
            "geometry",
            "not-run",
            "version-qualified-stable-geometry-required; see-image-geometry-contract",
            "linux",
            None,
        ));
    }
    action["variants"] = json!(variants);
}

pub fn discover(platform: Platform) -> Facts {
    let session = match platform {
        Platform::LinuxX11 => Some(LinuxSession::X11),
        Platform::LinuxWayland => Some(LinuxSession::Wayland),
        _ => None,
    };
    let tools = if let Some(session) = session {
        linux_tool_inventory(session)
            .into_iter()
            .filter(|t| t.found)
            .map(|t| t.name.to_owned())
            .collect()
    } else if platform == Platform::Macos && resolve_path_binary("peekaboo").is_some() {
        vec!["peekaboo".into()]
    } else {
        vec![]
    };
    Facts {
        platform: match platform {
            Platform::Macos => "macos",
            Platform::LinuxX11 | Platform::LinuxWayland | Platform::LinuxNoDisplay => "linux",
            Platform::Other if cfg!(target_os = "windows") => "windows",
            _ => "other",
        },
        session,
        tools,
        protocols: linux_capabilities::Protocols::default(),
        sway_socket: env::var_os("SWAYSOCK").is_some(),
        permission: "unknown",
        observed_at_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .ok()
            .map(|d| d.as_millis() as u64),
    }
}

pub fn attach(result: String, facts: &Facts) -> String {
    let mut value: Value = serde_json::from_str(&result).expect("adapter JSON envelope");
    value["capabilitiesV1"] = report(facts);
    value.to_string()
}

#[cfg(test)]
mod tests;
