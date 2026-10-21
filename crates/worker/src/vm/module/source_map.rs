//! Source maps for a program's modules: from a transform (TypeScript, JSX,
//! `define`), and a bundle's own (`//# sourceMappingURL=`, or a `.map`
//! file beside it). Stacks the worker reports have their frames mapped
//! back to the original files; the guest's own `error.stack` keeps V8's.

use std::sync::Arc;

use base64::Engine;

/// One source map, owned, as a lookup table.
pub(crate) struct LineMap {
    /// `(generated line, generated column, source, line, column)`, 0-based,
    /// sorted by generated position.
    tokens: Vec<(u32, u32, u32, u32, u32)>,
    /// The sources' paths, as tree paths.
    sources: Vec<String>,
}

impl LineMap {
    /// A map from its JSON. `sources` are resolved against `dir` (the
    /// directory of the file the map belongs to).
    pub(crate) fn from_json(json: &str, dir: &str) -> Option<Self> {
        let map = oxc_sourcemap::SourceMap::from_json_string(json).ok()?;
        let root = map.get_source_root().unwrap_or("").to_string();
        let sources = map
            .get_sources()
            .map(|source| join(dir, &format!("{root}{source}")))
            .collect();
        Some(Self::of(&map, sources))
    }

    /// The map a transform made of `path` (its one source is the file).
    pub(crate) fn from_transform(map: &oxc_sourcemap::SourceMap, path: &str) -> Self {
        let sources = map.get_sources().map(|_| path.to_string()).collect();
        Self::of(map, sources)
    }

    fn of(map: &oxc_sourcemap::SourceMap, sources: Vec<String>) -> Self {
        let mut tokens: Vec<_> = map
            .get_tokens()
            .filter_map(|token| {
                Some((
                    token.get_dst_line(),
                    token.get_dst_col(),
                    token.get_source_id()?,
                    token.get_src_line(),
                    token.get_src_col(),
                ))
            })
            .collect();
        tokens.sort_unstable();
        Self { tokens, sources }
    }

    /// The original position of generated `(line, column)` (0-based): the
    /// nearest mapping at or before it on that line.
    fn lookup(&self, line: u32, column: u32) -> Option<(&str, u32, u32)> {
        let after = self
            .tokens
            .partition_point(|t| (t.0, t.1) <= (line, column));
        let (dst_line, _, source, src_line, src_col) = *self.tokens.get(after.checked_sub(1)?)?;
        if dst_line != line {
            return None;
        }
        Some((self.sources.get(source as usize)?, src_line, src_col))
    }

    pub(crate) fn byte_size(&self) -> usize {
        self.tokens.len() * 20 + self.sources.iter().map(String::len).sum::<usize>()
    }
}

/// `dir` joined with a relative `path`, `.` and `..` resolved (a path that
/// climbs above the root stays at it).
fn join(dir: &str, path: &str) -> String {
    let path = path.strip_prefix("webpack://").unwrap_or(path);
    let mut parts: Vec<&str> = if path.starts_with('/') {
        Vec::new()
    } else {
        dir.split('/').filter(|s| !s.is_empty()).collect()
    };
    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            part => parts.push(part),
        }
    }
    parts.join("/")
}

/// A module's maps, applied in order: a transform's first, then the
/// file's own, so a bundle that was also transformed maps to its sources.
#[derive(Default)]
pub(crate) struct Maps(Vec<Arc<LineMap>>);

impl Maps {
    pub(crate) fn push(&mut self, map: Arc<LineMap>) {
        self.0.push(map);
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Where generated `(line, column)` (1-based) came from, 1-based. None
    /// if a map has no mapping for it.
    pub(crate) fn original(&self, line: u32, column: u32) -> Option<(String, u32, u32)> {
        let mut at: Option<(String, u32, u32)> = None;
        let (mut line, mut column) = (line.checked_sub(1)?, column.checked_sub(1)?);
        for map in &self.0 {
            let (source, l, c) = map.lookup(line, column)?;
            at = Some((source.to_string(), l, c));
            (line, column) = (l, c);
        }
        at.map(|(source, l, c)| (source, l + 1, c + 1))
    }
}

/// A file's own map: the `//# sourceMappingURL=` comment it ends with (a
/// `data:` URL, or a path relative to it), else `<path>.map` beside it.
/// `read` reads a file of the tree.
pub(crate) fn own_map<'t>(
    path: &str,
    code: &str,
    read: impl Fn(&str) -> Option<&'t str>,
) -> Option<LineMap> {
    let dir = path.rfind('/').map_or("", |i| &path[..i]);
    let url = code
        .trim_end()
        .lines()
        .next_back()
        .and_then(|last| {
            last.strip_prefix("//# sourceMappingURL=")
                .or_else(|| last.strip_prefix("//@ sourceMappingURL="))
        })
        .map(str::trim);
    let json = match url {
        Some(url) if url.starts_with("data:") => {
            let (meta, data) = url.split_once(',')?;
            if meta.ends_with(";base64") {
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(data)
                    .ok()?;
                String::from_utf8(bytes).ok()?
            } else {
                percent_decode(data)?
            }
        }
        Some(url) if !url.contains(':') => read(&join(dir, url))?.to_string(),
        Some(_) => return None,
        None => read(&format!("{path}.map"))?.to_string(),
    };
    LineMap::from_json(&json, dir)
}

fn percent_decode(text: &str) -> Option<String> {
    let mut out = Vec::with_capacity(text.len());
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = text.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// `stack` with each frame in a mapped module (`at f (src/a.ts:3:7)`,
/// `at src/a.ts:3:7`) pointing at its original position.
/// `original(file, line, column)` is where a frame's position came from,
/// as `file:line:column`, for files with maps.
pub(crate) fn map_stack(
    stack: &str,
    original: impl Fn(&str, u32, u32) -> Option<String>,
) -> String {
    let mut out = String::with_capacity(stack.len());
    for (i, line) in stack.split('\n').enumerate() {
        if i > 0 {
            out.push('\n');
        }
        out.push_str(&map_frame(line, &original).unwrap_or_else(|| line.to_string()));
    }
    out
}

/// One frame line, mapped; None if it isn't a frame of a mapped module.
fn map_frame(line: &str, original: &impl Fn(&str, u32, u32) -> Option<String>) -> Option<String> {
    let trimmed = line.trim_start();
    if !trimmed.starts_with("at ") {
        return None;
    }
    // The location is the whole frame after `at `, or what the last
    // parentheses hold.
    let (start, end) = match (trimmed.ends_with(')'), trimmed.rfind('(')) {
        (true, Some(open)) => (open + 1, trimmed.len() - 1),
        _ => (3, trimmed.len()),
    };
    let location = &trimmed[start..end];
    let mut parts = location.rsplitn(3, ':');
    let column: u32 = parts.next()?.parse().ok()?;
    let line_number: u32 = parts.next()?.parse().ok()?;
    let file = parts.next()?;
    let mapped = original(file, line_number, column)?;
    let indent = &line[..line.len() - trimmed.len()];
    Some(format!(
        "{indent}{}{mapped}{}",
        &trimmed[..start],
        &trimmed[end..]
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joins() {
        assert_eq!(join("dist", "../src/a.ts"), "src/a.ts");
        assert_eq!(join("", "./a.ts"), "a.ts");
        assert_eq!(join("a/b", "/x.ts"), "x.ts");
        assert_eq!(join("a", "../../x.ts"), "x.ts");
    }

    #[test]
    fn maps_frames() {
        let original = |file: &str, line: u32, _column: u32| {
            (file == "a.ts").then(|| format!("src/a.ts:{line}:9"))
        };
        let stack = "Error: x\n    at f (a.ts:3:7)\n    at a.ts:4:1\n    at g (b.js:1:1)";
        assert_eq!(
            map_stack(stack, original),
            "Error: x\n    at f (src/a.ts:3:9)\n    at src/a.ts:4:9\n    at g (b.js:1:1)"
        );
    }
}
