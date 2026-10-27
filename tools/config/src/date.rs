//! Numeric Moment-compatible tokens shared by validation and daily-note I/O.

use anyhow::{Context, Result, ensure};

pub const DATE_TOKENS: &[&str] = &["YYYY", "YY", "MM", "M", "DD", "D"];
const TIME_TOKENS: &[&str] = &["HH", "H", "hh", "h", "mm", "m", "ss", "s", "A", "a"];

pub fn format_parts(mut pattern: &str, time: bool) -> Result<Vec<String>> {
    let mut parts = Vec::new();
    while !pattern.is_empty() {
        let first = pattern.chars().next().context("Empty date format")?;
        let length = if first == '[' {
            let end = pattern.find(']').context("Unclosed date-format literal")?;
            ensure!(!pattern[1..end].contains('['), "Nested date-format literal");
            end + 1
        } else if first.is_ascii_alphabetic() {
            let token: String = pattern.chars().take_while(|&c| c == first).collect();
            ensure!(
                DATE_TOKENS.contains(&token.as_str())
                    || (time && TIME_TOKENS.contains(&token.as_str())),
                "Unsupported date-format token {token:?}; use numeric year, month and day tokens"
            );
            token.len()
        } else {
            ensure!(
                first != ']' && !first.is_alphabetic(),
                "Invalid date-format literal"
            );
            first.len_utf8()
        };
        parts.push(pattern[..length].into());
        pattern = &pattern[length..];
    }
    Ok(parts)
}

pub fn literal(part: &str) -> &str {
    part.strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .unwrap_or(part)
}
