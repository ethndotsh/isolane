//! A program's files, as `load` sent them, and the resolver over them:
//! `oxc_resolver` with a file system that is the uploaded tree and nothing
//! else, so resolving an import never reaches the host's disk.
//!
//! Paths in the tree are relative (`src/index.ts`); the resolver sees them
//! under `/` (`/src/index.ts`).

use std::collections::{BTreeMap, BTreeSet};
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, OnceLock};

use oxc_resolver::{FileMetadata, FileSystem, ResolveError, ResolveOptions, ResolverGeneric};
use sha2::Digest;

/// A file's contents.
pub(crate) enum Source {
    Text(String),
    Bytes(Vec<u8>),
}

impl Source {
    pub(crate) fn bytes(&self) -> &[u8] {
        match self {
            Source::Text(text) => text.as_bytes(),
            Source::Bytes(bytes) => bytes,
        }
    }

    /// As UTF-8 text, if it is.
    pub(crate) fn text(&self) -> Option<&str> {
        match self {
            Source::Text(text) => Some(text),
            Source::Bytes(bytes) => std::str::from_utf8(bytes).ok(),
        }
    }
}

/// The files, and the directories their paths imply.
pub(crate) struct Tree {
    files: BTreeMap<String, Source>,
    dirs: BTreeSet<String>,
    /// Each file's SHA-256, made the first time it's asked for: the
    /// transform and code caches key on it, so a file is hashed once per
    /// tree, not once per instance.
    hashes: BTreeMap<String, OnceLock<[u8; 32]>>,
}

impl Tree {
    /// The tree of `files`, or why a path can't be in one.
    pub(crate) fn new(files: BTreeMap<String, Source>) -> Result<Self, String> {
        let mut dirs = BTreeSet::from([String::new()]);
        for path in files.keys() {
            if !is_clean(path) {
                return Err(format!(
                    "the program's file path {path:?} must be relative, without `.` or `..` segments"
                ));
            }
            let mut at = 0;
            while let Some(slash) = path[at..].find('/') {
                dirs.insert(path[..at + slash].to_string());
                at += slash + 1;
            }
        }
        if let Some(clash) = files.keys().find(|path| dirs.contains(*path)) {
            return Err(format!(
                "the program's file path {clash:?} is also a directory"
            ));
        }
        let hashes = files
            .keys()
            .map(|path| (path.clone(), OnceLock::new()))
            .collect();
        Ok(Self {
            files,
            dirs,
            hashes,
        })
    }

    /// The SHA-256 of file `path`'s contents.
    pub(crate) fn hash(&self, path: &str) -> Option<[u8; 32]> {
        let source = self.files.get(path)?;
        let hash = self.hashes.get(path)?;
        Some(*hash.get_or_init(|| sha2::Sha256::digest(source.bytes()).into()))
    }

    pub(crate) fn get(&self, path: &str) -> Option<&Source> {
        self.files.get(path)
    }

    pub(crate) fn contains(&self, path: &str) -> bool {
        self.files.contains_key(path)
    }
}

/// `a/b.js`: no leading `/`, no empty, `.`, or `..` segments, no `\`.
fn is_clean(path: &str) -> bool {
    !path.is_empty()
        && !path.contains('\\')
        && path
            .split('/')
            .all(|segment| !matches!(segment, "" | "." | ".."))
}

/// A path the resolver handed back (`/src/a.ts`), as a tree path.
pub(crate) fn tree_path(path: &Path) -> Option<String> {
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::RootDir => {}
            Component::Normal(part) => parts.push(part.to_str()?),
            _ => return None,
        }
    }
    Some(parts.join("/"))
}

/// The resolver's file system: the tree, read-only, with no links.
struct TreeFs(Arc<Tree>);

impl TreeFs {
    fn lookup(&self, path: &Path) -> Option<Entry<'_>> {
        let key = tree_path(path)?;
        if let Some(source) = self.0.files.get(&key) {
            return Some(Entry::File(source));
        }
        self.0.dirs.contains(&key).then_some(Entry::Dir)
    }
}

enum Entry<'a> {
    File(&'a Source),
    Dir,
}

fn not_found() -> io::Error {
    io::Error::from(io::ErrorKind::NotFound)
}

impl FileSystem for TreeFs {
    fn new() -> Self {
        let empty = Tree {
            files: BTreeMap::new(),
            dirs: BTreeSet::from([String::new()]),
            hashes: BTreeMap::new(),
        };
        Self(Arc::new(empty))
    }

    fn read(&self, path: &Path) -> io::Result<Vec<u8>> {
        match self.lookup(path) {
            Some(Entry::File(source)) => Ok(source.bytes().to_vec()),
            _ => Err(not_found()),
        }
    }

    fn read_to_string(&self, path: &Path) -> io::Result<String> {
        match self.lookup(path) {
            Some(Entry::File(source)) => source
                .text()
                .map(str::to_string)
                .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidData)),
            _ => Err(not_found()),
        }
    }

    fn metadata(&self, path: &Path) -> io::Result<FileMetadata> {
        match self.lookup(path) {
            Some(Entry::File(_)) => Ok(FileMetadata::new(true, false, false)),
            Some(Entry::Dir) => Ok(FileMetadata::new(false, true, false)),
            None => Err(not_found()),
        }
    }

    fn symlink_metadata(&self, path: &Path) -> io::Result<FileMetadata> {
        self.metadata(path)
    }

    fn read_link(&self, path: &Path) -> Result<PathBuf, ResolveError> {
        Err(ResolveError::NotFound(path.to_string_lossy().into_owned()))
    }

    fn canonicalize(&self, path: &Path) -> io::Result<PathBuf> {
        self.lookup(path)
            .map(|_| path.to_path_buf())
            .ok_or_else(not_found)
    }
}

/// Resolves a program's imports over its tree.
pub(crate) struct Resolver(ResolverGeneric<TreeFs>);

/// The export conditions a program's imports match, in order: those of
/// workers (as Wrangler and other bundlers for Workers use), then browsers,
/// then plain ES modules.
const CONDITIONS: [&str; 5] = ["workerd", "worker", "browser", "import", "default"];

impl Resolver {
    pub(crate) fn new(tree: Arc<Tree>) -> Self {
        let strings = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let options = ResolveOptions {
            cwd: Some(PathBuf::from("/")),
            condition_names: strings(&CONDITIONS),
            extensions: strings(&[".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs", ".json"]),
            // TypeScript's own convention: `./a.js` names `./a.ts`.
            extension_alias: vec![
                (".js".into(), strings(&[".ts", ".tsx", ".js", ".jsx"])),
                (".mjs".into(), strings(&[".mts", ".mjs"])),
            ],
            main_fields: strings(&["browser", "module", "main"]),
            alias_fields: vec![vec!["browser".into()]],
            symlinks: false,
            node_path: false,
            builtin_modules: false,
            ..ResolveOptions::default()
        };
        Self(ResolverGeneric::new_with_file_system(TreeFs(tree), options))
    }

    /// The file `specifier` names, imported from the file `from` (or from
    /// the tree's root, for `None`).
    pub(crate) fn resolve(&self, from: Option<&str>, specifier: &str) -> Result<String, String> {
        let dir = match from.and_then(|path| path.rfind('/').map(|i| &path[..i])) {
            Some(dir) => format!("/{dir}"),
            None => "/".to_string(),
        };
        match self.0.resolve(&dir, specifier) {
            Ok(found) => tree_path(found.path())
                .ok_or_else(|| format!("{specifier:?} resolved outside the program")),
            Err(ResolveError::Ignored(_)) => Err(format!(
                "{specifier:?} is disabled by its package's \"browser\" field"
            )),
            Err(_) => Err(format!("Cannot find module {specifier:?}")),
        }
    }
}
