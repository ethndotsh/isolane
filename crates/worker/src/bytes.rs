//! Guest ArrayBuffer memory, for the web platform's ops and host calls.
//! Every access goes through `locate` (the backing store held, the range
//! checked against its current length, shared buffers refused) and a
//! closure that gets no scope, so no JavaScript runs while a Rust slice of
//! guest memory exists.

/// Where the bytes of an ArrayBuffer or a view of one are, right now: the
/// buffer's backing store (held, so the memory can't be freed under us)
/// and the byte range within it, checked against the store's current
/// length. None for anything else, and for SharedArrayBuffers (guests have
/// none; their memory could change under a Rust slice).
fn locate(scope: &mut v8::PinScope, value: v8::Local<v8::Value>) -> Option<(v8::SharedRef<v8::BackingStore>, usize, usize)> {
    let (buffer, offset, len) = if let Ok(view) = v8::Local::<v8::ArrayBufferView>::try_from(value) {
        (view.buffer(scope)?, view.byte_offset(), view.byte_length())
    } else if let Ok(buffer) = v8::Local::<v8::ArrayBuffer>::try_from(value) {
        let len = buffer.byte_length();
        (buffer, 0, len)
    } else {
        return None;
    };
    let store = buffer.get_backing_store();
    if store.is_shared() || offset.checked_add(len)? > store.byte_length() {
        return None;
    }
    Some((store, offset, len))
}

/// Run `f` over the bytes of an ArrayBuffer or a view of one (an empty
/// slice for a detached or zero-length one). `f` gets no scope, so no
/// JavaScript can run while the slice exists: guest code can't resize,
/// transfer, or detach the buffer underneath it. Callers that also need
/// the scope copy what they need out first.
pub fn with_bytes<R>(scope: &mut v8::PinScope, value: v8::Local<v8::Value>, f: impl FnOnce(&[u8]) -> R) -> Option<R> {
    let (store, offset, len) = locate(scope, value)?;
    match store.data() {
        // SAFETY: [offset, offset + len) is within the store's current
        // length (checked in `locate`); `store` keeps the memory alive; it
        // isn't shared, and no JS runs during `f`, so nothing else touches
        // it while the slice exists.
        Some(base) if len > 0 => Some(f(unsafe { std::slice::from_raw_parts((base.as_ptr() as *const u8).add(offset), len) })),
        _ => Some(f(&[])),
    }
}

/// `with_bytes`, writable.
pub fn with_bytes_mut<R>(scope: &mut v8::PinScope, value: v8::Local<v8::Value>, f: impl FnOnce(&mut [u8]) -> R) -> Option<R> {
    let (store, offset, len) = locate(scope, value)?;
    match store.data() {
        // SAFETY: as in `with_bytes`; and this is the only reference to
        // the range while `f` runs.
        Some(base) if len > 0 => Some(f(unsafe { std::slice::from_raw_parts_mut((base.as_ptr() as *mut u8).add(offset), len) })),
        _ => Some(f(&mut [])),
    }
}

/// `with_bytes_mut` over a Uint32Array's elements (Deno's
/// `#[buffer] &mut [u32]`). None if the bytes aren't 4-byte aligned.
pub fn with_u32s_mut<R>(scope: &mut v8::PinScope, value: v8::Local<v8::Value>, f: impl FnOnce(&mut [u32]) -> R) -> Option<R> {
    with_bytes_mut(scope, value, |b| {
        if b.is_empty() {
            return Some(f(&mut []));
        }
        if !(b.as_ptr() as usize).is_multiple_of(std::mem::align_of::<u32>()) {
            return None;
        }
        // SAFETY: aligned (checked), within `b`, and u32 has no invalid bit
        // patterns; the borrow of `b` covers it.
        Some(f(unsafe { std::slice::from_raw_parts_mut(b.as_mut_ptr() as *mut u32, b.len() / 4) }))
    })
    .flatten()
}

/// A copy of the bytes of an ArrayBuffer or a view of one.
pub fn copy_bytes(scope: &mut v8::PinScope, value: v8::Local<v8::Value>) -> Option<Vec<u8>> {
    with_bytes(scope, value, <[u8]>::to_vec)
}

/// A new Uint8Array with a copy of `data`, allocated by V8 (inside the V8
/// sandbox, unlike a backing store handed over from Rust).
pub fn new_u8array<'s>(scope: &mut v8::PinScope<'s, '_>, data: &[u8]) -> v8::Local<'s, v8::Uint8Array> {
    let buffer = v8::ArrayBuffer::new(scope, data.len());
    if let Some(p) = buffer.data() {
        // SAFETY: a fresh buffer of exactly data.len() bytes that no one
        // else references yet.
        unsafe { std::ptr::copy_nonoverlapping(data.as_ptr(), p.as_ptr() as *mut u8, data.len()) };
    }
    v8::Uint8Array::new(scope, buffer, 0, data.len()).unwrap()
}
