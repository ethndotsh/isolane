//! `isolane:files`: the program's own files, read-only, with the names and
//! shapes `node:fs` gives them: `readFileSync`, `existsSync`,
//! `readdirSync`, `statSync`, and `promises.{readFile, readdir, stat}`. A
//! path is the program's (`/src/data.json`, or `src/data.json` from the
//! root) or a `file:` URL (`new URL('./data.json', import.meta.url)`).
//!
//! Reading them isn't I/O: the files are the worker's own memory, sent
//! with the load, and reading one can't wait on or reach anything outside
//! the isolate. So they can be read during setup, unlike `fs`, which
//! reaches the host's disk through a host call.

use std::path::Path;

use super::tree::{normalize, tree_path, Source, Tree};
use crate::js;

/// The module's specifier.
pub(super) const SPECIFIER: &str = "isolane:files";

/// Longest path read from an argument.
const PATH_MAX: usize = 4096;

/// Why an operation failed: an error to throw or reject with, or an
/// exception already pending (a conversion that ran guest code threw).
enum Fail<'s> {
    Error(v8::Local<'s, v8::Value>),
    Thrown,
}

type Outcome<'s> = Result<v8::Local<'s, v8::Value>, Fail<'s>>;

/// The module's exports: the functions, `promises`, and all of them as
/// the default export (as `import fs from 'node:fs'` has them).
pub(super) fn exports<'s>(scope: &mut v8::PinScope<'s, '_>) -> v8::Local<'s, v8::Object> {
    let promises = v8::Object::new(scope);
    let functions = [
        ("readFile", v8::Function::new(scope, read_file_async)),
        ("readdir", v8::Function::new(scope, readdir_async)),
        ("stat", v8::Function::new(scope, stat_async)),
    ];
    put(scope, promises, functions);
    let functions = [
        ("readFileSync", v8::Function::new(scope, read_file_sync)),
        ("existsSync", v8::Function::new(scope, exists_sync)),
        ("readdirSync", v8::Function::new(scope, readdir_sync)),
        ("statSync", v8::Function::new(scope, stat_sync)),
    ];
    let all = v8::Object::new(scope);
    let exports = v8::Object::new(scope);
    put(scope, all, functions);
    put(scope, exports, functions);
    for (object, name, value) in [
        (all, "promises", promises),
        (exports, "promises", promises),
        (exports, "default", all),
    ] {
        let key = js::short_string(scope, name);
        object.create_data_property(scope, key.into(), value.into());
    }
    exports
}

/// Set each of `functions` on `object` by its name.
fn put<const N: usize>(
    scope: &mut v8::PinScope,
    object: v8::Local<v8::Object>,
    functions: [(&str, Option<v8::Local<v8::Function>>); N],
) {
    for (name, function) in functions {
        let Some(function) = function else {
            continue;
        };
        let key = js::short_string(scope, name);
        function.set_name(key);
        object.create_data_property(scope, key.into(), function.into());
    }
}

// ---- the operations ----

/// `readFileSync(path, options)`: the file's bytes, or its text for
/// encoding `utf8` (`options` is the encoding, or `{ encoding }`).
fn read_file<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    path: v8::Local<'s, v8::Value>,
    options: v8::Local<'s, v8::Value>,
) -> Outcome<'s> {
    let text = wants_text(scope, options)?;
    let (tree, path) = lookup(scope, path)?;
    let Some(source) = tree.get(&path) else {
        let (code, what) = if tree.is_dir(&path) {
            ("EISDIR", "illegal operation on a directory")
        } else {
            ("ENOENT", "no such file or directory")
        };
        return Err(fs_error(scope, code, what, "open", &path));
    };
    if !text {
        return Ok(crate::bytes::new_u8array(scope, source.bytes()).into());
    }
    let decoded;
    let text = match source {
        Source::Text(text) => text.as_str(),
        Source::Bytes(bytes) => {
            decoded = String::from_utf8_lossy(bytes);
            &decoded
        }
    };
    js::guest_string(scope, text)
        .map(Into::into)
        .ok_or(Fail::Thrown)
}

/// `existsSync(path)`: whether it's a file or directory of the program
/// (false for what isn't a path).
fn exists<'s>(scope: &mut v8::PinScope<'s, '_>, path: v8::Local<'s, v8::Value>) -> Outcome<'s> {
    let found = match lookup(scope, path) {
        Ok((tree, path)) => tree.contains(&path) || tree.is_dir(&path),
        Err(Fail::Thrown) => return Err(Fail::Thrown),
        Err(Fail::Error(_)) => false,
    };
    Ok(v8::Boolean::new(scope, found).into())
}

/// `readdirSync(path)`: the names in a directory, sorted.
fn readdir<'s>(scope: &mut v8::PinScope<'s, '_>, path: v8::Local<'s, v8::Value>) -> Outcome<'s> {
    let (tree, path) = lookup(scope, path)?;
    let Some(names) = tree.list(&path) else {
        let (code, what) = if tree.contains(&path) {
            ("ENOTDIR", "not a directory")
        } else {
            ("ENOENT", "no such file or directory")
        };
        return Err(fs_error(scope, code, what, "scandir", &path));
    };
    let mut elements = Vec::with_capacity(names.len());
    for name in names {
        elements.push(js::guest_string(scope, &name).ok_or(Fail::Thrown)?.into());
    }
    Ok(v8::Array::new_with_elements(scope, &elements).into())
}

/// `statSync(path)`: `{ size, isFile(), isDirectory() }`.
fn stat<'s>(scope: &mut v8::PinScope<'s, '_>, path: v8::Local<'s, v8::Value>) -> Outcome<'s> {
    let (tree, path) = lookup(scope, path)?;
    let size = match tree.get(&path) {
        Some(source) => Some(source.bytes().len()),
        None if tree.is_dir(&path) => None,
        None => {
            return Err(fs_error(
                scope,
                "ENOENT",
                "no such file or directory",
                "stat",
                &path,
            ))
        }
    };
    let stats = v8::Object::new(scope);
    let size_value = v8::Number::new(scope, size.unwrap_or(0) as f64);
    let key = js::short_string(scope, "size");
    stats.create_data_property(scope, key.into(), size_value.into());
    for (name, value) in [("isFile", size.is_some()), ("isDirectory", size.is_none())] {
        let value = v8::Boolean::new(scope, value);
        let function = v8::Function::builder(super::give_data)
            .data(value.into())
            .build(scope)
            .ok_or(Fail::Thrown)?;
        let key = js::short_string(scope, name);
        stats.create_data_property(scope, key.into(), function.into());
    }
    Ok(stats.into())
}

// ---- paths and errors ----

/// The program's tree and the tree path `value` names.
fn lookup<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    value: v8::Local<'s, v8::Value>,
) -> Result<(std::sync::Arc<Tree>, String), Fail<'s>> {
    let path = program_path(scope, value)?;
    let files = super::program(scope).files.borrow().clone();
    match files {
        Some(files) => Ok((std::sync::Arc::clone(&files.tree), path)),
        None => Err(Fail::Error(js::error_with(
            scope,
            js::Class::Error,
            "isolane:files is for programs (tenant.load)",
            &[],
        ))),
    }
}

/// The tree path a path argument names: a string (a path, or a `file:`
/// URL) or a URL object.
fn program_path<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    value: v8::Local<'s, v8::Value>,
) -> Result<String, Fail<'s>> {
    let (text, is_url) = if value.is_string() {
        let text = js::string(scope, value, PATH_MAX);
        let is_url = text.starts_with("file:");
        (text, is_url)
    } else if let Ok(object) = v8::Local::<v8::Object>::try_from(value) {
        let key = js::short_string(scope, "href");
        let href = object.get(scope, key.into()).ok_or(Fail::Thrown)?;
        if !href.is_string() {
            return Err(invalid_path(scope));
        }
        (js::string(scope, href, PATH_MAX), true)
    } else {
        return Err(invalid_path(scope));
    };
    if !is_url {
        return Ok(normalize(&text));
    }
    let file = url::Url::parse(&text)
        .ok()
        .filter(|url| url.scheme() == "file")
        .and_then(|url| url.to_file_path().ok())
        .and_then(|path| tree_path(Path::new(&path)));
    match file {
        Some(path) => Ok(normalize(&path)),
        None => Err(Fail::Error(js::error_with(
            scope,
            js::Class::Type,
            &format!("The URL {text:?} must be a file: URL with an absolute path"),
            &[("code", "ERR_INVALID_URL_SCHEME")],
        ))),
    }
}

fn invalid_path<'s>(scope: &mut v8::PinScope<'s, '_>) -> Fail<'s> {
    Fail::Error(js::error_with(
        scope,
        js::Class::Type,
        "The \"path\" argument must be of type string or an instance of URL",
        &[("code", "ERR_INVALID_ARG_TYPE")],
    ))
}

/// Whether `options` asks for text: an encoding of `utf8` (or `utf-8`),
/// as a string or `{ encoding }`. Bytes for none.
fn wants_text<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    options: v8::Local<'s, v8::Value>,
) -> Result<bool, Fail<'s>> {
    let encoding = if let Ok(object) = v8::Local::<v8::Object>::try_from(options) {
        let key = js::short_string(scope, "encoding");
        object.get(scope, key.into()).ok_or(Fail::Thrown)?
    } else {
        options
    };
    if encoding.is_null_or_undefined() {
        return Ok(false);
    }
    let name = js::string(scope, encoding, 64);
    if matches!(name.to_ascii_lowercase().as_str(), "utf8" | "utf-8") {
        return Ok(true);
    }
    Err(Fail::Error(js::error_with(
        scope,
        js::Class::Type,
        &format!("The encoding {name:?} is not supported: isolane:files reads bytes, or utf8 text"),
        &[("code", "ERR_INVALID_ARG_VALUE")],
    )))
}

/// An error as Node.js's file system gives one: `ENOENT: no such file or
/// directory, open '/src/a.json'`, with `code`, `syscall`, and `path`.
fn fs_error<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    code: &str,
    what: &str,
    syscall: &str,
    path: &str,
) -> Fail<'s> {
    let path = format!("/{path}");
    let message = format!("{code}: {what}, {syscall} '{path}'");
    Fail::Error(js::error_with(
        scope,
        js::Class::Error,
        &message,
        &[("code", code), ("syscall", syscall), ("path", &path)],
    ))
}

// ---- the functions ----

/// Return what an operation made, or throw why it failed.
fn give(scope: &mut v8::PinScope, outcome: Outcome, mut rv: v8::ReturnValue<v8::Value>) {
    match outcome {
        Ok(value) => rv.set(value),
        Err(Fail::Error(error)) => {
            scope.throw_exception(error);
        }
        Err(Fail::Thrown) => {}
    }
}

/// Return a promise settled with what an operation made, or rejected with
/// why it failed (or with the exception it threw).
fn promise<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    op: impl FnOnce(&mut v8::PinScope<'s, '_>) -> Outcome<'s>,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let Some(resolver) = v8::PromiseResolver::new(scope) else {
        return;
    };
    v8::tc_scope!(let tc, scope);
    match op(tc) {
        Ok(value) => {
            resolver.resolve(tc, value);
        }
        Err(Fail::Error(error)) => {
            resolver.reject(tc, error);
        }
        Err(Fail::Thrown) => {
            if tc.is_execution_terminating() {
                tc.rethrow();
                return;
            }
            let error = tc.exception().unwrap_or_else(|| v8::undefined(tc).into());
            tc.reset();
            resolver.reject(tc, error);
        }
    }
    rv.set(resolver.get_promise(tc).into());
}

fn read_file_sync<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    args: v8::FunctionCallbackArguments<'s>,
    rv: v8::ReturnValue<v8::Value>,
) {
    let outcome = read_file(scope, args.get(0), args.get(1));
    give(scope, outcome, rv);
}

fn exists_sync<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    args: v8::FunctionCallbackArguments<'s>,
    rv: v8::ReturnValue<v8::Value>,
) {
    let outcome = exists(scope, args.get(0));
    give(scope, outcome, rv);
}

fn readdir_sync<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    args: v8::FunctionCallbackArguments<'s>,
    rv: v8::ReturnValue<v8::Value>,
) {
    let outcome = readdir(scope, args.get(0));
    give(scope, outcome, rv);
}

fn stat_sync<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    args: v8::FunctionCallbackArguments<'s>,
    rv: v8::ReturnValue<v8::Value>,
) {
    let outcome = stat(scope, args.get(0));
    give(scope, outcome, rv);
}

fn read_file_async<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    args: v8::FunctionCallbackArguments<'s>,
    rv: v8::ReturnValue<v8::Value>,
) {
    let (path, options) = (args.get(0), args.get(1));
    promise(scope, |scope| read_file(scope, path, options), rv);
}

fn readdir_async<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    args: v8::FunctionCallbackArguments<'s>,
    rv: v8::ReturnValue<v8::Value>,
) {
    let path = args.get(0);
    promise(scope, |scope| readdir(scope, path), rv);
}

fn stat_async<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    args: v8::FunctionCallbackArguments<'s>,
    rv: v8::ReturnValue<v8::Value>,
) {
    let path = args.get(0);
    promise(scope, |scope| stat(scope, path), rv);
}
