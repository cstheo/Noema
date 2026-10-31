//! Markdown memory, bounded task context, and recall hooks.

pub mod check;
pub mod context;
pub mod hooks;
pub mod model;
pub mod store;

use anyhow::{Context, Result, bail, ensure};
use fs2::FileExt;
use std::{
    fs::File,
    path::{Path, PathBuf},
};

pub fn repository(explicit: Option<&Path>) -> Result<PathBuf> {
    if let Some(path) = explicit {
        let root = path.canonicalize().context("Resolve Noema root")?;
        ensure!(
            has_memory(&root),
            "Expected noema/profile, noema/work, or noema/insights in {}",
            root.display()
        );
        return Ok(root);
    }
    let cwd = std::env::current_dir()?;
    for path in cwd.ancestors() {
        if has_memory(path) {
            return Ok(path.canonicalize()?);
        }
    }
    let compiled = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    if has_memory(&compiled) {
        return Ok(compiled.canonicalize()?);
    }
    bail!("No Noema repository found; supply --root")
}

fn has_memory(root: &Path) -> bool {
    ["profile", "work", "insights"]
        .iter()
        .any(|area| root.join("noema").join(area).is_dir())
}

/// Serialize hook binding updates without creating a lock file.
pub(crate) fn lock(root: &Path) -> Result<File> {
    let file = File::open(store::safe_path(root, "noema")?).context("Open memory directory")?;
    FileExt::try_lock_exclusive(&file)
        .context("Another Noema hook is running; retry when it finishes")?;
    Ok(file)
}
