//! Text and exceptions between Rust and JavaScript, for both the VM and the
//! web platform's ops:
//!
//! - `string` and `text`: a value's string form, copied out of V8 no further
//!   than a byte limit, never throwing
//! - `clip`: the same limit for Rust strings
//! - `throw` and `throw_with`: a JS exception with a clipped message, never
//!   panicking on the message (it can quote guest input)
//! - `guest_string`: a JS string for text the guest controls the size of,
//!   or a RangeError past V8's maximum string length

/// Longest message put in a thrown exception.
const MESSAGE_MAX: usize = 64 << 10;

/// `value`'s string form, at most `max` bytes of UTF-8 (cut at a character
/// boundary, with "…" after a cut). Only what's kept is copied out of V8's
/// heap, so a guest string of any size costs at most `max` bytes here.
///
/// Never throws: a value whose string conversion throws (a symbol, a
/// `toString` or `Symbol.toPrimitive` that throws, a revoked proxy) gets
/// V8's side-effect-free description instead (`Symbol(x)`, `#<Object>`).
/// Termination (the watchdog) still propagates.
pub fn string(scope: &mut v8::PinScope, value: v8::Local<v8::Value>, max: usize) -> String {
    let s = if value.is_string() {
        value.cast::<v8::String>()
    } else {
        v8::tc_scope!(let tc, scope);
        let converted = if value.is_symbol() {
            None
        } else {
            value.to_string(tc)
        };
        if tc.has_terminated() {
            tc.rethrow();
            return String::new();
        }
        tc.reset();
        match converted.or_else(|| value.to_detail_string(tc)) {
            Some(s) => s,
            None => return String::new(),
        }
    };
    let mut buf = vec![0u8; max.min(s.length().saturating_mul(3))];
    let n = s.write_utf8_v2(scope, &mut buf, v8::WriteFlags::kReplaceInvalidUtf8, None);
    buf.truncate(n);
    let mut out = String::from_utf8(buf)
        .unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned());
    if n < s.utf8_length(scope) {
        out.push('…');
    }
    out
}

/// `string`, or None once execution is terminating (the watchdog fired
/// while a conversion ran guest code).
pub fn text(scope: &mut v8::PinScope, value: v8::Local<v8::Value>, max: usize) -> Option<String> {
    let s = string(scope, value, max);
    (!scope.is_execution_terminating()).then_some(s)
}

/// The longest prefix of `s` of at most `max` bytes that ends on a
/// character boundary.
pub fn prefix(s: &str, max: usize) -> &str {
    let mut end = s.len().min(max);
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// `s`, at most `max` bytes, with "…" after a cut.
pub fn clip(mut s: String, max: usize) -> String {
    if s.len() > max {
        let end = prefix(&s, max).len();
        s.truncate(end);
        s.push('…');
    }
    s
}

/// The class of a thrown exception.
#[derive(Clone, Copy)]
pub enum Class<'a> {
    Type,
    Range,
    Syntax,
    Error,
    /// An Error whose `name` is this.
    Named(&'a str),
}

/// Throw `class` with `message` (clipped), and these string properties set
/// on it (like `code`).
pub fn throw_with(scope: &mut v8::PinScope, class: Class, message: &str, props: &[(&str, &str)]) {
    let msg = v8::String::new(scope, prefix(message, MESSAGE_MAX))
        .unwrap_or_else(|| v8::String::empty(scope));
    let error = match class {
        Class::Type => v8::Exception::type_error(scope, msg),
        Class::Range => v8::Exception::range_error(scope, msg),
        Class::Syntax => v8::Exception::syntax_error(scope, msg),
        Class::Error | Class::Named(_) => v8::Exception::error(scope, msg),
    };
    let name = match class {
        Class::Named(name) => Some(name),
        _ => None,
    };
    if let Ok(object) = v8::Local::<v8::Object>::try_from(error) {
        for (key, value) in name
            .map(|n| ("name", n))
            .into_iter()
            .chain(props.iter().copied())
        {
            if let (Some(k), Some(v)) = (
                v8::String::new(scope, key),
                v8::String::new(scope, prefix(value, MESSAGE_MAX)),
            ) {
                object.set(scope, k.into(), v.into());
            }
        }
    }
    scope.throw_exception(error);
}

pub fn throw(scope: &mut v8::PinScope, class: Class, message: &str) {
    throw_with(scope, class, message, &[]);
}

pub fn throw_type(scope: &mut v8::PinScope, message: &str) {
    throw(scope, Class::Type, message);
}

pub fn throw_range(scope: &mut v8::PinScope, message: &str) {
    throw(scope, Class::Range, message);
}

/// A JS string for text the guest can make arbitrarily long (a URL grows up
/// to 9x when percent-encoded): past V8's maximum string length, a
/// RangeError, as V8 throws for its own strings, instead of a panic.
pub fn guest_string<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    s: &str,
) -> Option<v8::Local<'s, v8::String>> {
    let string = v8::String::new(scope, s);
    if string.is_none() {
        throw_range(scope, "Invalid string length");
    }
    string
}

/// A JS string for text isolane bounds itself (property names, fixed
/// messages, values already clipped): V8 refuses only strings past its
/// maximum length, which this text never approaches.
pub fn short_string<'s>(scope: &mut v8::PinScope<'s, '_>, s: &str) -> v8::Local<'s, v8::String> {
    v8::String::new(scope, s).expect("text isolane bounds is within V8's maximum string length")
}
