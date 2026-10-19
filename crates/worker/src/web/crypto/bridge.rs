//! Moving op arguments and results between V8 and Rust with serde, in place
//! of deno_core's serde_v8: a V8 value becomes a `Val` tree (data only:
//! byte buffers are copied out, nothing else is held), which deserializes
//! into the ops' argument types; results serialize into a `Val`, which
//! becomes a V8 value. The trees are small (algorithm parameters, key
//! data); bulk data crosses as separate buffer arguments.

use serde::de::{self, DeserializeSeed, IntoDeserializer, MapAccess, SeqAccess, Visitor};
use serde::ser::{self, Serialize};

use super::super::{copy_bytes, new_u8array};

/// A JavaScript value, as data.
#[derive(Debug)]
pub enum Val {
    Undefined,
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Bytes(Vec<u8>),
    Seq(Vec<Val>),
    Map(Vec<(String, Val)>),
}

/// How deep an argument can nest (ops' arguments are a few levels deep).
const MAX_DEPTH: usize = 16;

/// A V8 value as a `Val`: own enumerable string-keyed properties of
/// objects, elements of arrays, and copies of ArrayBuffers and views.
pub fn from_v8(scope: &mut v8::PinScope, value: v8::Local<v8::Value>) -> Result<Val, String> {
    from_v8_at(scope, value, 0)
}

fn from_v8_at(scope: &mut v8::PinScope, value: v8::Local<v8::Value>, depth: usize) -> Result<Val, String> {
    if depth > MAX_DEPTH {
        return Err("argument nests too deeply".into());
    }
    if value.is_undefined() {
        return Ok(Val::Undefined);
    }
    if value.is_null() {
        return Ok(Val::Null);
    }
    if value.is_boolean() {
        return Ok(Val::Bool(value.is_true()));
    }
    if value.is_number() {
        return Ok(Val::Num(value.number_value(scope).unwrap_or(f64::NAN)));
    }
    if value.is_string() {
        return Ok(Val::Str(value.to_rust_string_lossy(scope)));
    }
    if value.is_array_buffer() || value.is_array_buffer_view() {
        return copy_bytes(scope, value).map(Val::Bytes).ok_or_else(|| "expected a buffer".into());
    }
    if let Ok(array) = v8::Local::<v8::Array>::try_from(value) {
        let mut out = Vec::with_capacity(array.length() as usize);
        for i in 0..array.length() {
            let item = array.get_index(scope, i).ok_or("can't read an array element")?;
            out.push(from_v8_at(scope, item, depth + 1)?);
        }
        return Ok(Val::Seq(out));
    }
    if let Ok(object) = v8::Local::<v8::Object>::try_from(value) {
        let names = object
            .get_own_property_names(scope, v8::GetPropertyNamesArgs::default())
            .ok_or("can't read an object's properties")?;
        let mut out = Vec::with_capacity(names.length() as usize);
        for i in 0..names.length() {
            let key = names.get_index(scope, i).ok_or("can't read a property name")?;
            let item = object.get(scope, key).ok_or("can't read a property")?;
            out.push((key.to_rust_string_lossy(scope), from_v8_at(scope, item, depth + 1)?));
        }
        return Ok(Val::Map(out));
    }
    Err("unsupported argument type".into())
}

/// A `Val` as a V8 value (bytes become a Uint8Array).
pub fn to_v8<'s>(scope: &mut v8::PinScope<'s, '_>, val: &Val) -> v8::Local<'s, v8::Value> {
    match val {
        Val::Undefined => v8::undefined(scope).into(),
        Val::Null => v8::null(scope).into(),
        Val::Bool(b) => v8::Boolean::new(scope, *b).into(),
        Val::Num(n) => v8::Number::new(scope, *n).into(),
        Val::Str(s) => v8::String::new(scope, s).map(Into::into).unwrap_or_else(|| v8::undefined(scope).into()),
        Val::Bytes(b) => new_u8array(scope, b).into(),
        Val::Seq(items) => {
            let elements: Vec<_> = items.iter().map(|v| to_v8(scope, v)).collect();
            v8::Array::new_with_elements(scope, &elements).into()
        }
        Val::Map(entries) => {
            let object = v8::Object::new(scope);
            for (k, v) in entries {
                let key = v8::String::new(scope, k).unwrap();
                let value = to_v8(scope, v);
                object.set(scope, key.into(), value);
            }
            object.into()
        }
    }
}

// ---- byte buffers in argument and result types ----

/// Bytes from a JavaScript buffer (deno_core's `JsBuffer`).
#[derive(Debug, Default, Clone)]
pub struct JsBuffer(pub Vec<u8>);

impl std::ops::Deref for JsBuffer {
    type Target = [u8];
    fn deref(&self) -> &[u8] {
        &self.0
    }
}

impl AsRef<[u8]> for JsBuffer {
    fn as_ref(&self) -> &[u8] {
        &self.0
    }
}

impl<'de> de::Deserialize<'de> for JsBuffer {
    fn deserialize<D: de::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        serde_bytes::ByteBuf::deserialize(d).map(|b| JsBuffer(b.into_vec()))
    }
}

/// Bytes for JavaScript, as a Uint8Array (deno_core's `ToJsBuffer`).
#[derive(Debug)]
pub struct ToJsBuffer(pub Vec<u8>);

impl From<Vec<u8>> for ToJsBuffer {
    fn from(v: Vec<u8>) -> Self {
        ToJsBuffer(v)
    }
}

impl ser::Serialize for ToJsBuffer {
    fn serialize<S: ser::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_bytes(&self.0)
    }
}


// ---- Val → Rust ----

#[derive(Debug)]
pub struct Error(String);

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

impl de::Error for Error {
    fn custom<T: std::fmt::Display>(msg: T) -> Self {
        Error(msg.to_string())
    }
}

impl ser::Error for Error {
    fn custom<T: std::fmt::Display>(msg: T) -> Self {
        Error(msg.to_string())
    }
}

pub fn deserialize<T: de::DeserializeOwned>(val: Val) -> Result<T, Error> {
    T::deserialize(val)
}

impl<'de> IntoDeserializer<'de, Error> for Val {
    type Deserializer = Val;
    fn into_deserializer(self) -> Val {
        self
    }
}

/// A JavaScript number as the integer it is, if it is one.
fn as_integer(n: f64) -> Option<i128> {
    (n.fract() == 0.0 && n.abs() < 9_007_199_254_740_992.0).then_some(n as i128)
}

impl<'de> de::Deserializer<'de> for Val {
    type Error = Error;

    fn deserialize_any<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        match self {
            Val::Undefined | Val::Null => visitor.visit_unit(),
            Val::Bool(b) => visitor.visit_bool(b),
            Val::Num(n) => match as_integer(n) {
                Some(i) if i >= 0 => visitor.visit_u64(i as u64),
                Some(i) => visitor.visit_i64(i as i64),
                None => visitor.visit_f64(n),
            },
            Val::Str(s) => visitor.visit_string(s),
            Val::Bytes(b) => visitor.visit_byte_buf(b),
            Val::Seq(items) => visitor.visit_seq(Seq(items.into_iter())),
            Val::Map(entries) => visitor.visit_map(Map { entries: entries.into_iter(), value: None }),
        }
    }

    fn deserialize_option<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        match self {
            Val::Undefined | Val::Null => visitor.visit_none(),
            v => visitor.visit_some(v),
        }
    }

    fn deserialize_bytes<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        self.deserialize_byte_buf(visitor)
    }

    fn deserialize_byte_buf<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        match self {
            Val::Bytes(b) => visitor.visit_byte_buf(b),
            Val::Str(s) => visitor.visit_byte_buf(s.into_bytes()),
            other => other.deserialize_any(visitor),
        }
    }

    fn deserialize_enum<V: Visitor<'de>>(
        self,
        _name: &'static str,
        _variants: &'static [&'static str],
        visitor: V,
    ) -> Result<V::Value, Error> {
        match self {
            Val::Str(s) => visitor.visit_enum(s.into_deserializer()),
            Val::Map(mut entries) if entries.len() == 1 => {
                let (variant, value) = entries.pop().unwrap();
                visitor.visit_enum(Enum { variant, value })
            }
            _ => Err(de::Error::custom("expected an enum (a string or an object with one key)")),
        }
    }

    fn deserialize_newtype_struct<V: Visitor<'de>>(self, _name: &'static str, visitor: V) -> Result<V::Value, Error> {
        visitor.visit_newtype_struct(self)
    }

    serde::forward_to_deserialize_any! {
        bool i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 f32 f64 char str string
        unit unit_struct seq tuple tuple_struct map struct identifier ignored_any
    }
}

struct Seq(std::vec::IntoIter<Val>);

impl<'de> SeqAccess<'de> for Seq {
    type Error = Error;
    fn next_element_seed<T: DeserializeSeed<'de>>(&mut self, seed: T) -> Result<Option<T::Value>, Error> {
        self.0.next().map(|v| seed.deserialize(v)).transpose()
    }
}

struct Map {
    entries: std::vec::IntoIter<(String, Val)>,
    value: Option<Val>,
}

impl<'de> MapAccess<'de> for Map {
    type Error = Error;
    fn next_key_seed<K: DeserializeSeed<'de>>(&mut self, seed: K) -> Result<Option<K::Value>, Error> {
        match self.entries.next() {
            Some((k, v)) => {
                self.value = Some(v);
                seed.deserialize(Val::Str(k)).map(Some)
            }
            None => Ok(None),
        }
    }
    fn next_value_seed<V: DeserializeSeed<'de>>(&mut self, seed: V) -> Result<V::Value, Error> {
        seed.deserialize(self.value.take().unwrap_or(Val::Undefined))
    }
}

struct Enum {
    variant: String,
    value: Val,
}

impl<'de> de::EnumAccess<'de> for Enum {
    type Error = Error;
    type Variant = Val;
    fn variant_seed<V: DeserializeSeed<'de>>(self, seed: V) -> Result<(V::Value, Val), Error> {
        Ok((seed.deserialize(Val::Str(self.variant))?, self.value))
    }
}

impl<'de> de::VariantAccess<'de> for Val {
    type Error = Error;
    fn unit_variant(self) -> Result<(), Error> {
        Ok(())
    }
    fn newtype_variant_seed<T: DeserializeSeed<'de>>(self, seed: T) -> Result<T::Value, Error> {
        seed.deserialize(self)
    }
    fn tuple_variant<V: Visitor<'de>>(self, _len: usize, visitor: V) -> Result<V::Value, Error> {
        de::Deserializer::deserialize_any(self, visitor)
    }
    fn struct_variant<V: Visitor<'de>>(self, _fields: &'static [&'static str], visitor: V) -> Result<V::Value, Error> {
        de::Deserializer::deserialize_any(self, visitor)
    }
}

// ---- Rust → Val ----

pub fn serialize<T: Serialize>(value: &T) -> Result<Val, Error> {
    value.serialize(Serializer)
}

struct Serializer;

pub struct SeqOut(Vec<Val>);
pub struct MapOut {
    entries: Vec<(String, Val)>,
    key: Option<String>,
}
pub struct VariantOut {
    variant: &'static str,
    inner: MapOut,
}
pub struct TupleVariantOut {
    variant: &'static str,
    items: Vec<Val>,
}

fn key_of(val: Val) -> Result<String, Error> {
    match val {
        Val::Str(s) => Ok(s),
        Val::Num(n) => Ok(n.to_string()),
        _ => Err(ser::Error::custom("map keys must be strings")),
    }
}

impl ser::Serializer for Serializer {
    type Ok = Val;
    type Error = Error;
    type SerializeSeq = SeqOut;
    type SerializeTuple = SeqOut;
    type SerializeTupleStruct = SeqOut;
    type SerializeTupleVariant = TupleVariantOut;
    type SerializeMap = MapOut;
    type SerializeStruct = MapOut;
    type SerializeStructVariant = VariantOut;

    fn serialize_bool(self, v: bool) -> Result<Val, Error> {
        Ok(Val::Bool(v))
    }
    fn serialize_i8(self, v: i8) -> Result<Val, Error> {
        Ok(Val::Num(v.into()))
    }
    fn serialize_i16(self, v: i16) -> Result<Val, Error> {
        Ok(Val::Num(v.into()))
    }
    fn serialize_i32(self, v: i32) -> Result<Val, Error> {
        Ok(Val::Num(v.into()))
    }
    fn serialize_i64(self, v: i64) -> Result<Val, Error> {
        Ok(Val::Num(v as f64))
    }
    fn serialize_u8(self, v: u8) -> Result<Val, Error> {
        Ok(Val::Num(v.into()))
    }
    fn serialize_u16(self, v: u16) -> Result<Val, Error> {
        Ok(Val::Num(v.into()))
    }
    fn serialize_u32(self, v: u32) -> Result<Val, Error> {
        Ok(Val::Num(v.into()))
    }
    fn serialize_u64(self, v: u64) -> Result<Val, Error> {
        Ok(Val::Num(v as f64))
    }
    fn serialize_f32(self, v: f32) -> Result<Val, Error> {
        Ok(Val::Num(v.into()))
    }
    fn serialize_f64(self, v: f64) -> Result<Val, Error> {
        Ok(Val::Num(v))
    }
    fn serialize_char(self, v: char) -> Result<Val, Error> {
        Ok(Val::Str(v.to_string()))
    }
    fn serialize_str(self, v: &str) -> Result<Val, Error> {
        Ok(Val::Str(v.to_owned()))
    }
    fn serialize_bytes(self, v: &[u8]) -> Result<Val, Error> {
        Ok(Val::Bytes(v.to_vec()))
    }
    fn serialize_none(self) -> Result<Val, Error> {
        Ok(Val::Null)
    }
    fn serialize_some<T: ?Sized + Serialize>(self, value: &T) -> Result<Val, Error> {
        value.serialize(self)
    }
    fn serialize_unit(self) -> Result<Val, Error> {
        Ok(Val::Null)
    }
    fn serialize_unit_struct(self, _name: &'static str) -> Result<Val, Error> {
        Ok(Val::Null)
    }
    fn serialize_unit_variant(self, _name: &'static str, _index: u32, variant: &'static str) -> Result<Val, Error> {
        Ok(Val::Str(variant.to_owned()))
    }
    fn serialize_newtype_struct<T: ?Sized + Serialize>(self, _name: &'static str, value: &T) -> Result<Val, Error> {
        value.serialize(self)
    }
    fn serialize_newtype_variant<T: ?Sized + Serialize>(
        self,
        _name: &'static str,
        _index: u32,
        variant: &'static str,
        value: &T,
    ) -> Result<Val, Error> {
        Ok(Val::Map(vec![(variant.to_owned(), value.serialize(Serializer)?)]))
    }
    fn serialize_seq(self, len: Option<usize>) -> Result<SeqOut, Error> {
        Ok(SeqOut(Vec::with_capacity(len.unwrap_or(0))))
    }
    fn serialize_tuple(self, len: usize) -> Result<SeqOut, Error> {
        self.serialize_seq(Some(len))
    }
    fn serialize_tuple_struct(self, _name: &'static str, len: usize) -> Result<SeqOut, Error> {
        self.serialize_seq(Some(len))
    }
    fn serialize_tuple_variant(
        self,
        _name: &'static str,
        _index: u32,
        variant: &'static str,
        len: usize,
    ) -> Result<TupleVariantOut, Error> {
        Ok(TupleVariantOut { variant, items: Vec::with_capacity(len) })
    }
    fn serialize_map(self, len: Option<usize>) -> Result<MapOut, Error> {
        Ok(MapOut { entries: Vec::with_capacity(len.unwrap_or(0)), key: None })
    }
    fn serialize_struct(self, _name: &'static str, len: usize) -> Result<MapOut, Error> {
        self.serialize_map(Some(len))
    }
    fn serialize_struct_variant(
        self,
        _name: &'static str,
        _index: u32,
        variant: &'static str,
        len: usize,
    ) -> Result<VariantOut, Error> {
        Ok(VariantOut { variant, inner: MapOut { entries: Vec::with_capacity(len), key: None } })
    }
}

impl ser::SerializeSeq for SeqOut {
    type Ok = Val;
    type Error = Error;
    fn serialize_element<T: ?Sized + Serialize>(&mut self, value: &T) -> Result<(), Error> {
        self.0.push(value.serialize(Serializer)?);
        Ok(())
    }
    fn end(self) -> Result<Val, Error> {
        Ok(Val::Seq(self.0))
    }
}

impl ser::SerializeTuple for SeqOut {
    type Ok = Val;
    type Error = Error;
    fn serialize_element<T: ?Sized + Serialize>(&mut self, value: &T) -> Result<(), Error> {
        ser::SerializeSeq::serialize_element(self, value)
    }
    fn end(self) -> Result<Val, Error> {
        ser::SerializeSeq::end(self)
    }
}

impl ser::SerializeTupleStruct for SeqOut {
    type Ok = Val;
    type Error = Error;
    fn serialize_field<T: ?Sized + Serialize>(&mut self, value: &T) -> Result<(), Error> {
        ser::SerializeSeq::serialize_element(self, value)
    }
    fn end(self) -> Result<Val, Error> {
        ser::SerializeSeq::end(self)
    }
}

impl ser::SerializeTupleVariant for TupleVariantOut {
    type Ok = Val;
    type Error = Error;
    fn serialize_field<T: ?Sized + Serialize>(&mut self, value: &T) -> Result<(), Error> {
        self.items.push(value.serialize(Serializer)?);
        Ok(())
    }
    fn end(self) -> Result<Val, Error> {
        Ok(Val::Map(vec![(self.variant.to_owned(), Val::Seq(self.items))]))
    }
}

impl ser::SerializeMap for MapOut {
    type Ok = Val;
    type Error = Error;
    fn serialize_key<T: ?Sized + Serialize>(&mut self, key: &T) -> Result<(), Error> {
        self.key = Some(key_of(key.serialize(Serializer)?)?);
        Ok(())
    }
    fn serialize_value<T: ?Sized + Serialize>(&mut self, value: &T) -> Result<(), Error> {
        let key = self.key.take().ok_or_else(|| <Error as ser::Error>::custom("a map value without a key"))?;
        self.entries.push((key, value.serialize(Serializer)?));
        Ok(())
    }
    fn end(self) -> Result<Val, Error> {
        Ok(Val::Map(self.entries))
    }
}

impl ser::SerializeStruct for MapOut {
    type Ok = Val;
    type Error = Error;
    fn serialize_field<T: ?Sized + Serialize>(&mut self, key: &'static str, value: &T) -> Result<(), Error> {
        self.entries.push((key.to_owned(), value.serialize(Serializer)?));
        Ok(())
    }
    fn end(self) -> Result<Val, Error> {
        Ok(Val::Map(self.entries))
    }
}

impl ser::SerializeStructVariant for VariantOut {
    type Ok = Val;
    type Error = Error;
    fn serialize_field<T: ?Sized + Serialize>(&mut self, key: &'static str, value: &T) -> Result<(), Error> {
        ser::SerializeStruct::serialize_field(&mut self.inner, key, value)
    }
    fn end(self) -> Result<Val, Error> {
        Ok(Val::Map(vec![(self.variant.to_owned(), Val::Map(self.inner.entries))]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serialize};

    #[derive(Deserialize, Debug, PartialEq)]
    #[serde(rename_all = "camelCase", tag = "algorithm")]
    enum Alg {
        #[serde(rename = "AES-GCM", rename_all = "camelCase")]
        AesGcm {
            #[serde(with = "serde_bytes")]
            iv: Vec<u8>,
            #[serde(with = "serde_bytes")]
            additional_data: Option<Vec<u8>>,
            tag_length: usize,
        },
    }

    #[derive(Deserialize, Debug)]
    #[serde(rename_all = "camelCase")]
    struct Opts {
        key: KeyData,
        #[serde(flatten)]
        algorithm: Alg,
    }

    #[derive(Deserialize, Debug)]
    #[serde(rename_all = "lowercase", tag = "type", content = "data")]
    enum KeyData {
        Secret(JsBuffer),
    }

    fn map(entries: Vec<(&str, Val)>) -> Val {
        Val::Map(entries.into_iter().map(|(k, v)| (k.to_owned(), v)).collect())
    }

    #[test]
    fn deserializes_tagged_and_flattened() {
        let val = map(vec![
            ("key", map(vec![("type", Val::Str("secret".into())), ("data", Val::Bytes(vec![1, 2]))])),
            ("algorithm", Val::Str("AES-GCM".into())),
            ("iv", Val::Bytes(vec![3; 12])),
            ("additionalData", Val::Null),
            ("tagLength", Val::Num(128.0)),
        ]);
        let opts: Opts = deserialize(val).unwrap();
        let KeyData::Secret(k) = opts.key;
        assert_eq!(&*k, &[1, 2]);
        assert_eq!(opts.algorithm, Alg::AesGcm { iv: vec![3; 12], additional_data: None, tag_length: 128 });
    }

    #[derive(Serialize)]
    #[serde(rename_all = "lowercase", tag = "type", content = "data")]
    enum Raw {
        Private(ToJsBuffer),
    }

    #[test]
    fn serializes_adjacently_tagged() {
        let v = serialize(&Raw::Private(vec![9].into())).unwrap();
        let Val::Map(entries) = v else { panic!() };
        assert!(matches!(&entries[0], (k, Val::Str(s)) if k == "type" && s == "private"));
        assert!(matches!(&entries[1], (k, Val::Bytes(b)) if k == "data" && b == &[9]));
    }
}
