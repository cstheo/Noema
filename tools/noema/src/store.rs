use crate::model::{Fence, Page, parse_page};
use anyhow::{Context, Result, bail, ensure};
use serde::de::DeserializeOwned;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{ErrorKind, Read},
    path::{Path, PathBuf},
};

pub type Overlay = BTreeMap<String, String>;
pub const MAX_FILE_BYTES: usize = 1024 * 1024;

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
    let path = Path::new(relative);
    let mut resolved = root.to_path_buf();
    for part in path.components() {
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

pub fn read_text(root: &Path, relative: &str, overlay: &Overlay) -> Result<String> {
    let path = safe_path(root, relative)?;
    if let Some(text) = overlay.get(relative) {
        ensure!(
            text.len() <= MAX_FILE_BYTES,
            "file exceeds 1 MiB: {relative}"
        );
        return Ok(text.clone());
    }
    ensure!(
        fs::symlink_metadata(&path)
            .with_context(|| format!("inspect {relative}"))?
            .is_file(),
        "not a regular file: {relative}"
    );
    let file = fs::File::open(&path).with_context(|| format!("read {relative}"))?;
    let mut bytes = Vec::new();
    file.take((MAX_FILE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= MAX_FILE_BYTES,
        "file exceeds 1 MiB: {relative}"
    );
    String::from_utf8(bytes).with_context(|| format!("file is not UTF-8: {relative}"))
}

pub fn read_json<T: DeserializeOwned>(root: &Path, relative: &str) -> Result<Option<T>> {
    match read_text(root, relative, &Overlay::new()) {
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

fn components(path: &str) -> Option<Vec<&str>> {
    let parts: Vec<_> = path.split('/').collect();
    (!parts.is_empty()
        && parts.iter().all(|part| {
            !part.is_empty()
                && *part != "."
                && *part != ".."
                && !part.starts_with('.')
                && !part.contains('\\')
                && !part.chars().any(char::is_control)
        }))
    .then_some(parts)
}

pub fn memory_path(path: &str) -> bool {
    components(path).is_some_and(|parts| {
        parts.len() >= 3
            && parts[0] == "noema"
            && ["profile", "work", "insights"].contains(&parts[1])
            && parts.last().is_some_and(|name| {
                name.ends_with(".md") && !name.eq_ignore_ascii_case("README.md")
            })
            && !parts.contains(&"sources")
    })
}

pub fn record_path(path: &str) -> bool {
    components(path).is_some_and(|parts| {
        parts.len() >= 3
            && parts[0] == "corpus"
            && parts[1..parts.len() - 1].contains(&"records")
            && !parts.contains(&"sources")
            && parts.last().is_some_and(|name| {
                name.ends_with(".md") && !name.eq_ignore_ascii_case("README.md")
            })
    })
}

pub fn writable_path(root: &Path, path: &str) -> Result<PathBuf> {
    ensure!(
        memory_path(path) || record_path(path),
        "writes require a memory page or Corpus record: {path}"
    );
    let resolved = safe_path(root, path)?;
    let mut current = root.to_path_buf();
    for component in Path::new(path)
        .parent()
        .context("write path has no parent")?
        .components()
    {
        current.push(component.as_os_str());
        ensure!(
            fs::symlink_metadata(current.join(".git"))
                .is_err_and(|error| error.kind() == ErrorKind::NotFound),
            "write inside a source repository refused: {path}"
        );
    }
    Ok(resolved)
}

fn collect(root: &Path, relative: &str, paths: &mut BTreeSet<String>) -> Result<()> {
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
        if kind.is_dir() {
            ensure!(
                !name.starts_with('.'),
                "hidden memory directory refused: {child}"
            );
            collect(root, &child, paths)?;
        } else if kind.is_file() {
            if name.eq_ignore_ascii_case("README.md") {
                continue;
            }
            ensure!(
                memory_path(&child),
                "unexpected file in memory area: {child}"
            );
            paths.insert(child);
        } else {
            bail!("memory path is not a regular file: {child}");
        }
    }
    Ok(())
}

pub(crate) fn load_texts(root: &Path, overlay: &Overlay) -> Result<Overlay> {
    let mut paths = BTreeSet::new();
    for area in ["profile", "work", "insights"] {
        collect(root, &format!("noema/{area}"), &mut paths)?;
    }
    for path in overlay.keys().filter(|path| memory_path(path)) {
        paths.insert(path.clone());
    }
    ensure!(paths.len() <= 4096, "memory page limit exceeded");
    paths
        .into_iter()
        .map(|path| {
            let text = read_text(root, &path, overlay)?;
            Ok((path, text))
        })
        .collect()
}

pub fn load_pages(root: &Path, overlay: &Overlay) -> Result<Vec<Page>> {
    load_texts(root, overlay)?
        .into_iter()
        .map(|(path, text)| parse_page(&path, &text).with_context(|| format!("parse {path}")))
        .collect()
}

fn slug(heading: &str) -> String {
    heading
        .trim()
        .trim_end_matches('#')
        .trim()
        .to_lowercase()
        .chars()
        .filter(|character| {
            character.is_alphanumeric()
                || *character == '_'
                || *character == '-'
                || character.is_whitespace()
        })
        .map(|character| {
            if character.is_whitespace() {
                '-'
            } else {
                character
            }
        })
        .collect()
}

pub fn anchor_text(text: &str, anchor: &str) -> Option<String> {
    let lines: Vec<_> = text.lines().collect();
    let mut visible = vec![false; lines.len()];
    let mut fence = Fence::default();
    let mut frontmatter = lines.first().is_some_and(|line| *line == "---");
    for (index, line) in lines.iter().enumerate() {
        if frontmatter {
            if index > 0 && *line == "---" {
                frontmatter = false;
            }
            continue;
        }
        let trimmed = line.trim_start();
        if line.len() - trimmed.len() > 3 {
            continue;
        }
        if fence.advance(line) {
            continue;
        }
        visible[index] = !fence.is_open();
    }
    if let Some(block) = anchor.strip_prefix('^') {
        if block.is_empty() {
            return None;
        }
        let marker = format!("^{block}");
        let index = lines.iter().enumerate().find_map(|(index, line)| {
            (visible[index] && line.split_whitespace().last() == Some(marker.as_str()))
                .then_some(index)
        })?;
        let mut start = index;
        if lines[index].trim() == marker {
            while start > 0 && lines[start - 1].trim().is_empty() {
                start -= 1;
            }
        }
        while start > 0 && visible[start - 1] && !lines[start - 1].trim().is_empty() {
            start -= 1;
        }
        return Some(lines[start..=index].join("\n"));
    }
    let mut occurrences = BTreeMap::<String, usize>::new();
    let mut headings = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        if !visible[index] {
            continue;
        }
        let line = line.trim_start();
        let level = line
            .chars()
            .take_while(|character| *character == '#')
            .count();
        if (1..=6).contains(&level) && line.as_bytes().get(level) == Some(&b' ') {
            let base = slug(&line[level + 1..]);
            let occurrence = occurrences.entry(base.clone()).or_default();
            let actual = if *occurrence == 0 {
                base
            } else {
                format!("{base}-{occurrence}")
            };
            *occurrence += 1;
            headings.push((index, level, actual));
        }
    }
    let position = headings
        .iter()
        .position(|(_, _, actual)| actual == anchor)?;
    let (start, level, _) = &headings[position];
    let end = headings[position + 1..]
        .iter()
        .find(|(_, next_level, _)| next_level <= level)
        .map_or(lines.len(), |(index, _, _)| *index);
    Some(lines[*start..end].join("\n").trim_end().to_owned())
}

pub fn has_anchor(text: &str, anchor: &str) -> bool {
    anchor_text(text, anchor).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    #[test]
    fn paths_cannot_escape_or_enter_sources() -> Result<()> {
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
        assert!(writable_path(root.path(), "corpus/projects/a/sources/records/new.md").is_err());
        fs::create_dir_all(root.path().join("corpus/project/.git"))?;
        assert!(writable_path(root.path(), "corpus/project/records/new.md").is_err());
        assert!(writable_path(root.path(), "corpus/projects/a/records/new.md").is_ok());
        Ok(())
    }

    #[test]
    fn anchors_ignore_examples_in_fences() {
        let text = "# Source\n\n```md\n## Fake\n```\n\n## Real heading\n\nText ^record\n\n## Real heading\n";
        assert!(has_anchor(text, "real-heading"));
        assert!(has_anchor(text, "real-heading-1"));
        assert!(has_anchor(text, "^record"));
        assert!(!has_anchor(text, "fake"));
    }
}
