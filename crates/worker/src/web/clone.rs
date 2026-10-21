//! Structured clone (core.structuredClone, core.serialize, core.deserialize):
//! V8's ValueSerializer and ValueDeserializer, as in browsers and deno_core.
//! Values it can't clone (functions, symbols, SharedArrayBuffers, and
//! platform objects marked not serializable, like URL) throw a TypeError, or
//! call the caller's error callback (13_message_port.js turns either into a
//! DataCloneError).
//!
//! Transfer stays inside the isolate, which is all a guest can reach: a
//! transferred ArrayBuffer's backing store moves to a new ArrayBuffer
//! object, and the original is detached. The new one rides along with the
//! message, in the `transferredArrayBuffers` array, until the message is
//! deserialized (deno_core keeps them in a cross-thread store by id
//! instead). Transferred platform objects (MessagePort) are listed in
//! `hostObjects` and written by index.

use v8::{ValueDeserializerHelper, ValueSerializerHelper};

use super::{new_u8array, throw_type, with_bytes, Args, Rv};
use crate::js;

/// The private brand Deno's `markNotSerializable` puts on the prototypes of
/// platform objects (URL, URLSearchParams) that structured clone must refuse.
fn not_serializable<'s>(scope: &mut v8::PinScope<'s, '_>) -> v8::Local<'s, v8::Private> {
    let name = js::short_string(scope, "isolane#notSerializable");
    v8::Private::for_api(scope, Some(name))
}

/// Where native.setHostObject keeps an object's clone function: a private,
/// which guest code can't see or reach (unlike `hostObjectBrand`, a
/// registered symbol). For objects whose clone data is secret: a CryptoKey's
/// is its key material, which `extractable: false` keeps from the guest.
fn host_object<'s>(scope: &mut v8::PinScope<'s, '_>) -> v8::Local<'s, v8::Private> {
    let name = js::short_string(scope, "isolane#hostObject");
    v8::Private::for_api(scope, Some(name))
}

/// native.setHostObject(object, describe): `object` clones as
/// `describe()`'s data, rebuilt by the deserializer registered with
/// core.registerPrivateCloneable for its `type`.
pub fn set_host_object(scope: &mut v8::PinScope, args: Args, _rv: Rv) {
    if let (Ok(obj), Ok(f)) = (v8::Local::<v8::Object>::try_from(args.get(0)), v8::Local::<v8::Function>::try_from(args.get(1))) {
        let key = host_object(scope);
        obj.set_private(scope, key, f.into());
    }
}

/// The prefix of a private cloneable's deserializer name. Data that clones
/// through `hostObjectBrand` (which guest code can attach to anything) can't
/// name one, so guest code can't forge a CryptoKey from bytes of its choice.
const PRIVATE_TYPE: &str = "\0";

/// native.markNotSerializable(object)
pub fn mark_not_serializable(scope: &mut v8::PinScope, args: Args, _rv: Rv) {
    if let Ok(obj) = v8::Local::<v8::Object>::try_from(args.get(0)) {
        let key = not_serializable(scope);
        let yes: v8::Local<v8::Value> = v8::Boolean::new(scope, true).into();
        obj.set_private(scope, key, yes);
    }
}

/// Is `object`, or anything on its prototype chain, marked not serializable?
fn refused(scope: &mut v8::PinScope, object: v8::Local<v8::Object>) -> Option<bool> {
    let key = not_serializable(scope);
    let mut current = Some(object);
    while let Some(obj) = current {
        if obj.has_private(scope, key)? {
            return Some(true);
        }
        current = obj.get_prototype(scope).and_then(|p| v8::Local::<v8::Object>::try_from(p).ok());
    }
    Some(false)
}

/// Platform objects with a `hostObjectBrand` method (Blob, File) clone as
/// that method's data and are rebuilt by the deserializer registered for its
/// `type` (core.registerCloneableResource), in-band like deno_core: a
/// u32::MAX marker, then the data. Transferred objects (MessagePort, streams)
/// are in `host_objects`, and are written as their index there.
#[derive(Default)]
struct Delegate {
    brand: Option<v8::Global<v8::Symbol>>,
    deserializers: Option<v8::Global<v8::Object>>,
    host_objects: Option<v8::Global<v8::Array>>,
    error_callback: Option<v8::Global<v8::Function>>,
}

const IN_BAND: u32 = u32::MAX;
/// In-band data from native.setHostObject's function.
const IN_BAND_PRIVATE: u32 = u32::MAX - 1;

impl Delegate {
    /// A clone error: the error callback's exception if it throws (it's
    /// meant to), else a TypeError.
    fn clone_error(&self, scope: &mut v8::PinScope, message: v8::Local<v8::String>) {
        if let Some(cb) = &self.error_callback {
            let cb = v8::Local::new(scope, cb);
            v8::tc_scope!(let tc, scope);
            let recv: v8::Local<v8::Value> = v8::undefined(tc).into();
            cb.call(tc, recv, &[message.into()]);
            if tc.has_caught() || tc.has_terminated() {
                tc.rethrow();
                return;
            }
        }
        let e = v8::Exception::type_error(scope, message);
        scope.throw_exception(e);
    }
}

impl v8::ValueSerializerImpl for Delegate {
    fn throw_data_clone_error<'s>(&self, scope: &mut v8::PinScope<'s, '_>, message: v8::Local<'s, v8::String>) {
        self.clone_error(scope, message);
    }

    fn has_custom_host_object(&self, _isolate: &v8::Isolate) -> bool {
        true
    }

    /// Branded objects: Deno marks the prototype (URLPrototype), so look
    /// along the prototype chain.
    fn is_host_object<'s>(&self, scope: &mut v8::PinScope<'s, '_>, object: v8::Local<'s, v8::Object>) -> Option<bool> {
        if refused(scope, object)? {
            return Some(true);
        }
        let private = host_object(scope);
        if object.has_private(scope, private)? {
            return Some(true);
        }
        match &self.brand {
            Some(brand) => {
                let brand = v8::Local::new(scope, brand);
                object.has(scope, brand.into())
            }
            None => Some(false),
        }
    }

    fn write_host_object<'s>(
        &self,
        scope: &mut v8::PinScope<'s, '_>,
        object: v8::Local<'s, v8::Object>,
        serializer: &dyn v8::ValueSerializerHelper,
    ) -> Option<bool> {
        // Transferred (MessagePort, or a stream, which isn't serializable
        // but is transferable).
        if let Some(list) = &self.host_objects {
            let list = v8::Local::new(scope, list);
            for i in 0..list.length() {
                if list.get_index(scope, i).is_some_and(|v| v.strict_equals(object.into())) {
                    serializer.write_uint32(i);
                    return Some(true);
                }
            }
        }
        if !refused(scope, object)? {
            let private = host_object(scope);
            if let Ok(f) = v8::Local::<v8::Function>::try_from(object.get_private(scope, private)?) {
                let data = f.call(scope, object.into(), &[])?;
                serializer.write_uint32(IN_BAND_PRIVATE);
                let context = scope.get_current_context();
                return serializer.write_value(context, data);
            }
            if let Some(brand) = &self.brand {
                let brand = v8::Local::new(scope, brand);
                let method = object.get(scope, brand.into())?;
                if let Ok(f) = v8::Local::<v8::Function>::try_from(method) {
                    let data = f.call(scope, object.into(), &[])?;
                    serializer.write_uint32(IN_BAND);
                    let context = scope.get_current_context();
                    return serializer.write_value(context, data);
                }
            }
        }
        let message = js::short_string(scope, "The object could not be cloned.");
        self.clone_error(scope, message);
        None
    }
}

impl v8::ValueDeserializerImpl for Delegate {
    fn read_host_object<'s>(
        &self,
        scope: &mut v8::PinScope<'s, '_>,
        deserializer: &dyn v8::ValueDeserializerHelper,
    ) -> Option<v8::Local<'s, v8::Object>> {
        let mut tag = 0;
        if !deserializer.read_uint32(&mut tag) {
            return None;
        }
        if tag != IN_BAND && tag != IN_BAND_PRIVATE {
            let list = v8::Local::new(scope, self.host_objects.as_ref()?);
            return list.get_index(scope, tag)?.to_object(scope);
        }
        let context = scope.get_current_context();
        let data = deserializer.read_value(context)?;
        let deserializers = v8::Local::new(scope, self.deserializers.as_ref()?);
        let obj = data.to_object(scope)?;
        let key = js::short_string(scope, "type");
        let ty = obj.get(scope, key.into())?.to_rust_string_lossy(scope);
        let name = match tag {
            IN_BAND_PRIVATE => format!("{PRIVATE_TYPE}{ty}"),
            _ if ty.starts_with(PRIVATE_TYPE) => return None,
            _ => ty,
        };
        let name = v8::String::new(scope, &name)?;
        let f = v8::Local::<v8::Function>::try_from(deserializers.get(scope, name.into())?).ok()?;
        // V8 forbids running JS while deserializing, unless asked.
        let scope = std::pin::pin!(v8::AllowJavascriptExecutionScope::new(scope));
        let scope = &mut scope.init();
        let recv: v8::Local<v8::Value> = v8::null(scope).into();
        f.call(scope, recv, &[data])?.to_object(scope)
    }
}

fn global<'a, T>(scope: &mut v8::PinScope, value: v8::Local<'a, v8::Value>) -> Option<v8::Global<T>>
where
    v8::Local<'a, T>: TryFrom<v8::Local<'a, v8::Value>>,
{
    v8::Local::<T>::try_from(value).ok().map(|v| v8::Global::new(scope, v))
}

/// Serialize `value` with `writer`, transferring the ArrayBuffers in
/// `transfer` (each replaced, in the array, by the new ArrayBuffer that now
/// owns its memory). None if something threw.
fn serialize(
    scope: &mut v8::PinScope,
    writer: Delegate,
    value: v8::Local<v8::Value>,
    transfer: Option<v8::Local<v8::Array>>,
) -> Option<Vec<u8>> {
    let context = scope.get_current_context();
    let mut buffers = Vec::new();
    if let Some(transfer) = transfer {
        for i in 0..transfer.length() {
            let item = transfer.get_index(scope, i)?;
            let Ok(buffer) = v8::Local::<v8::ArrayBuffer>::try_from(item) else {
                throw_type(scope, "Value not transferable");
                return None;
            };
            if !buffer.is_detachable() || buffer.was_detached() {
                let message = if buffer.was_detached() {
                    format!("ArrayBuffer at index {i} is already detached")
                } else {
                    format!("ArrayBuffer at index {i} is not transferable")
                };
                let message = js::short_string(scope, &message);
                writer.clone_error(scope, message);
                return None;
            }
            buffers.push(buffer);
        }
    }
    let serializer = v8::ValueSerializer::new(scope, Box::new(writer));
    serializer.write_header();
    for (i, buffer) in buffers.iter().enumerate() {
        serializer.transfer_array_buffer(i as u32, *buffer);
    }
    if serializer.write_value(context, value) != Some(true) {
        return None; // the delegate threw
    }
    let data = serializer.release();
    // Only now, once V8 has read them: a view onto a buffer detached early
    // fails to serialize.
    if let Some(transfer) = transfer {
        for (i, buffer) in buffers.iter().enumerate() {
            let moved = v8::ArrayBuffer::with_backing_store(scope, &buffer.get_backing_store());
            buffer.detach(None)?;
            transfer.set_index(scope, i as u32, moved.into())?;
        }
    }
    Some(data)
}

/// Deserialize `data` with `reader`, the transferred ArrayBuffers in
/// `transfer` taking their places.
fn deserialize<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    reader: Delegate,
    data: &[u8],
    transfer: Option<v8::Local<v8::Array>>,
) -> Option<v8::Local<'s, v8::Value>> {
    let context = scope.get_current_context();
    let deserializer = v8::ValueDeserializer::new(scope, Box::new(reader), data);
    if deserializer.read_header(context) != Some(true) {
        throw_type(scope, "could not deserialize value");
        return None;
    }
    if let Some(transfer) = transfer {
        for i in 0..transfer.length() {
            let item = transfer.get_index(scope, i)?;
            let Ok(buffer) = v8::Local::<v8::ArrayBuffer>::try_from(item) else {
                throw_type(scope, "item in transferredArrayBuffers not an ArrayBuffer");
                return None;
            };
            deserializer.transfer_array_buffer(i, buffer);
        }
    }
    deserializer.read_value(context)
}

/// native.structuredClone(value, hostObjectBrand, deserializers)
pub fn structured_clone(scope: &mut v8::PinScope, args: Args, mut rv: Rv) {
    let delegate = |scope: &mut v8::PinScope| Delegate {
        brand: global(scope, args.get(1)),
        deserializers: global(scope, args.get(2)),
        ..Default::default()
    };
    let (writer, reader) = (delegate(scope), delegate(scope));
    let Some(data) = serialize(scope, writer, args.get(0), None) else { return };
    if let Some(v) = deserialize(scope, reader, &data, None) {
        rv.set(v);
    }
}

/// native.serialize(value, hostObjectBrand, hostObjects,
/// transferredArrayBuffers, errorCallback) → Uint8Array: deno_core's
/// op_serialize.
pub fn serialize_op(scope: &mut v8::PinScope, args: Args, mut rv: Rv) {
    let writer = Delegate {
        brand: global(scope, args.get(1)),
        host_objects: global(scope, args.get(2)),
        error_callback: global(scope, args.get(4)),
        ..Default::default()
    };
    let transfer = v8::Local::<v8::Array>::try_from(args.get(3)).ok();
    if let Some(data) = serialize(scope, writer, args.get(0), transfer) {
        rv.set(new_u8array(scope, &data).into());
    }
}

/// native.deserialize(buffer, hostObjectBrand, hostObjects,
/// transferredArrayBuffers, deserializers): deno_core's op_deserialize.
pub fn deserialize_op(scope: &mut v8::PinScope, args: Args, mut rv: Rv) {
    let reader = Delegate {
        brand: global(scope, args.get(1)),
        host_objects: global(scope, args.get(2)),
        deserializers: global(scope, args.get(4)),
        ..Default::default()
    };
    let transfer = v8::Local::<v8::Array>::try_from(args.get(3)).ok();
    // A copy: deserializing runs JS (a Blob's deserializer), which could
    // otherwise change the buffer under V8's reader.
    let Some(data) = with_bytes(scope, args.get(0), <[u8]>::to_vec) else {
        throw_type(scope, "expected a buffer");
        return;
    };
    if let Some(v) = deserialize(scope, reader, &data, transfer) {
        rv.set(v);
    }
}
