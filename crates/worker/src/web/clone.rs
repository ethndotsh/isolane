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

/// Platform objects with a `hostObjectBrand` method (Blob, File) clone as
/// that method's data and are rebuilt by the deserializer registered for its
/// `type` (core.registerCloneableResource), in-band like deno_core: a
/// u32::MAX marker, then the data.
struct Delegate {
    brand: Option<v8::Global<v8::Symbol>>,
    deserializers: Option<v8::Global<v8::Object>>,
}

const IN_BAND: u32 = u32::MAX;

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
        let key = not_serializable(scope);
        let mut refused = false;
        let mut current = Some(object);
        while let Some(obj) = current {
            if obj.has_private(scope, key)? {
                refused = true;
                break;
            }
            current = obj.get_prototype(scope).and_then(|p| v8::Local::<v8::Object>::try_from(p).ok());
        }
        if !refused {
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
        throw_type(scope, "The object could not be cloned.");
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
        if !deserializer.read_uint32(&mut tag) || tag != IN_BAND {
            return None;
        }
        let context = scope.get_current_context();
        let data = deserializer.read_value(context)?;
        let deserializers = v8::Local::new(scope, self.deserializers.as_ref()?);
        let obj = data.to_object(scope)?;
        let key = v8::String::new(scope, "type").unwrap();
        let ty = obj.get(scope, key.into())?;
        let f = v8::Local::<v8::Function>::try_from(deserializers.get(scope, ty)?).ok()?;
        // V8 forbids running JS while deserializing, unless asked.
        let scope = std::pin::pin!(v8::AllowJavascriptExecutionScope::new(scope));
        let scope = &mut scope.init();
        let recv = v8::null(scope).into();
        f.call(scope, recv, &[data])?.to_object(scope)
    }
}

/// native.structuredClone(value, hostObjectBrand, deserializers)
pub fn structured_clone(scope: &mut v8::PinScope, args: Args, mut rv: Rv) {
    let value = args.get(0);
    let brand = v8::Local::<v8::Symbol>::try_from(args.get(1)).ok();
    let deserializers = v8::Local::<v8::Object>::try_from(args.get(2)).ok();
    let delegate = || Delegate {
        brand: brand.map(|b| v8::Global::new(scope, b)),
        deserializers: deserializers.map(|d| v8::Global::new(scope, d)),
    };
    let (writer, reader) = (delegate(), delegate());
    let context = scope.get_current_context();
    let data = {
        let serializer = v8::ValueSerializer::new(scope, Box::new(writer));
        serializer.write_header();
        if serializer.write_value(context, value) != Some(true) {
            return; // the delegate threw
        }
        serializer.release()
    };
    let deserializer = v8::ValueDeserializer::new(scope, Box::new(reader), &data);
    if deserializer.read_header(context) != Some(true) {
        throw_type(scope, "structuredClone: could not read the serialized value");
        return;
    }
    if let Some(v) = deserializer.read_value(context) {
        rv.set(v);
    }
}
