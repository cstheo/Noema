use crate::model::{Page, parse_page};
use anyhow::{Context, Result, ensure};
use serde::de::DeserializeOwned;
use std::{
    fs,
    io::{ErrorKind, Read},
    path::{Path, PathBuf},
};

const MAX_FILE_BYTES: usize = 1024 * 1024;

pub fn safe_path(root: &Path, relative: &str) -> Result<PathBuf> {
    ensure!(
        !relative.is_empty()
            && !relative.contains('\\')
            && !relative.chars().any(char::is_control)
            && relative
                .split('/')
                .all(|part| !part.is_empty() && part != "." && part != ".."),
        "unsafe repository path: {relative}"
    );
    let mut resolved = root.to_path_buf();
    for part in Path::new(relative).components() {
        resolved.push(part.as_os_str());
        match fs::symlink_metadata(&resolved) {
            Ok(metadata) => ensure!(
                !metadata.file_type().is_symlink(),
                "symlink path refused: {relative}"
            ),
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(error).with_context(|| format!("inspect {relative}")),
        }
    }
    Ok(resolved)
}

fn read_text(root: &Path, relative: &str) -> Result<String> {
    let path = safe_path(root, relative)?;
    ensure!(
        fs::symlink_metadata(&path)?.is_file(),
        "not a regular file: {relative}"
    );
    let mut bytes = Vec::new();
    fs::File::open(path)
        .with_context(|| format!("read {relative}"))?
        .take((MAX_FILE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= MAX_FILE_BYTES,
        "file exceeds 1 MiB: {relative}"
    );
    String::from_utf8(bytes).with_context(|| format!("file is not UTF-8: {relative}"))
}

pub(crate) fn read_json<T: DeserializeOwned>(root: &Path, relative: &str) -> Result<Option<T>> {
    match read_text(root, relative) {
        Ok(text) => Ok(Some(
            serde_json::from_str(&text).with_context(|| format!("Parse {relative}"))?,
        )),
        Err(error)
            if error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|error| error.kind() == ErrorKind::NotFound) =>
        {
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

fn collect(root: &Path, relative: &str, pages: &mut Vec<Page>) -> Result<()> {
    let directory = safe_path(root, relative)?;
    if !directory.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| anyhow::anyhow!("non-UTF-8 memory filename"))?;
        let child = format!("{relative}/{name}");
        let kind = entry.file_type()?;
        ensure!(!kind.is_symlink(), "symlink memory path refused: {child}");
        if name.eq_ignore_ascii_case("README.md") {
            continue;
        }
        if kind.is_dir() {
            ensure!(
                !name.starts_with('.'),
                "hidden memory directory refused: {child}"
            );
            collect(root, &child, pages)?;
        } else {
            ensure!(
                kind.is_file() && name.ends_with(".md"),
                "expected a Markdown memory page: {child}"
            );
            let text = read_text(root, &child)?;
            pages.push(parse_page(&child, &text).with_context(|| format!("parse {child}"))?);
            ensure!(pages.len() <= 4096, "memory page limit exceeded");
        }
    }
    Ok(())
}

pub fn load_pages(root: &Path) -> Result<Vec<Page>> {
    let mut pages = Vec::new();
    for area in ["profile", "work", "insights"] {
        collect(root, &format!("noema/{area}"), &mut pages)?;
    }
    pages.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(pages)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    #[test]
    fn paths_cannot_escape_or_follow_symlinks() -> Result<()> {
        let root = tempfile::tempdir()?;
        let outside = tempfile::tempdir()?;
        symlink(outside.path(), root.path().join("shortcut"))?;
        for path in [
            "../escape",
            "./local",
            "a/../b",
            "a//b",
            "/absolute",
            "shortcut/new.md",
        ] {
            assert!(safe_path(root.path(), path).is_err(), "{path}");
        }
        assert!(safe_path(root.path(), "noema/work/example.md").is_ok());
        Ok(())
    }
}
