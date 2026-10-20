//! WHATWG URL parsing for `URL` and `URLSearchParams`, via the `url` crate.
//! Ported from Deno's ext/web/url.rs (MIT, the Deno authors): same op names,
//! component-offset buffer, and status codes as the JS in 00_url.js expects.

use std::cell::RefCell;

use url::form_urlencoded;
use url::quirks;
use url::Url;

use super::{guest_string, string_arg, throw_type, with_bytes, with_u32s_mut, Args, Rv};

#[repr(u32)]
enum ParseStatus {
    Ok = 0,
    OkSerialization = 1,
    Err,
}

const NO_PORT: u32 = 65536;

thread_local! {
    /// The serialization from the last parse, when it differs from the
    /// input; collected by op_url_get_serialization (Deno keeps it in OpState).
    static SERIALIZATION: RefCell<Option<String>> = const { RefCell::new(None) };
}

fn fill(url: &Url, buf: &mut [u32], no_port: u32) {
    let c = quirks::internal_components(url);
    buf[0] = c.scheme_end;
    buf[1] = c.username_end;
    buf[2] = c.host_start;
    buf[3] = c.host_end;
    buf[4] = c.port.map(u32::from).unwrap_or(no_port);
    buf[5] = c.path_start;
    buf[6] = c.query_start.unwrap_or(0);
    buf[7] = c.fragment_start.unwrap_or(0);
}

fn finish(url: Url, href: &str, buf: &mut [u32], no_port: u32) -> u32 {
    fill(&url, buf, no_port);
    let serialization: String = url.into();
    if serialization != href {
        SERIALIZATION.with(|s| *s.borrow_mut() = Some(serialization));
        ParseStatus::OkSerialization as u32
    } else {
        ParseStatus::Ok as u32
    }
}

fn parse_url(href: &str, base: Option<&Url>, buf: &mut [u32]) -> u32 {
    match Url::options().base_url(base).parse(href) {
        Ok(url) => finish(url, href, buf, 0),
        Err(_) => ParseStatus::Err as u32,
    }
}

/// Copy parsed components into the Uint32Array(8) the JS side reads them
/// from. Parsing fills a local array first, so no guest buffer is borrowed
/// while strings are converted or the URL is parsed.
fn store_components(scope: &mut v8::PinScope, v: v8::Local<v8::Value>, components: &[u32; 8]) -> bool {
    let stored = with_u32s_mut(scope, v, |out| match out.get_mut(..8) {
        Some(out) => {
            out.copy_from_slice(components);
            true
        }
        None => false,
    });
    if stored != Some(true) {
        throw_type(scope, "expected a Uint32Array(8)");
        return false;
    }
    true
}

pub fn op_url_parse(scope: &mut v8::PinScope, args: Args, mut rv: Rv) {
    let href = string_arg(scope, &args, 0);
    let mut components = [0u32; 8];
    let buf = &mut components;
    let status = if parse_simple_special_url(&href, buf) { ParseStatus::Ok as u32 } else { parse_url(&href, None, buf) };
    if store_components(scope, args.get(1), &components) {
        rv.set_uint32(status);
    }
}

pub fn op_url_parse_with_base(scope: &mut v8::PinScope, args: Args, mut rv: Rv) {
    let href = string_arg(scope, &args, 0);
    let base = string_arg(scope, &args, 1);
    let mut components = [0u32; 8];
    let buf = &mut components;
    let status = match Url::parse(&base) {
        Ok(base) => parse_url(&href, Some(&base), buf),
        Err(_) => ParseStatus::Err as u32,
    };
    if store_components(scope, args.get(2), &components) {
        rv.set_uint32(status);
    }
}

pub fn op_url_get_serialization(scope: &mut v8::PinScope, _args: Args, mut rv: Rv) {
    let s = SERIALIZATION.with(|s| s.borrow_mut().take()).unwrap_or_default();
    if let Some(s) = guest_string(scope, &s) {
        rv.set(s.into());
    }
}

pub fn op_url_reparse(scope: &mut v8::PinScope, args: Args, mut rv: Rv) {
    let href = string_arg(scope, &args, 0);
    let setter = args.get(1).uint32_value(scope).unwrap_or(u32::MAX);
    let value = string_arg(scope, &args, 2);
    let mut components = [0u32; 8];
    let buf = &mut components;
    let Ok(mut url) = Url::options().parse(&href) else {
        rv.set_uint32(ParseStatus::Err as u32);
        return;
    };
    let value = value.as_str();
    let result = match setter {
        0 => {
            quirks::set_hash(&mut url, value);
            Ok(())
        }
        1 => quirks::set_host(&mut url, value),
        2 => quirks::set_hostname(&mut url, value),
        3 => quirks::set_password(&mut url, value),
        4 => {
            quirks::set_pathname(&mut url, value);
            Ok(())
        }
        5 => quirks::set_port(&mut url, value),
        6 => quirks::set_protocol(&mut url, value),
        7 => {
            quirks::set_search(&mut url, value);
            Ok(())
        }
        8 => quirks::set_username(&mut url, value),
        _ => Err(()),
    };
    let status = match result {
        Ok(()) => finish(url, &href, buf, NO_PORT),
        Err(()) => ParseStatus::Err as u32,
    };
    if store_components(scope, args.get(3), &components) {
        rv.set_uint32(status);
    }
}

pub fn op_url_parse_search_params(scope: &mut v8::PinScope, args: Args, mut rv: Rv) {
    let pairs: Vec<(String, String)> = if args.get(0).is_string() {
        let s = string_arg(scope, &args, 0);
        form_urlencoded::parse(s.as_bytes()).map(|(k, v)| (k.into_owned(), v.into_owned())).collect()
    } else if let Some(pairs) =
        with_bytes(scope, args.get(1), |b| form_urlencoded::parse(b).map(|(k, v)| (k.into_owned(), v.into_owned())).collect())
    {
        pairs
    } else {
        throw_type(scope, "invalid parameters");
        return;
    };
    let list = v8::Array::new(scope, pairs.len() as i32);
    for (i, (k, v)) in pairs.iter().enumerate() {
        let (Some(k), Some(v)) = (guest_string(scope, k), guest_string(scope, v)) else { return };
        let pair = v8::Array::new_with_elements(scope, &[k.into(), v.into()]);
        list.set_index(scope, i as u32, pair.into());
    }
    rv.set(list.into());
}

pub fn op_url_stringify_search_params(scope: &mut v8::PinScope, args: Args, mut rv: Rv) {
    let Ok(list) = v8::Local::<v8::Array>::try_from(args.get(0)) else {
        throw_type(scope, "expected a list of pairs");
        return;
    };
    let mut ser = form_urlencoded::Serializer::new(String::new());
    for i in 0..list.length() {
        let Some(pair) = list.get_index(scope, i).and_then(|p| v8::Local::<v8::Array>::try_from(p).ok()) else {
            throw_type(scope, "expected a list of pairs");
            return;
        };
        let k = pair.get_index(scope, 0).map(|v| v.to_rust_string_lossy(scope)).unwrap_or_default();
        let v = pair.get_index(scope, 1).map(|v| v.to_rust_string_lossy(scope)).unwrap_or_default();
        ser.append_pair(&k, &v);
    }
    if let Some(s) = guest_string(scope, &ser.finish()) {
        rv.set(s.into());
    }
}

// Keep in sync with parseSimpleSpecialUrl() in ext/web/00_url.js.
fn parse_simple_special_url(href: &str, buf: &mut [u32]) -> bool {
  let bytes = href.as_bytes();
  let (scheme_end, default_port) = if bytes.starts_with(b"http://") {
    (4, 80u32)
  } else if bytes.starts_with(b"https://") {
    (5, 443u32)
  } else {
    return false;
  };

  let host_start = scheme_end + 3;
  let mut path_start = host_start;
  while path_start < bytes.len() && bytes[path_start] != b'/' {
    match bytes[path_start] {
      b'a'..=b'z' | b'0'..=b'9' | b'.' | b'-' | b':' => {
        path_start += 1;
      }
      _ => return false,
    }
  }
  if path_start == host_start || path_start == bytes.len() {
    return false;
  }

  let mut host_end = path_start;
  let mut port = 65536u32;
  for i in host_start..path_start {
    if bytes[i] == b':' {
      if i == host_start || i + 1 == path_start {
        return false;
      }
      host_end = i;
      port = 0;
      if i + 2 < path_start && bytes[i + 1] == b'0' {
        return false;
      }
      for &byte in &bytes[i + 1..path_start] {
        if !byte.is_ascii_digit() {
          return false;
        }
        let Some(next_port) = port
          .checked_mul(10)
          .and_then(|port| port.checked_add((byte - b'0') as u32))
        else {
          return false;
        };
        if next_port > 65535 {
          return false;
        }
        port = next_port;
      }
      if port == default_port {
        return false;
      }
      break;
    }
  }
  if !simple_special_host_is_canonical(&bytes[host_start..host_end]) {
    return false;
  }

  let mut query_start = 0u32;
  for i in path_start..bytes.len() {
    if bytes[i] == b'.'
      && i > path_start
      && bytes[i - 1] == b'/'
      && (i + 1 == bytes.len() || matches!(bytes[i + 1], b'/' | b'?' | b'.'))
    {
      return false;
    }
    if query_start != 0 && bytes[i] == b'\'' {
      return false;
    }
    match bytes[i] {
      b'a'..=b'z'
      | b'A'..=b'Z'
      | b'0'..=b'9'
      | b'/'
      | b'.'
      | b'_'
      | b'~'
      | b'-'
      | b'!'
      | b'$'
      | b'&'
      | b'\''
      | b'('
      | b')'
      | b'*'
      | b'+'
      | b','
      | b';'
      | b'='
      | b':'
      | b'@' => {}
      b'?' if query_start == 0 => query_start = i as u32,
      _ => return false,
    }
  }

  buf[0] = scheme_end as u32;
  buf[1] = host_start as u32;
  buf[2] = host_start as u32;
  buf[3] = host_end as u32;
  buf[4] = port;
  buf[5] = path_start as u32;
  buf[6] = query_start;
  buf[7] = 0;
  true
}

fn simple_special_host_is_canonical(host: &[u8]) -> bool {
  if host.is_empty() || host[0] == b'.' || host[host.len() - 1] == b'.' {
    return false;
  }

  if host
    .iter()
    .all(|byte| byte.is_ascii_digit() || *byte == b'.')
  {
    let mut dots = 0;
    let mut part = 0u32;
    let mut part_len = 0;
    for (i, &byte) in host.iter().enumerate() {
      if byte == b'.' {
        if part_len == 0
          || part > 255
          || (part_len > 1 && host[i - part_len] == b'0')
        {
          return false;
        }
        dots += 1;
        part = 0;
        part_len = 0;
        continue;
      }
      part = part * 10 + (byte - b'0') as u32;
      part_len += 1;
      if part_len > 3 {
        return false;
      }
    }
    return dots == 3
      && part_len != 0
      && part <= 255
      && (part_len == 1 || host[host.len() - part_len] != b'0');
  }

  if host[0].is_ascii_digit() {
    return false;
  }

  let mut label_len = 0;
  let mut label_start = 0;
  let mut final_label_all_digits = true;
  for (i, &byte) in host.iter().enumerate() {
    match byte {
      b'a'..=b'z' | b'0'..=b'9' | b'-' => {
        if !byte.is_ascii_digit() {
          final_label_all_digits = false;
        }
        label_len += 1;
      }
      b'.' => {
        if label_len == 0 {
          return false;
        }
        label_len = 0;
        label_start = i + 1;
        final_label_all_digits = true;
      }
      _ => return false,
    }
    if i == label_start + 3 && &host[label_start..=i] == b"xn--" {
      return false;
    }
  }
  label_len != 0
    && !final_label_all_digits
    && !(label_len >= 2 && &host[label_start..label_start + 2] == b"0x")
}
