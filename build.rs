use std::process::Command;
fn git(args: &[&str]) -> Option<String> {
    let output = Command::new("git").args(args).output().ok()?;
    if !output.status.success() { return None; }
    Some(String::from_utf8(output.stdout).ok()?.trim().to_string())
}
fn main() {
    // A deliberately nonexistent input prevents Cargo from retaining an identity after HEAD or worktree changes.
    println!("cargo:rerun-if-changed=.release-identity-always-recompute");
    let source_root = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    let is_source_root = git(&["rev-parse", "--show-toplevel"]).and_then(|p| std::fs::canonicalize(p).ok())
        == std::fs::canonicalize(&source_root).ok();
    let commit = git(&["rev-parse", "HEAD"]).filter(|v| v.len() == 40 && v.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) && is_source_root);
    let dirty = !is_source_root || git(&["status", "--porcelain", "--untracked-files=normal"]).map(|v| !v.is_empty()).unwrap_or(true);
    println!("cargo:rustc-env=COVEN_BUILD_COMMIT={}", commit.unwrap_or_default());
    println!("cargo:rustc-env=COVEN_BUILD_DIRTY={dirty}");
    println!("cargo:rustc-env=COVEN_BUILD_TARGET={}", std::env::var("TARGET").unwrap());
}
