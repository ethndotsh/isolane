//! `structuredClone` (core.structuredClone): a V8 ValueSerializer and
//! ValueDeserializer round trip, as in browsers' structured clone. Values it
//! can't clone (functions, symbols, SharedArrayBuffers, and platform objects
//! marked not serializable, like URL) throw a TypeError, which
//! 02_structured_clone.js turns into a DataCloneError.

use v8::{ValueDeserializerHelper, ValueSerializerHelper};

use super::{throw_type, Args, Rv};

/// The private brand Deno's `markNotSerializable` puts on the prototypes of
/// platform objects (URL, URLSearchParams) that structured clone must refuse.
fn not_serializable<'s>(scope: &mut v8::PinScope<'s, '_>) -> v8::Local<'s, v8::Private> {
    let name = v8::String::new(scope, "isolane#notSerializable").unwrap();
    v8::Private::for_api(scope, Some(name))
}

/// native.markNotSerializable(object)
pub fn mark_not_serializable(scope: &mut v8::PinScope, args: Args, _rv: Rv) {
    if let Ok(obj) = v8::Local::<v8::Object>::try_from(args.get(0)) {
        let key = not_serializable(scope);
        let yes = v8::Boolean::new(scope, true).into();
        obj.set_private(scope, key, yes);
    }
}

struct Delegate;

impl v8::ValueSerializerImpl for Delegate {
    fn throw_data_clone_error<'s>(&self, scope: &mut v8::PinScope<'s, '_>, message: v8::Local<'s, v8::String>) {
        let e = v8::Exception::type_error(scope, message);
        scope.throw_exception(e);
    }

    fn has_custom_host_object(&self, _isolate: &v8::Isolate) -> bool {
        true
    }

    /// Branded objects: Deno marks the prototype (URLPrototype), so look
    /// along the prototype chain.
    fn is_host_object<'s>(&self, scope: &mut v8::PinScope<'s, '_>, object: v8::Local<'s, v8::Object>) -> Option<bool> {
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

    fn write_host_object<'s>(
        &self,
        scope: &mut v8::PinScope<'s, '_>,
        _object: v8::Local<'s, v8::Object>,
        _serializer: &dyn v8::ValueSerializerHelper,
    ) -> Option<bool> {
        throw_type(scope, "The object could not be cloned.");
        None
    }
}

impl v8::ValueDeserializerImpl for Delegate {}

pub fn structured_clone(scope: &mut v8::PinScope, args: Args, mut rv: Rv) {
    let value = args.get(0);
    let context = scope.get_current_context();
    let data = {
        let serializer = v8::ValueSerializer::new(scope, Box::new(Delegate));
        serializer.write_header();
        if serializer.write_value(context, value) != Some(true) {
            return; // the delegate threw
        }
        serializer.release()
    };
    let deserializer = v8::ValueDeserializer::new(scope, Box::new(Delegate), &data);
    if deserializer.read_header(context) != Some(true) {
        throw_type(scope, "structuredClone: could not read the serialized value");
        return;
    }
    if let Some(v) = deserializer.read_value(context) {
        rv.set(v);
    }
}
