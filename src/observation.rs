//! Bounded validation of the exact private capture, never a backend JSON path.
//! Decode/IO are bounded, synchronous work: Stop cannot preempt a syscall or an
//! individual decoder CPU step. Checks bracket each read, decode and publication.
use crate::process;
use image::{ImageDecoder, ImageFormat, ImageReader, Limits};
use jpeg_decoder::Decoder as JpegDecoder;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{Cursor, Read};
use std::path::Path;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

pub const MAX_ENCODED: usize = 8 * 1024 * 1024;
pub const MAX_DIMENSION: u32 = 16_384;
pub const MAX_PIXELS: u64 = 64_000_000;
pub const MAX_ALLOCATION: u64 = 256 * 1024 * 1024;

#[derive(Debug)]
pub enum Failure {
    Process(process::Failure),
    Missing,
    Invalid,
    Encoding,
    Limit,
}
impl Failure {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Process(error) => error.code(),
            Self::Missing => "CAPTURE_MISSING",
            Self::Invalid => "IMAGE_INVALID",
            Self::Encoding => "IMAGE_ENCODING_MISMATCH",
            Self::Limit => "IMAGE_LIMIT",
        }
    }
}
fn check(deadline: Instant) -> Result<(), Failure> {
    process::check(deadline).map_err(Failure::Process)
}

pub struct ValidatedCapture {
    pub mime: &'static str,
    pub byte_length: usize,
    pub width: u32,
    pub height: u32,
    pub sha256: String,
    identity: Metadata,
}
impl ValidatedCapture {
    /// Recheck the staged inode immediately before rename. This is not a sandbox
    /// against hostile concurrent same-user writers (nor is the approval layer).
    pub fn check_identity(&self, path: &Path, deadline: Instant) -> Result<(), Failure> {
        check(deadline)?;
        let current = fs::symlink_metadata(path).map_err(|_| Failure::Missing)?;
        if !current.is_file() || !same_file(&self.identity, &current) {
            return Err(Failure::Missing);
        }
        Ok(())
    }
    pub fn receipt(
        &self,
        provider: &str,
        requested_mode: &str,
        actual_mode: Option<&str>,
        annotation_requested: bool,
    ) -> Value {
        let dimensions = json!({"width":self.width,"height":self.height});
        let mut receipt = json!({
            "schemaVersion":1,
            "observationId":format!("observation-{}", crate::unique_suffix()),
            "capturedAtMs":SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64,
            "producer":{"name":"coven-desktop-use","version":crate::VERSION},
            "provider":{"name":provider,"version":Value::Null},
            "requestedScope":{"mode":requested_mode,"annotationRequested":annotation_requested},
            "actualScope": match actual_mode {
                Some(mode) => json!({"state":"available","mode":mode,"evidence":"PROVIDER_EXPLICIT_ARGUMENT"}),
                None => json!({"state":"unavailable","reasonCode":"PROVIDER_SCOPE_UNVERIFIED"}),
            },
            "primaryImage":{
                "mimeType":self.mime,"byteLength":self.byte_length,"sha256":self.sha256,
                "sourceDimensions":dimensions,"deliveredDimensions":dimensions,
                "annotationKind":if annotation_requested { "unverified" } else { "raw" },
            },
            "coordinateReference":{
                "units":"normalized","extent":{"x":0,"y":0,"width":1,"height":1},
                "sourceExtent":{"x":0,"y":0,"width":self.width,"height":self.height},
            },
            "geometry":{"state":"unavailable","reasonCode":"PROVIDER_GEOMETRY_UNVERIFIED"},
        });
        if annotation_requested {
            receipt["primaryImage"]["annotationReasonCode"] =
                "PROVIDER_ANNOTATION_UNVERIFIED".into();
        }
        receipt
    }
}

fn same_file(a: &Metadata, b: &Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        a.dev() == b.dev()
            && a.ino() == b.ino()
            && a.len() == b.len()
            && a.mtime() == b.mtime()
            && a.mtime_nsec() == b.mtime_nsec()
    }
    #[cfg(not(unix))]
    {
        a.len() == b.len() && a.modified().ok() == b.modified().ok()
    }
}

fn dimensions(width: u32, height: u32) -> Result<(), Failure> {
    if width == 0 || height == 0 {
        return Err(Failure::Invalid);
    }
    if width > MAX_DIMENSION
        || height > MAX_DIMENSION
        || u64::from(width) * u64::from(height) > MAX_PIXELS
    {
        return Err(Failure::Limit);
    }
    Ok(())
}
fn buffer(size: usize) -> Result<Vec<u8>, Failure> {
    if size as u64 > MAX_ALLOCATION {
        return Err(Failure::Limit);
    }
    let mut result = Vec::new();
    result.try_reserve_exact(size).map_err(|_| Failure::Limit)?;
    result.resize(size, 0);
    Ok(result)
}

pub fn validate_capture(
    path: &Path,
    format: &str,
    deadline: Instant,
) -> Result<ValidatedCapture, Failure> {
    check(deadline)?;
    let before = fs::symlink_metadata(path).map_err(|_| Failure::Missing)?;
    if !before.is_file() || before.len() == 0 {
        return Err(Failure::Missing);
    }
    if before.len() > MAX_ENCODED as u64 {
        return Err(Failure::Limit);
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let mut file: File = options.open(path).map_err(|_| Failure::Missing)?;
    let identity = file.metadata().map_err(|_| Failure::Missing)?;
    if !identity.is_file() || !same_file(&before, &identity) {
        return Err(Failure::Missing);
    }
    // One bounded snapshot supplies the decoder and digest. No second path read.
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(identity.len() as usize + 1)
        .map_err(|_| Failure::Limit)?;
    let mut chunk = [0; 64 * 1024];
    loop {
        check(deadline)?;
        let remaining = MAX_ENCODED + 1 - bytes.len();
        let n = file
            .read(&mut chunk[..remaining.min(64 * 1024)])
            .map_err(|_| Failure::Missing)?;
        if n == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..n]);
        if bytes.len() > MAX_ENCODED {
            return Err(Failure::Limit);
        }
    }
    if bytes.len() != identity.len() as usize
        || !same_file(&identity, &file.metadata().map_err(|_| Failure::Missing)?)
    {
        return Err(Failure::Missing);
    }
    check(deadline)?;
    let (width, height, mime) = match format {
        "png" if bytes.starts_with(b"\x89PNG\r\n\x1a\n") => {
            let (width, height) = decode_png(&bytes)?;
            (width, height, "image/png")
        }
        "jpg" if bytes.starts_with(b"\xff\xd8") => {
            let (width, height) = decode_jpeg(&bytes)?;
            (width, height, "image/jpeg")
        }
        "png" | "jpg" => return Err(Failure::Encoding),
        _ => return Err(Failure::Encoding),
    };
    check(deadline)?;
    let result = ValidatedCapture {
        mime,
        byte_length: bytes.len(),
        width,
        height,
        sha256: format!("{:x}", Sha256::digest(&bytes)),
        identity,
    };
    result.check_identity(path, deadline)?;
    Ok(result)
}

fn image_failure(error: image::ImageError) -> Failure {
    match error {
        image::ImageError::Limits(_) => Failure::Limit,
        _ => Failure::Invalid,
    }
}

fn decode_png(bytes: &[u8]) -> Result<(u32, u32), Failure> {
    if bytes.len() < 33 || &bytes[12..16] != b"IHDR" {
        return Err(Failure::Invalid);
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
    dimensions(width, height)?;
    // Require complete static PNG framing, including valid CRCs and final IEND.
    // A first-frame decoder alone need not consume/validate the final chunks.
    let mut pos = 8usize;
    let mut ended = false;
    let mut transparency = false;
    while pos < bytes.len() {
        let header = bytes.get(pos..pos + 8).ok_or(Failure::Invalid)?;
        let length = u32::from_be_bytes(header[..4].try_into().unwrap()) as usize;
        let end = pos
            .checked_add(length)
            .and_then(|n| n.checked_add(12))
            .ok_or(Failure::Invalid)?;
        let chunk = bytes.get(pos + 4..end).ok_or(Failure::Invalid)?;
        let (data, crc) = chunk.split_at(chunk.len() - 4);
        if crc32fast::hash(data) != u32::from_be_bytes(crc.try_into().unwrap()) {
            return Err(Failure::Invalid);
        }
        if &header[4..8] == b"tRNS" {
            transparency = true;
        }
        if &header[4..8] == b"acTL" {
            return Err(Failure::Invalid);
        }
        if &header[4..8] == b"IEND" {
            if length != 0 || end != bytes.len() {
                return Err(Failure::Invalid);
            }
            ended = true;
        }
        pos = end;
    }
    if !ended {
        return Err(Failure::Invalid);
    }
    let channels = match bytes[25] {
        0 => {
            if transparency {
                2
            } else {
                1
            }
        }
        2 => {
            if transparency {
                4
            } else {
                3
            }
        }
        3 => {
            if transparency {
                4
            } else {
                3
            }
        }
        4 => 2,
        6 => 4,
        _ => return Err(Failure::Invalid),
    };
    let component_bytes = if bytes[24] == 16 { 2 } else { 1 };
    let output_size = u64::from(width) * u64::from(height) * channels * component_bytes;
    let internal_budget = MAX_ALLOCATION
        .checked_sub(output_size)
        .filter(|n| *n > 0)
        .ok_or(Failure::Limit)?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_DIMENSION);
    limits.max_image_height = Some(MAX_DIMENSION);
    // The PNG library budget excludes our caller-owned output buffer.
    limits.max_alloc = Some(internal_budget);
    let mut reader = ImageReader::with_format(Cursor::new(bytes), ImageFormat::Png);
    reader.limits(limits);
    let decoder = reader.into_decoder().map_err(image_failure)?;
    if decoder.total_bytes() != output_size {
        return Err(Failure::Invalid);
    }
    let mut pixels = buffer(usize::try_from(output_size).map_err(|_| Failure::Limit)?)?;
    decoder
        .read_image(&mut pixels)
        .map_err(|_| Failure::Invalid)?;
    Ok((width, height))
}

fn decode_jpeg(bytes: &[u8]) -> Result<(u32, u32), Failure> {
    let mut input = Cursor::new(bytes);
    let mut decoder = JpegDecoder::new(&mut input);
    decoder.set_max_decoding_buffer_size(MAX_ALLOCATION as usize);
    decoder.read_info().map_err(|_| Failure::Invalid)?;
    let info = decoder.info().ok_or(Failure::Invalid)?;
    let (width, height) = (usize::from(info.width), usize::from(info.height));
    dimensions(width as u32, height as u32)?;
    let allocation = jpeg_allocation_budget(info)?;
    // Reserve the bounded budget before decoder-owned allocation; release it
    // before decode to avoid doubling memory. This is not an OS memory sandbox.
    let mut reservation = Vec::<u8>::new();
    reservation
        .try_reserve_exact(allocation as usize)
        .map_err(|_| Failure::Limit)?;
    drop(reservation);
    let _output = decoder.decode().map_err(|_| Failure::Invalid)?;
    drop(decoder);
    if input.position() != bytes.len() as u64 {
        return Err(Failure::Invalid);
    }
    // The vendored strict entropy guard is essential for validation; this additional frame
    // terminator requirement also rejects a stream truncated immediately at EOI.
    if !bytes.ends_with(b"\xff\xd9") {
        return Err(Failure::Invalid);
    }
    Ok((width as u32, height as u32))
}

// Pure preflight: no decoded image or decoder allocation is performed here.
fn jpeg_allocation_budget(info: jpeg_decoder::ImageInfo) -> Result<u64, Failure> {
    let (width, height) = (usize::from(info.width), usize::from(info.height));
    dimensions(width as u32, height as u32)?;
    let workspace = 16 * 1024 * 1024;
    let allocation = if info.coding_process == jpeg_decoder::CodingProcess::Lossless {
        // ImageInfo does not expose lossless precision. Count components from
        // its pixel format and budget the worst supported conversion (16 bit),
        // including for 2..7-bit inputs whose upstream output is also u16.
        let components = match info.pixel_format {
            jpeg_decoder::PixelFormat::L8 | jpeg_decoder::PixelFormat::L16 => 1,
            jpeg_decoder::PixelFormat::RGB24 => 3,
            jpeg_decoder::PixelFormat::CMYK32 => 4,
        };
        jpeg_lossless_allocation(width as u64 * height as u64, components)?
            .checked_add(workspace)
            .ok_or(Failure::Limit)?
    } else {
        let size = width
            .checked_mul(height)
            .and_then(|n| n.checked_mul(info.pixel_format.pixel_bytes()))
            .ok_or(Failure::Limit)?;
        // DCT paths: retained/queued i16 coefficients, u8 planes, output,
        // padded MCUs and row work (decoder.rs/worker/*.rs in pinned 0.3.2).
        let padded_width = (width as u64 + 31) & !31;
        let padded_height = (height as u64 + 31) & !31;
        padded_width
            .checked_mul(padded_height)
            .and_then(|n| n.checked_mul(24))
            .and_then(|n| n.checked_add(padded_width * 2048))
            .and_then(|n| n.checked_add(size as u64 + workspace))
            .ok_or(Failure::Limit)?
    };
    if allocation > MAX_ALLOCATION {
        return Err(Failure::Limit);
    }
    Ok(allocation)
}

// Lossless allocations in pinned decoder/lossless.rs are unrelated to DCT MCU
// buffers. This is a peak bound, not a whole-process RSS or allocator-size cap.
fn jpeg_lossless_allocation(pixels: u64, components: u64) -> Result<u64, Failure> {
    // vec![Vec::with_capacity(P); N] clones N-1 empty Vecs, losing their
    // reservation. Those i32 planes grow to power-of-two capacities (minimum
    // four elements); the last plane retains its exact P reservation.
    let grown = pixels
        .max(4)
        .checked_next_power_of_two()
        .ok_or(Failure::Limit)?;
    let differences = grown
        .checked_mul(components - 1)
        .and_then(|n| n.checked_add(pixels))
        .and_then(|n| n.checked_mul(4))
        .ok_or(Failure::Limit)?;
    // Retained planes from an earlier scan coexist with newly allocated u16
    // result planes. During a Vec growth, conservatively also allow the old
    // half-capacity i32 allocation to coexist with its new allocation.
    let results = pixels
        .checked_mul(components)
        .and_then(|n| n.checked_mul(4))
        .ok_or(Failure::Limit)?;
    let growth_overlap = if components > 1 {
        grown.checked_mul(2).ok_or(Failure::Limit)?
    } else {
        0
    };
    let scan_peak = results
        .checked_add(differences)
        .and_then(|n| n.checked_add(growth_overlap))
        .ok_or(Failure::Limit)?;
    // Non-8-bit conversion retains original planes, an interleaved u16 image,
    // collected [u8; 2] values and their concatenated u8 output: 8*N*P bytes.
    // Grayscale removes its sole source plane before conversion, so 6*P
    // suffices. This also covers every lower-precision/8-bit conversion path.
    let conversion_peak = pixels
        .checked_mul(components)
        .and_then(|n| n.checked_mul(if components == 1 { 6 } else { 8 }))
        .ok_or(Failure::Limit)?;
    Ok(scan_peak.max(conversion_peak))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn jpeg_entropy_checks_preserve_baseline_progressive_restart_and_stuffing() {
        for bytes in [
            include_bytes!("../contracts/v1/fixtures/images/valid.jpg").as_slice(),
            include_bytes!("../contracts/v1/fixtures/images/progressive.jpg").as_slice(),
            include_bytes!("../contracts/v1/fixtures/images/restart.jpg").as_slice(),
        ] {
            assert_eq!(decode_jpeg(bytes).unwrap(), (32, 24));
        }
        let restart = include_bytes!("../contracts/v1/fixtures/images/restart.jpg");
        assert!(restart.windows(2).any(|pair| pair == b"\xff\x00"));
        assert!(restart
            .windows(2)
            .any(|pair| pair[0] == 255 && (208..=215).contains(&pair[1])));
    }
    #[test]
    fn jpeg_rejects_every_truncated_baseline_entropy_prefix_even_with_eoi() {
        let bytes = include_bytes!("../contracts/v1/fixtures/images/valid.jpg");
        let sos = bytes
            .windows(2)
            .position(|pair| pair == b"\xff\xda")
            .unwrap();
        let start =
            sos + 2 + u16::from_be_bytes(bytes[sos + 2..sos + 4].try_into().unwrap()) as usize;
        for end in start..bytes.len() - 2 {
            let mut truncated = bytes[..end].to_vec();
            truncated.extend_from_slice(b"\xff\xd9");
            assert!(
                decode_jpeg(&truncated).is_err(),
                "accepted entropy ending at byte {end}"
            );
        }
    }
    #[test]
    fn expired_validation_never_opens_the_capture() {
        let error = validate_capture(Path::new("/nonexistent/capture"), "png", Instant::now())
            .err()
            .unwrap();
        assert_eq!(error.code(), "ETIMEDOUT");
    }
}

#[cfg(all(test, unix))]
mod framing_tests {
    use super::*;
    #[test]
    fn jpeg_rejects_unconsumed_second_image() {
        let bytes = include_bytes!("../contracts/v1/fixtures/images/valid.jpg");
        let mut concatenated = bytes.to_vec();
        concatenated.extend_from_slice(bytes);
        assert!(decode_jpeg(&concatenated).is_err());
    }
    #[test]
    fn static_contract_fixtures_match_real_validated_bytes() {
        for (bytes, format, expected) in [
            (
                include_bytes!("../contracts/v1/fixtures/images/valid.png").as_slice(),
                "png",
                include_str!("../contracts/v1/fixtures/observations/valid-png.json"),
            ),
            (
                include_bytes!("../contracts/v1/fixtures/images/valid.jpg").as_slice(),
                "jpg",
                include_str!("../contracts/v1/fixtures/observations/valid-jpg.json"),
            ),
        ] {
            let f = crate::backend_fixtures::Fixture::new();
            let path = f.root.join("owned-image");
            fs::write(&path, bytes).unwrap();
            let validated = validate_capture(
                &path,
                format,
                Instant::now() + std::time::Duration::from_secs(1),
            )
            .unwrap();
            let mut receipt = validated.receipt("fixture", "screen", Some("screen"), false);
            let expected: Value = serde_json::from_str(expected).unwrap();
            receipt["observationId"] = expected["observationId"].clone();
            receipt["capturedAtMs"] = expected["capturedAtMs"].clone();
            assert_eq!(receipt, expected);
            fs::write(&path, b"replaced").unwrap();
            assert!(validated
                .check_identity(&path, Instant::now() + std::time::Duration::from_secs(1))
                .is_err());
        }
    }
}

#[cfg(test)]
mod limit_tests {
    use super::*;
    #[test]
    fn png_dimension_pixel_and_allocation_limits_precede_decode() {
        for (width, height, depth, color) in [
            (16385u32, 24u32, 8, 2),
            (8192, 8192, 8, 2),
            (8000, 8000, 16, 6),
        ] {
            let mut bytes = include_bytes!("../contracts/v1/fixtures/images/valid.png").to_vec();
            bytes[16..20].copy_from_slice(&width.to_be_bytes());
            bytes[20..24].copy_from_slice(&height.to_be_bytes());
            bytes[24] = depth;
            bytes[25] = color;
            let crc = crc32fast::hash(&bytes[12..29]);
            bytes[29..33].copy_from_slice(&crc.to_be_bytes());
            assert_eq!(decode_png(&bytes).err().unwrap().code(), "IMAGE_LIMIT");
        }
    }
    #[test]
    fn jpeg_dimension_pixel_and_allocation_limits_precede_decode() {
        for (width, height) in [(16385u16, 24u16), (8192, 8192), (6000, 4000)] {
            let mut bytes = include_bytes!("../contracts/v1/fixtures/images/valid.jpg").to_vec();
            let sof = bytes
                .windows(2)
                .position(|pair| pair == b"\xff\xc0")
                .unwrap();
            bytes[sof + 5..sof + 7].copy_from_slice(&height.to_be_bytes());
            bytes[sof + 7..sof + 9].copy_from_slice(&width.to_be_bytes());
            assert_eq!(decode_jpeg(&bytes).err().unwrap().code(), "IMAGE_LIMIT");
        }
    }
    #[test]
    fn png_bad_deflate_with_valid_chunk_crc_is_rejected() {
        let mut bytes = include_bytes!("../contracts/v1/fixtures/images/valid.png").to_vec();
        let idat = bytes.windows(4).position(|kind| kind == b"IDAT").unwrap();
        let len = u32::from_be_bytes(bytes[idat - 4..idat].try_into().unwrap()) as usize;
        bytes[idat + 4..idat + 4 + len].fill(0);
        let crc = crc32fast::hash(&bytes[idat..idat + 4 + len]);
        bytes[idat + 4 + len..idat + 8 + len].copy_from_slice(&crc.to_be_bytes());
        assert_eq!(decode_png(&bytes).err().unwrap().code(), "IMAGE_INVALID");
    }
}

#[cfg(test)]
mod lossless_budget_tests {
    use super::*;
    use jpeg_decoder::{CodingProcess, ImageInfo, PixelFormat};

    fn lossless_frame(width: u16, height: u16, components: u8, precision: u8) -> Vec<u8> {
        let mut bytes = vec![0xff, 0xd8, 0xff, 0xc3];
        bytes.extend_from_slice(&(8 + 3 * u16::from(components)).to_be_bytes());
        bytes.push(precision);
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.push(components);
        for id in 1..=components {
            bytes.extend_from_slice(&[id, 0x11, 0]);
        }
        bytes
    }

    fn constant_lossless(components: u8, precision: u8, scans: usize) -> Vec<u8> {
        let mut bytes = lossless_frame(3, 3, components, precision);
        // DC Huffman table 0: one one-bit code, symbol 0 (zero difference).
        bytes.extend_from_slice(&[0xff, 0xc4, 0, 20, 0, 1]);
        bytes.extend_from_slice(&[0; 15]);
        bytes.push(0);
        for _ in 0..scans {
            bytes.extend_from_slice(&[0xff, 0xda]);
            bytes.extend_from_slice(&(6 + 2 * u16::from(components)).to_be_bytes());
            bytes.push(components);
            for id in 1..=components {
                bytes.extend_from_slice(&[id, 0]);
            }
            bytes.extend_from_slice(&[1, 0, 0]); // Ra predictor, point transform 0.
            let bits = 9 * usize::from(components);
            bytes.resize(bytes.len() + bits / 8, 0);
            if bits % 8 != 0 {
                bytes.push((1 << (8 - bits % 8)) - 1);
            }
        }
        bytes.extend_from_slice(&[0xff, 0xd9]);
        bytes
    }

    #[test]
    fn small_lossless_all_supported_precisions_and_components_remain_valid() {
        for components in [1, 3, 4] {
            for precision in 2..=16 {
                // Repeated scans exercise live prior planes while new planes
                // are decoded, not just the single-scan minimum allocation.
                for scans in [1, 2] {
                    let bytes = constant_lossless(components, precision, scans);
                    assert_eq!(decode_jpeg(&bytes).unwrap(), (3, 3));
                    let mut decoder = JpegDecoder::new(Cursor::new(bytes));
                    let output = decoder.decode().unwrap();
                    let count = 9 * usize::from(components);
                    if precision == 8 {
                        assert_eq!(output, vec![128; count]);
                    } else {
                        let value = (1u16 << (precision - 1)).to_ne_bytes();
                        assert_eq!(output, value.repeat(count));
                    }
                }
            }
        }
    }

    #[test]
    fn oversized_lossless_header_fails_preflight_without_a_scan_or_pixels() {
        let mut bytes = lossless_frame(2900, 2900, 4, 16);
        bytes.extend_from_slice(&[0xff, 0xd9]);
        assert_eq!(decode_jpeg(&bytes).err().unwrap().code(), "IMAGE_LIMIT");
    }

    #[test]
    fn lossless_four_component_2900_square_is_rejected_without_allocating_pixels() {
        let info = ImageInfo {
            width: 2900,
            height: 2900,
            pixel_format: PixelFormat::CMYK32,
            coding_process: CodingProcess::Lossless,
        };
        assert_eq!(jpeg_lossless_allocation(8_410_000, 4).unwrap(), 403_081_024);
        // The same dimensions remain safe for either grayscale output format;
        // this rejects the oversized configuration, not lossless JPEG itself.
        for pixel_format in [PixelFormat::L8, PixelFormat::L16] {
            let grayscale = ImageInfo {
                pixel_format,
                ..info
            };
            assert_eq!(jpeg_allocation_budget(grayscale).unwrap(), 84_057_216);
        }
        assert_eq!(
            jpeg_allocation_budget(info).err().unwrap().code(),
            "IMAGE_LIMIT"
        );
    }
}
