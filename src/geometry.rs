//! Evidence-bound geometry. Provider output never authorizes filesystem reads.
//! Probes bracket capture; equality is a bounded stability check, not an atomic
//! compositor snapshot (a layout that changes and changes back is undetectable).
use serde_json::{json, Value};
use std::process::Command;
use std::time::{Duration, Instant};

#[derive(Clone, Debug, PartialEq)]
struct Rect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}
impl Rect {
    fn new(x: f64, y: f64, width: f64, height: f64) -> Option<Self> {
        let r = Self {
            x,
            y,
            width,
            height,
        };
        [x, y, width, height, x + width, y + height]
            .iter()
            .all(|n| n.is_finite() && *n >= i32::MIN as f64 && *n <= i32::MAX as f64)
            .then_some(())?;
        (width > 0.0 && height > 0.0).then_some(r)
    }
    fn parse(v: &Value) -> Option<Self> {
        Self::new(
            v["x"].as_f64()?,
            v["y"].as_f64()?,
            v["width"].as_f64()?,
            v["height"].as_f64()?,
        )
    }
    fn json(&self) -> Value {
        json!({"x":self.x,"y":self.y,"width":self.width,"height":self.height})
    }
    fn overlaps(&self, b: &Self) -> bool {
        self.x < b.x + b.width
            && b.x < self.x + self.width
            && self.y < b.y + b.height
            && b.y < self.y + self.height
    }
}
fn available(units: &str, regions: Vec<Value>) -> Value {
    json!({"state":"available","coordinateUnits":units,"regions":regions})
}
fn sway_layout(version: &str, input: &Value) -> Option<(Vec<(String, Rect)>, f64, Rect)> {
    if version != "1.7" {
        return None;
    }
    let outputs = input.as_array()?;
    if outputs.is_empty() || outputs.len() > 32 {
        return None;
    }
    let mut regions: Vec<(String, Rect)> = Vec::new();
    let mut scale: f64 = 1.0;
    for o in outputs {
        if o["active"].as_bool()? == false {
            continue;
        }
        // Other transforms/fractional scaling need their own runtime qualification.
        if o["transform"] != "normal" {
            return None;
        }
        let s = o["scale"].as_f64()?;
        if !(1.0..=4.0).contains(&s) || s.fract() != 0.0 {
            return None;
        }
        scale = scale.max(s);
        let name = o["name"].as_str()?;
        if name.is_empty() || name.len() > 256 {
            return None;
        }
        let rect = Rect::parse(&o["rect"])?;
        if [rect.x, rect.y, rect.width, rect.height]
            .iter()
            .any(|n| n.fract() != 0.0)
            || regions.iter().any(|(n, r)| n == name || r.overlaps(&rect))
        {
            return None;
        }
        regions.push((name.into(), rect));
    }
    let min_x = regions.iter().map(|(_, r)| r.x).reduce(f64::min)?;
    let min_y = regions.iter().map(|(_, r)| r.y).reduce(f64::min)?;
    let max_x = regions
        .iter()
        .map(|(_, r)| r.x + r.width)
        .reduce(f64::max)?;
    let max_y = regions
        .iter()
        .map(|(_, r)| r.y + r.height)
        .reduce(f64::max)?;
    let bounds = Rect::new(min_x, min_y, max_x - min_x, max_y - min_y)?;
    if bounds.width * scale > 16384.0
        || bounds.height * scale > 16384.0
        || bounds.width * bounds.height * scale * scale > 64000000.0
    {
        return None;
    }
    Some((regions, scale, bounds))
}
fn normalize(
    producer: &str,
    version: &str,
    input: &Value,
    width: u32,
    height: u32,
) -> Option<Value> {
    match producer {
        "xwininfo-root" | "xwininfo-window" => {
            if version != "1.1.5" {
                return None;
            }
            let r = x11_rect(input["info"].as_str()?, producer == "xwininfo-root")?;
            if r.width != width as f64 || r.height != height as f64 {
                return None;
            }
            Some(available(
                "desktop-physical-pixels",
                vec![
                    json!({"imageRect":{"x":0,"y":0,"width":width,"height":height},"desktopRect":r.json()}),
                ],
            ))
        }
        "sway" => {
            let (regions, scale, bounds) = sway_layout(version, input)?;
            if bounds.width * scale != width as f64 || bounds.height * scale != height as f64 {
                return None;
            }
            Some(available("desktop-logical-pixels",regions.iter().map(|(name,r)| json!({"displayId":name,"desktopRect":r.json(),"imageRect":{"x":(r.x-bounds.x)*scale,"y":(r.y-bounds.y)*scale,"width":r.width*scale,"height":r.height*scale}})).collect()))
        }
        "peekaboo-coordinate-context" => {
            if version != "1"
                || input["version"] != 1
                || input["logical_space"] != "global_display_points"
                || input["origin"] != "top_left"
            {
                return None;
            }
            let size = input["delivered_image_size"].as_array()?;
            if size.len() != 2
                || size[0].as_f64()? != width as f64
                || size[1].as_f64()? != height as f64
            {
                return None;
            }
            let b = input["logical_bounds"].as_array()?;
            if b.len() != 2 || b[0].as_array()?.len() != 2 || b[1].as_array()?.len() != 2 {
                return None;
            }
            let r = Rect::new(
                b[0][0].as_f64()?,
                b[0][1].as_f64()?,
                b[1][0].as_f64()?,
                b[1][1].as_f64()?,
            )?;
            let scale = input["output_scale"].as_f64()?;
            if scale <= 0.0 || r.width * scale != width as f64 || r.height * scale != height as f64
            {
                return None;
            }
            let mut region = json!({"desktopRect":r.json(),"imageRect":{"x":0,"y":0,"width":width,"height":height}});
            // Only a single identified display or window is a uniform mapping.
            // A desktop mosaic without either identity needs piecewise evidence.
            if let Some(index) = input["display"]["index"].as_u64() {
                region["displayId"] = index.to_string().into();
            } else if input["window"]["window_id"].as_u64().is_none() {
                return None;
            }
            Some(available("macos-points", vec![region]))
        }
        _ => None,
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Snapshot {
    provider: String,
    provider_version: Option<String>,
    probe: String,
    probe_version: String,
    geometry: Value,
    pub scale: Option<f64>,
    width: u32,
    height: u32,
    target: Option<String>,
}
fn probe_output(program: &str, args: &[&str], end: Instant) -> Option<String> {
    crate::resolve_path_binary(program)?;
    let output =
        crate::process::run(Command::new(program).args(args).env("LC_ALL", "C"), end).ok()?;
    if !output.status.success() || output.stdout.len() > 65536 {
        return None;
    }
    Some(String::from_utf8(output.stdout).ok()?.trim().to_owned())
}
fn x11_rect(text: &str, root: bool) -> Option<Rect> {
    fn field(text: &str, key: &str) -> Option<f64> {
        let values: Vec<_> = text
            .lines()
            .filter_map(|l| l.trim().strip_prefix(key))
            .collect();
        if values.len() != 1 {
            return None;
        }
        values[0].trim().parse().ok()
    }
    let r = Rect::new(
        field(text, "Absolute upper-left X:")?,
        field(text, "Absolute upper-left Y:")?,
        field(text, "Width:")?,
        field(text, "Height:")?,
    )?;
    if field(text, "Border width:")? != 0.0
        || [r.x, r.y, r.width, r.height]
            .iter()
            .any(|n| n.fract() != 0.0)
        || (root && (r.x != 0.0 || r.y != 0.0 || !text.contains("(the root window)")))
    {
        return None;
    }
    Some(r)
}
pub fn probe(mode: &str) -> Option<Snapshot> {
    if !cfg!(target_os = "linux") || !["screen", "frontmost", "window"].contains(&mode) {
        return None;
    }
    // All probes share one small budget within the action deadline.
    let end = crate::deadline().min(Instant::now() + Duration::from_secs(2));
    match crate::detect_linux_session() {
        crate::Platform::LinuxX11 => {
            let (provider, version, expected) = if crate::resolve_path_binary("scrot").is_some() {
                ("scrot", "1.8.1", "scrot version 1.8.1")
            } else {
                ("maim", "5.7.4", "v5.7.4")
            };
            if probe_output(provider, &["--version"], end)? != expected
                || probe_output("xwininfo", &["-version"], end)? != "xwininfo 1.1.5"
            {
                return None;
            }
            let target = if mode == "screen" {
                None
            } else {
                let id = probe_output("xdotool", &["getactivewindow"], end)?;
                id.parse::<u64>().ok().filter(|n| *n > 0)?;
                Some(id)
            };
            let info = match &target {
                Some(id) => probe_output("xwininfo", &["-id", id], end)?,
                None => probe_output("xwininfo", &["-root"], end)?,
            };
            let r = x11_rect(&info, target.is_none())?;
            let probe = if target.is_none() {
                "xwininfo-root"
            } else {
                "xwininfo-window"
            };
            if r.width > 16384.0 || r.height > 16384.0 {
                return None;
            }
            Some(Snapshot {
                provider: provider.into(),
                provider_version: Some(version.into()),
                probe: probe.into(),
                probe_version: "1.1.5".into(),
                geometry: normalize(
                    probe,
                    "1.1.5",
                    &json!({"info":info}),
                    r.width as u32,
                    r.height as u32,
                )?,
                scale: None,
                width: r.width as u32,
                height: r.height as u32,
                target,
            })
        }
        crate::Platform::LinuxWayland => {
            if mode != "screen" {
                return None;
            }
            std::env::var_os("SWAYSOCK")?;
            if probe_output("swaymsg", &["-v"], end)? != "swaymsg version 1.7" {
                return None;
            }
            let input: Value =
                serde_json::from_str(&probe_output("swaymsg", &["-t", "get_outputs", "-r"], end)?)
                    .ok()?;
            let (_, scale, bounds) = sway_layout("1.7", &input)?;
            let (width, height) = (
                (bounds.width * scale) as u32,
                (bounds.height * scale) as u32,
            );
            Some(Snapshot {
                provider: "grim".into(),
                provider_version: None,
                probe: "sway".into(),
                probe_version: "1.7".into(),
                geometry: normalize("sway", "1.7", &input, width, height)?,
                scale: Some(scale),
                width,
                height,
                target: None,
            })
        }
        _ => None,
    }
}
pub fn attach(receipt: &mut Value, before: Option<Snapshot>, mode: &str, backend: &Value) {
    let width = receipt["primaryImage"]["sourceDimensions"]["width"]
        .as_u64()
        .unwrap() as u32;
    let height = receipt["primaryImage"]["sourceDimensions"]["height"]
        .as_u64()
        .unwrap() as u32;
    let provider = receipt["provider"]["name"].as_str().unwrap_or("");
    let geometry = if provider == "peekaboo" {
        // Exact CLI SeeResult path from pinned upstream source, never recursive
        // field discovery or a backend-supplied artifact path. Native acceptance
        // is still required for this versioned provider-receipt producer.
        normalize(
            "peekaboo-coordinate-context",
            "1",
            &backend["result"]["data"]["coordinate_context"],
            width,
            height,
        )
        .map(|g| (g, "provider-receipt", "peekaboo-coordinate-context", "1"))
    } else if let Some(ref b) = before {
        if b.provider != provider
            || b.width != width
            || b.height != height
            || probe(mode).as_ref() != Some(b)
        {
            None
        } else {
            receipt["provider"]["version"] = json!(b.provider_version);
            Some((
                b.geometry.clone(),
                "platform-probe",
                b.probe.as_str(),
                b.probe_version.as_str(),
            ))
        }
    } else {
        None
    };
    if let Some((mut g, kind, name, version)) = geometry {
        g["evidence"] = json!({"kind":kind,"provider":{"name":name,"version":version},"capturedAtMs":receipt["capturedAtMs"]});
        receipt["geometry"] = g;
    }
}
// XTest motion requests carry signed 16-bit root coordinates. Root coordinates
// are nonnegative; reject clipping/wrapping before synthesizing any event.
pub fn x11_point_in_root(x: i32, y: i32) -> bool {
    if !(0..=32767).contains(&x) || !(0..=32767).contains(&y) {
        return false;
    }
    let end = crate::deadline().min(Instant::now() + Duration::from_secs(2));
    let Some(raw) = probe_output("xdotool", &["getdisplaygeometry"], end) else {
        return false;
    };
    let dimensions: Vec<_> = raw.split_whitespace().collect();
    if dimensions.len() != 2 {
        return false;
    }
    match (dimensions[0].parse::<i32>(), dimensions[1].parse::<i32>()) {
        (Ok(w), Ok(h)) => x < w && y < h,
        _ => false,
    }
}
fn pointer_preconditions(
    version: &str,
    outputs: &Value,
    inputs: &Value,
    x: i32,
    y: i32,
) -> Option<()> {
    if version != "1.0.4" {
        return None;
    }
    let (regions, scale, bounds) = sway_layout("1.7", outputs)?;
    // ydotool --absolute is a relative reset followed by motion, not a global
    // compositor coordinate. No negative-origin/mixed-scale translation is
    // enabled without observed native effects. Preserve the established simple
    // origin only when all its concrete input preconditions are present.
    if regions.len() != 1
        || scale != 1.0
        || bounds.x != 0.0
        || bounds.y != 0.0
        || x < 0
        || y < 0
        || x as f64 >= bounds.width
        || y as f64 >= bounds.height
    {
        return None;
    }
    let pointers: Vec<_> = inputs
        .as_array()?
        .iter()
        .filter(|i| {
            i["type"] == "pointer" && i["identifier"] == "9011:26214:ydotoold_virtual_device"
        })
        .collect();
    if pointers.len() != 1
        || pointers[0]["libinput"]["accel_profile"] != "flat"
        || pointers[0]["libinput"]["accel_speed"].as_f64()? != 0.0
    {
        return None;
    }
    Some(())
}
pub fn wayland_pointer_ready(x: i32, y: i32) -> bool {
    fn check(x: i32, y: i32) -> Option<()> {
        let end = crate::deadline().min(Instant::now() + Duration::from_secs(2));
        // ydotool has no reliable --version CLI and older versions initialize
        // uinput even for help. Query package metadata without invoking input.
        let path = std::fs::canonicalize(crate::resolve_path_binary("ydotool")?).ok()?;
        if path != std::path::Path::new("/usr/bin/ydotool") {
            return None;
        }
        if probe_output("dpkg-query", &["-S", "/usr/bin/ydotool"], end)?
            != "ydotool: /usr/bin/ydotool"
        {
            return None;
        }
        let version = probe_output("dpkg-query", &["-W", "-f=${Version}", "ydotool"], end)?;
        let upstream = version.split('-').next()?;
        if upstream != "1.0.4" || probe_output("swaymsg", &["-v"], end)? != "swaymsg version 1.7" {
            return None;
        }
        std::env::var_os("SWAYSOCK")?;
        let outputs =
            serde_json::from_str(&probe_output("swaymsg", &["-t", "get_outputs", "-r"], end)?)
                .ok()?;
        let inputs =
            serde_json::from_str(&probe_output("swaymsg", &["-t", "get_inputs", "-r"], end)?)
                .ok()?;
        pointer_preconditions(upstream, &outputs, &inputs, x, y)
    }
    check(x, y).is_some()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_producers_preserve_negative_origins_and_mixed_display_regions() {
        let fixtures: Value = serde_json::from_str(include_str!(
            "../contracts/v1/fixtures/geometry/producers.json"
        ))
        .unwrap();
        for f in fixtures.as_array().unwrap() {
            let result = normalize(
                f["producer"].as_str().unwrap(),
                f["version"].as_str().unwrap(),
                &f["input"],
                f["raster"][0].as_u64().unwrap() as u32,
                f["raster"][1].as_u64().unwrap() as u32,
            )
            .expect("source-bound mapping");
            assert_eq!(result["coordinateUnits"], f["units"]);
            assert_eq!(
                result["regions"].as_array().unwrap().len(),
                f["regions"].as_array().unwrap().len()
            );
            for (actual, expected) in result["regions"]
                .as_array()
                .unwrap()
                .iter()
                .zip(f["regions"].as_array().unwrap())
            {
                assert_eq!(actual["displayId"], expected["displayId"]);
                for rect in ["imageRect", "desktopRect"] {
                    for field in ["x", "y", "width", "height"] {
                        assert_eq!(actual[rect][field].as_f64(), expected[rect][field].as_f64());
                    }
                }
            }
        }
    }
    #[test]
    fn pointer_preconditions_reject_unregistered_accelerated_or_unmapped_input() {
        let outputs = json!([{"name":"ONE","active":true,"rect":{"x":0,"y":0,"width":800,"height":600},"scale":1,"transform":"normal"}]);
        let inputs = json!([{"type":"pointer","identifier":"9011:26214:ydotoold_virtual_device","libinput":{"accel_profile":"flat","accel_speed":0.0}}]);
        assert!(pointer_preconditions("1.0.4", &outputs, &inputs, 80, 60).is_some());
        assert!(pointer_preconditions("0.1.8", &outputs, &inputs, 80, 60).is_none());
        assert!(pointer_preconditions("1.0.4", &outputs, &json!([]), 80, 60).is_none());
        assert!(pointer_preconditions("1.0.4", &outputs, &inputs, 800, 60).is_none());
        let mut accelerated = inputs.clone();
        accelerated[0]["libinput"]["accel_profile"] = "adaptive".into();
        assert!(pointer_preconditions("1.0.4", &outputs, &accelerated, 80, 60).is_none());
        let mut negative = outputs.clone();
        negative[0]["rect"]["x"] = (-800).into();
        assert!(pointer_preconditions("1.0.4", &negative, &inputs, -720, 60).is_none());
        let mut retina = outputs.clone();
        retina[0]["scale"] = 2.into();
        assert!(pointer_preconditions("1.0.4", &retina, &inputs, 80, 60).is_none());
    }
    #[test]
    fn x11_window_geometry_rejects_borders_duplicate_fields_and_partial_extents() {
        let fixtures: Value = serde_json::from_str(include_str!(
            "../contracts/v1/fixtures/geometry/producers.json"
        ))
        .unwrap();
        let text = fixtures[2]["input"]["info"].as_str().unwrap();
        for invalid in [
            text.replace("Border width: 0", "Border width: 2"),
            format!("{text}Width: 641\n"),
            text.replace("Width: 640", "Width: -1"),
        ] {
            assert!(normalize(
                "xwininfo-window",
                "1.1.5",
                &json!({"info":invalid}),
                640,
                480
            )
            .is_none());
        }
    }
    #[test]
    fn unknown_versions_mismatched_rasters_and_ambiguous_regions_stay_unavailable() {
        let fixtures: Value = serde_json::from_str(include_str!(
            "../contracts/v1/fixtures/geometry/producers.json"
        ))
        .unwrap();
        for f in fixtures.as_array().unwrap() {
            let (p, v) = (
                f["producer"].as_str().unwrap(),
                f["version"].as_str().unwrap(),
            );
            assert!(normalize(p, "999", &f["input"], 3200, 1200).is_none());
            assert!(normalize(p, v, &f["input"], 32, 24).is_none());
        }
        let mut layout = fixtures[0]["input"].clone();
        layout[1]["rect"]["x"] = 0.into();
        assert!(normalize("sway", "1.7", &layout, 1600, 1200).is_none());
        layout[1]["rect"]["width"] = (-1).into();
        assert!(normalize("sway", "1.7", &layout, 3200, 1200).is_none());
        let mut context = fixtures[1]["input"].clone();
        context["version"] = 2.into();
        assert!(normalize("peekaboo-coordinate-context", "1", &context, 3200, 1800).is_none());
    }
}
