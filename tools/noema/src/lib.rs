//! Evidence-linked Markdown memory and a checked record/context lifecycle.

pub mod check;
pub mod consolidation;
pub mod context;
pub mod hooks;
pub mod model;
pub mod record;
pub mod store;

use anyhow::{Context, Result, bail, ensure};
use fs2::FileExt;
use std::{
    fs::File,
    path::{Path, PathBuf},
};

pub const PENDING: &str = ".local/noema/pending.json";

pub fn repository(explicit: Option<&Path>) -> Result<PathBuf> {
    if let Some(path) = explicit {
        let root = path.canonicalize().context("Resolve Noema root")?;
        ensure!(
            root.join("noema").is_dir() && root.join("corpus").is_dir(),
            "Expected noema/ and corpus/ in {}",
            root.display()
        );
        return Ok(root);
    }
    let cwd = std::env::current_dir()?;
    for path in cwd.ancestors() {
        if path.join("noema").is_dir() && path.join("corpus").is_dir() {
            return Ok(path.canonicalize()?);
        }
    }
    let compiled = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    if compiled.join("noema").is_dir() && compiled.join("corpus").is_dir() {
        return Ok(compiled.canonicalize()?);
    }
    bail!("No Noema repository found; supply --root")
}

/// Directory locks coordinate readers and writers without creating reader state.
pub fn lock(root: &Path, write: bool) -> Result<File> {
    let directory = store::safe_path(root, "noema")?;
    let file = File::open(directory).context("Open memory directory")?;
    if write {
        FileExt::try_lock_exclusive(&file)
    } else {
        FileExt::try_lock_shared(&file)
    }
    .context("Another Noema operation is running; retry when it finishes")?;
    Ok(file)
}

pub fn require_complete(root: &Path) -> Result<()> {
    ensure!(
        !store::safe_path(root, PENDING)?.exists(),
        "Incomplete record: run `noema record --recover` before reading memory"
    );
    Ok(())
}
