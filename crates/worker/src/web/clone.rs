//! `structuredClone` (core.structuredClone): a V8 ValueSerializer and
//! ValueDeserializer round trip, as in browsers' structured clone. Values it
//! can't clone (functions, symbols, host objects, SharedArrayBuffers) throw
//! a TypeError, which 02_structured_clone.js turns into a DataCloneError.

use v8::{ValueDeserializerHelper, ValueSerializerHelper};

use super::{throw_type, Args, Rv};

struct Delegate;

impl v8::ValueSerializerImpl for Delegate {
    fn throw_data_clone_error<'s>(&self, scope: &mut v8::PinScope<'s, '_>, message: v8::Local<'s, v8::String>) {
        let e = v8::Exception::type_error(scope, message);
        scope.throw_exception(e);
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
