//! `URLPattern`, via the `urlpattern` crate. Ported from Deno's
//! ext/web/urlpattern.rs (MIT, the Deno authors): same op names, results,
//! and offset buffer as the JS in 01_urlpattern.js expects. The crate only
//! parses patterns into regular-expression strings; 01_urlpattern.js
//! compiles and runs those with V8's RegExp, so matching stays under the
//! watchdog.

use urlpattern::quirks;
use urlpattern::quirks::{StringOrInit, UrlPatternInit};
use urlpattern::UrlPatternOptions;

use super::{throw_range, throw_type, with_u32s_mut, Args, Rv};
use crate::js;

/// The longest pattern or match input accepted, in bytes.
const MAX_INPUT_BYTES: usize = 64 * 1024;

/// Parsing runs natively and can't be interrupted, and the crate checks each
/// of a component's regexp groups (`(...)`) by compiling the component's
/// whole regular expression again (Rust's `regex`), so its cost grows with
/// the number of groups times the size of that expression, where every
/// wildcard and named group (`*`, `:name`) becomes a capture group: 3,000
/// regexp groups, or 4 next to 30,000 wildcards, take seconds. Each
/// component's cost estimate must stay under this, which allows, say, 50
/// regexp groups in a 5 KiB pathname (about 0.1 s of parsing at worst).
const MAX_GROUP_COST: usize = 1 << 18;

/// Groups of any kind per component: the crate's handling of many
/// wildcards is quadratic (32,000 `*` take most of a second). Real patterns
/// have a handful.
const MAX_GROUPS: usize = 1024;

fn too_complex_component(s: &str) -> bool {
    let count = |c: u8| s.bytes().filter(|&b| b == c).count();
    let (regexps, others) = (count(b'('), count(b'*').saturating_add(count(b':')));
    let size = s.len().saturating_add(others.saturating_mul(16));
    regexps.saturating_add(others) > MAX_GROUPS || regexps.saturating_mul(size) > MAX_GROUP_COST
}

fn too_complex(input: &StringOrInit) -> bool {
    match input {
        // A constructor string splits into components; the whole string bounds each.
        StringOrInit::String(s) => too_complex_component(s),
        StringOrInit::Init(i) => [
            &i.protocol,
            &i.username,
            &i.password,
            &i.hostname,
            &i.port,
            &i.pathname,
            &i.search,
            &i.hash,
        ]
        .iter()
        .any(|f| f.as_deref().is_some_and(too_complex_component)),
    }
}

const COMPONENTS: [&str; 8] = [
    "protocol", "username", "password", "hostname", "port", "pathname", "search", "hash",
];

/// The URLPatternInput the JS passes (already converted by webidl): a
/// string, or a dictionary of optional strings.
fn input_arg(scope: &mut v8::PinScope, value: v8::Local<v8::Value>) -> Option<StringOrInit> {
    if value.is_string() {
        return Some(StringOrInit::String(value.to_rust_string_lossy(scope)));
    }
    let obj = value.to_object(scope)?;
    let field = |name: &str| -> Option<Option<String>> {
        let key = v8::String::new(scope, name)?;
        let v = obj.get(scope, key.into())?;
        Some(if v.is_null_or_undefined() {
            None
        } else {
            Some(v.to_rust_string_lossy(scope))
        })
    };
    Some(StringOrInit::Init(UrlPatternInit {
        protocol: field("protocol")?,
        username: field("username")?,
        password: field("password")?,
        hostname: field("hostname")?,
        port: field("port")?,
        pathname: field("pathname")?,
        search: field("search")?,
        hash: field("hash")?,
        base_url: field("baseURL")?,
    }))
}

fn input_len(input: &StringOrInit) -> usize {
    match input {
        StringOrInit::String(s) => s.len(),
        StringOrInit::Init(i) => [
            &i.protocol,
            &i.username,
            &i.password,
            &i.hostname,
            &i.port,
            &i.pathname,
            &i.search,
            &i.hash,
            &i.base_url,
        ]
        .iter()
        .map(|f| f.as_deref().map_or(0, str::len))
        .sum(),
    }
}

fn base_arg(scope: &mut v8::PinScope, value: v8::Local<v8::Value>) -> Option<String> {
    if value.is_null_or_undefined() {
        None
    } else {
        Some(value.to_rust_string_lossy(scope))
    }
}

/// The input and base URL, or a thrown error.
fn args_in(scope: &mut v8::PinScope, args: &Args) -> Option<(StringOrInit, Option<String>)> {
    let Some(input) = input_arg(scope, args.get(0)) else {
        throw_type(scope, "invalid URLPattern input");
        return None;
    };
    let base = base_arg(scope, args.get(1));
    if input_len(&input) + base.as_deref().map_or(0, str::len) > MAX_INPUT_BYTES {
        throw_range(scope, "URLPattern input is too long (over 64 KiB)");
        return None;
    }
    Some((input, base))
}

/// Turns an opaque `urlpattern` crate error into an actionable message by
/// echoing the offending pattern, pointing a caret at the failing character,
/// and adding a hint for the most common mistake (a `:` that does not start a
/// valid named group, e.g. file-router syntax like `[:slug]`). (Deno's.)
fn enrich_error(err: urlpattern::Error, input: &StringOrInit) -> String {
    let message = err.to_string();
    let pos = match err {
        urlpattern::Error::Tokenizer(_, pos) => Some(pos),
        _ => None,
    };
    // The crate parses each component separately, so `pos` indexes one
    // component's string: a caret only fits an init with one component set.
    let (pattern, caret_pos) = match input {
        StringOrInit::String(s) => (Some(("URLPattern", s.as_str())), None),
        StringOrInit::Init(init) => (single_init_component(init), pos),
    };
    let Some((name, pattern)) = pattern else {
        return message;
    };
    let mut out = format!("Failed to parse {name} from \"{pattern}\": {message}");
    if let Some(pos) = caret_pos {
        out.push_str("\n\n  ");
        out.push_str(pattern);
        out.push_str("\n  ");
        out.extend(std::iter::repeat_n(' ', pos.min(pattern.len())));
        out.push('^');
    }
    if message.contains("invalid name") {
        out.push_str(
            "\n\n  hint: \":\" starts a named group and must be followed by a name \
             (a letter or \"_\", then letters, digits or \"_\"). To match a literal \
             \":\", escape it as \"\\:\".",
        );
    }
    out
}

fn single_init_component(init: &UrlPatternInit) -> Option<(&'static str, &str)> {
    let fields = [
        &init.protocol,
        &init.username,
        &init.password,
        &init.hostname,
        &init.port,
        &init.pathname,
        &init.search,
        &init.hash,
    ];
    let mut set = COMPONENTS
        .iter()
        .zip(fields)
        .filter_map(|(name, value)| value.as_deref().map(|value| (*name, value)));
    match (set.next(), set.next()) {
        (Some(only), None) => Some(only),
        _ => None,
    }
}

fn set<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    obj: v8::Local<'s, v8::Object>,
    key: &str,
    value: v8::Local<'s, v8::Value>,
) -> Option<()> {
    let key = v8::String::new(scope, key)?;
    obj.set(scope, key.into(), value).map(|_| ())
}

fn string<'s>(scope: &mut v8::PinScope<'s, '_>, s: &str) -> Option<v8::Local<'s, v8::Value>> {
    v8::String::new(scope, s).map(Into::into)
}

fn component<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    c: &quirks::UrlPatternComponent,
) -> Option<v8::Local<'s, v8::Value>> {
    let obj = v8::Object::new(scope);
    let pattern = string(scope, &c.pattern_string)?;
    set(scope, obj, "patternString", pattern)?;
    let regexp = string(scope, &c.regexp_string)?;
    set(scope, obj, "regexpString", regexp)?;
    let names = c
        .group_name_list
        .iter()
        .map(|n| string(scope, n))
        .collect::<Option<Vec<_>>>()?;
    let names = v8::Array::new_with_elements(scope, &names);
    set(scope, obj, "groupNameList", names.into())?;
    Some(obj.into())
}

/// op_urlpattern_parse(input, baseURL, { ignoreCase }): each component's
/// pattern string, regular expression, and group names, or a TypeError.
pub fn op_urlpattern_parse(scope: &mut v8::PinScope, args: Args, mut rv: Rv) {
    let Some((input, base)) = args_in(scope, &args) else {
        return;
    };
    if too_complex(&input) {
        return throw_range(scope, "URLPattern pattern has too many groups");
    }
    let options = args.get(2);
    let ignore_case = match options.to_object(scope) {
        Some(o) => {
            let key = js::short_string(scope, "ignoreCase");
            o.get(scope, key.into())
                .is_some_and(|v| v.boolean_value(scope))
        }
        None => false,
    };
    let parsed = quirks::process_construct_pattern_input(input.clone(), base.as_deref())
        .and_then(|init| quirks::parse_pattern(init, UrlPatternOptions { ignore_case }));
    let pattern = match parsed {
        Ok(p) => p,
        Err(e) => return throw_type(scope, &enrich_error(e, &input)),
    };
    let obj = v8::Object::new(scope);
    let components = [
        &pattern.protocol,
        &pattern.username,
        &pattern.password,
        &pattern.hostname,
        &pattern.port,
        &pattern.pathname,
        &pattern.search,
        &pattern.hash,
    ];
    for (name, c) in COMPONENTS.iter().zip(components) {
        let Some(v) = component(scope, c) else {
            return throw_range(scope, "URLPattern result is too large");
        };
        if set(scope, obj, name, v).is_none() {
            return;
        }
    }
    let groups = v8::Boolean::new(scope, pattern.has_regexp_groups);
    if set(scope, obj, "hasRegexpGroups", groups.into()).is_some() {
        rv.set(obj.into());
    }
}

/// op_urlpattern_process_match_input(input, baseURL, Uint32Array(9)): the
/// eight component values concatenated, with their start offsets (and the
/// total length) written to the buffer; null if the input isn't a URL.
pub fn op_urlpattern_process_match_input(scope: &mut v8::PinScope, args: Args, mut rv: Rv) {
    let Some((input, base)) = args_in(scope, &args) else {
        return;
    };
    let processed = match quirks::process_match_input(input, base.as_deref()) {
        Ok(p) => p,
        Err(e) => return throw_type(scope, &e.to_string()),
    };
    let Some(m) = processed.and_then(|(input, _)| quirks::parse_match_input(input)) else {
        rv.set_null();
        return;
    };
    let fields = [
        &m.protocol,
        &m.username,
        &m.password,
        &m.hostname,
        &m.port,
        &m.pathname,
        &m.search,
        &m.hash,
    ];
    let mut offsets = [0u32; 9];
    let mut concat = String::with_capacity(fields.iter().map(|f| f.len()).sum());
    for (i, field) in fields.iter().enumerate() {
        // Within u32: the input is at most MAX_INPUT_BYTES, and URL parsing
        // at most triples it (percent-encoding).
        offsets[i] = concat.len() as u32;
        concat.push_str(field);
    }
    offsets[8] = concat.len() as u32;
    let stored = with_u32s_mut(scope, args.get(2), |out| match out.get_mut(..9) {
        Some(out) => {
            out.copy_from_slice(&offsets);
            true
        }
        None => false,
    });
    if stored != Some(true) {
        return throw_type(scope, "expected a Uint32Array(9)");
    }
    match string(scope, &concat) {
        Some(s) => rv.set(s),
        None => throw_range(scope, "URLPattern input is too long"),
    }
}
