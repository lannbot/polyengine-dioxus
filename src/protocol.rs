//! Batch encoder for the wire format documented in `wit/world.wit`.
//!
//! A [`Batch`] accumulates one op segment and one string segment. The two
//! segments are decoded together host-side: op operands reference dynamic
//! string bytes by UTF-16 code-unit length, consumed sequentially from the
//! string segment (itself one contiguous UTF-8 blob, decoded in a single
//! `TextDecoder` pass). See `wit/world.wit`'s `surface` interface doc
//! comment for the normative format; this module must match it exactly.

use std::collections::HashMap;

/// `strref` sentinel for "no namespace" (wit/world.wit: "0xffff = none where
/// the operand is optional").
const STRREF_NONE: u16 = 0xffff;

/// `dynstr` UTF-16-length escape: a length field of `0xffff` is followed by
/// a u32 actual length (wit/world.wit `dynstr` primitive encoding).
const DYNSTR_ESCAPE: u16 = 0xffff;

/// Opcodes, `wit/world.wit` "# Opcodes" section. Numbering is normative.
mod op {
    pub const CACHE_STRING: u8 = 0x01;
    pub const REGISTER_TEMPLATE: u8 = 0x02;
    pub const APPEND_CHILDREN: u8 = 0x03;
    pub const ASSIGN_ID: u8 = 0x04;
    pub const CREATE_PLACEHOLDER: u8 = 0x05;
    pub const CREATE_TEXT_NODE: u8 = 0x06;
    pub const LOAD_TEMPLATE: u8 = 0x07;
    pub const REPLACE_WITH: u8 = 0x08;
    pub const REPLACE_PLACEHOLDER: u8 = 0x09;
    pub const INSERT_AFTER: u8 = 0x0a;
    pub const INSERT_BEFORE: u8 = 0x0b;
    pub const SET_ATTRIBUTE: u8 = 0x0c;
    pub const SET_TEXT: u8 = 0x0d;
    pub const NEW_EVENT_LISTENER: u8 = 0x0e;
    pub const REMOVE_EVENT_LISTENER: u8 = 0x0f;
    pub const REMOVE: u8 = 0x10;
    pub const PUSH_ROOT: u8 = 0x11;
}

/// `register-template` node kinds, `wit/world.wit` `node := kind:u8 ...`.
mod node_kind {
    pub const ELEMENT: u8 = 0x00;
    pub const TEXT: u8 = 0x01;
    pub const DYNAMIC: u8 = 0x02;
}

/// `set-attribute`'s `attrval := kind:u8 ...` tags.
mod attrval_kind {
    pub const TEXT: u8 = 0x00;
    pub const FLOAT: u8 = 0x01;
    pub const INT: u8 = 0x02;
    pub const BOOL: u8 = 0x03;
    pub const NONE: u8 = 0x04;
}

/// Compute the `dynstr` UTF-16 code-unit length of `s`.
///
/// Fast path: an all-ASCII string's UTF-16 length equals its UTF-8 byte
/// length. Otherwise sum `char::len_utf16` (wit/world.wit dynstr doc:
/// "Rust: sum of char::len_utf16, with an all-ASCII fast path where it
/// equals the byte length").
fn utf16_len(s: &str) -> u32 {
    if s.is_ascii() {
        s.len() as u32
    } else {
        s.chars().map(char::len_utf16).sum::<usize>() as u32
    }
}

/// Convert an `Option<u16>` strref into its wire encoding (`0xffff` = none).
fn strref(ns: Option<u16>) -> u16 {
    ns.unwrap_or(STRREF_NONE)
}

/// One batch of protocol ops: an op segment and the string segment its
/// `dynstr` operands reference. See the module doc and `wit/world.wit` for
/// the wire format.
///
/// A fresh `Batch` is emptied by `take_frame`/`take_segments`, so a single
/// instance can be reused across renders without reallocating buffers each
/// time (only `Vec::clear`, which retains capacity).
pub struct Batch {
    ops: Vec<u8>,
    strings: String,
}

impl Batch {
    /// Create an empty batch.
    pub fn new() -> Self {
        Batch { ops: Vec::new(), strings: String::new() }
    }

    /// True if no ops have been recorded (and hence no strings either).
    pub fn is_empty(&self) -> bool {
        self.ops.is_empty()
    }

    /// Append a `dynstr` operand: UTF-16 length (with the `0xffff` escape
    /// for lengths that collide with the sentinel or exceed u16), followed
    /// by the string's UTF-8 bytes appended to the string segment.
    fn push_dynstr(&mut self, s: &str) {
        let len16 = utf16_len(s);
        if len16 >= DYNSTR_ESCAPE as u32 {
            self.ops.extend_from_slice(&DYNSTR_ESCAPE.to_le_bytes());
            self.ops.extend_from_slice(&len16.to_le_bytes());
        } else {
            self.ops.extend_from_slice(&(len16 as u16).to_le_bytes());
        }
        self.strings.push_str(s);
    }

    fn push_strref(&mut self, id: Option<u16>) {
        self.ops.extend_from_slice(&strref(id).to_le_bytes());
    }

    fn push_path(&mut self, path: &[u8]) {
        assert!(
            path.len() <= 255,
            "protocol: path length {} exceeds u8 max (255)",
            path.len()
        );
        self.ops.push(path.len() as u8);
        self.ops.extend_from_slice(path);
    }

    /// `0x01 cache-string id:u16 s:dynstr` — define (or overwrite) interned
    /// slot `id`. Normally driven by [`Interner`], not called directly.
    pub fn cache_string(&mut self, id: u16, s: &str) {
        self.ops.push(op::CACHE_STRING);
        self.ops.extend_from_slice(&id.to_le_bytes());
        self.push_dynstr(s);
    }

    /// `0x02 register-template` header: `tmpl:u16 nroots:u16`. The caller
    /// must follow with exactly `nroots` calls to the node-emitting methods
    /// (`template_element_open` + attrs + children, `template_text`, or
    /// `template_dynamic`), matching the recursive `node` grammar in
    /// `wit/world.wit`.
    pub fn register_template(&mut self, tmpl: u16, nroots: u16) {
        self.ops.push(op::REGISTER_TEMPLATE);
        self.ops.extend_from_slice(&tmpl.to_le_bytes());
        self.ops.extend_from_slice(&nroots.to_le_bytes());
    }

    /// Emit an element `node` header: `kind=0x00 tag:strref ns:strref
    /// nattrs:u16`. The caller must follow with exactly `nattrs` calls to
    /// `template_attr`, then one call to `template_element_children`, then
    /// that many child nodes.
    pub fn template_element_open(&mut self, tag: u16, ns: Option<u16>, nattrs: u16) {
        self.ops.push(node_kind::ELEMENT);
        self.ops.extend_from_slice(&tag.to_le_bytes());
        self.push_strref(ns);
        self.ops.extend_from_slice(&nattrs.to_le_bytes());
    }

    /// Emit one static `attr := name:strref ns:strref value:dynstr` inside
    /// an open element (must follow `template_element_open`, before
    /// `template_element_children`).
    pub fn template_attr(&mut self, name: u16, ns: Option<u16>, value: &str) {
        self.ops.extend_from_slice(&name.to_le_bytes());
        self.push_strref(ns);
        self.push_dynstr(value);
    }

    /// Declare the child count for the currently-open element:
    /// `nchildren:u16`. Must follow all of that element's `template_attr`
    /// calls; the caller then emits exactly `nchildren` nodes.
    pub fn template_element_children(&mut self, nchildren: u16) {
        self.ops.extend_from_slice(&nchildren.to_le_bytes());
    }

    /// Emit a text `node`: `kind=0x01 value:dynstr`.
    pub fn template_text(&mut self, value: &str) {
        self.ops.push(node_kind::TEXT);
        self.push_dynstr(value);
    }

    /// Emit a dynamic-placeholder `node`: `kind=0x02` (no operands).
    pub fn template_dynamic(&mut self) {
        self.ops.push(node_kind::DYNAMIC);
    }

    /// `0x03 append-children id m`.
    pub fn append_children(&mut self, id: u32, m: u32) {
        self.ops.push(op::APPEND_CHILDREN);
        self.ops.extend_from_slice(&id.to_le_bytes());
        self.ops.extend_from_slice(&m.to_le_bytes());
    }

    /// `0x04 assign-id path id`. Panics if `path.len() > 255` (path's `u8`
    /// length prefix cannot represent more).
    pub fn assign_id(&mut self, path: &[u8], id: u32) {
        self.ops.push(op::ASSIGN_ID);
        self.push_path(path);
        self.ops.extend_from_slice(&id.to_le_bytes());
    }

    /// `0x05 create-placeholder id`.
    pub fn create_placeholder(&mut self, id: u32) {
        self.ops.push(op::CREATE_PLACEHOLDER);
        self.ops.extend_from_slice(&id.to_le_bytes());
    }

    /// `0x06 create-text-node id text:dynstr`.
    pub fn create_text_node(&mut self, id: u32, text: &str) {
        self.ops.push(op::CREATE_TEXT_NODE);
        self.ops.extend_from_slice(&id.to_le_bytes());
        self.push_dynstr(text);
    }

    /// `0x07 load-template tmpl root-index:u16 id`.
    pub fn load_template(&mut self, tmpl: u16, root: u16, id: u32) {
        self.ops.push(op::LOAD_TEMPLATE);
        self.ops.extend_from_slice(&tmpl.to_le_bytes());
        self.ops.extend_from_slice(&root.to_le_bytes());
        self.ops.extend_from_slice(&id.to_le_bytes());
    }

    /// `0x08 replace-with id m`.
    pub fn replace_with(&mut self, id: u32, m: u32) {
        self.ops.push(op::REPLACE_WITH);
        self.ops.extend_from_slice(&id.to_le_bytes());
        self.ops.extend_from_slice(&m.to_le_bytes());
    }

    /// `0x09 replace-placeholder path m`. Panics if `path.len() > 255`.
    pub fn replace_placeholder(&mut self, path: &[u8], m: u32) {
        self.ops.push(op::REPLACE_PLACEHOLDER);
        self.push_path(path);
        self.ops.extend_from_slice(&m.to_le_bytes());
    }

    /// `0x0a insert-after id m`.
    pub fn insert_after(&mut self, id: u32, m: u32) {
        self.ops.push(op::INSERT_AFTER);
        self.ops.extend_from_slice(&id.to_le_bytes());
        self.ops.extend_from_slice(&m.to_le_bytes());
    }

    /// `0x0b insert-before id m`.
    pub fn insert_before(&mut self, id: u32, m: u32) {
        self.ops.push(op::INSERT_BEFORE);
        self.ops.extend_from_slice(&id.to_le_bytes());
        self.ops.extend_from_slice(&m.to_le_bytes());
    }

    fn set_attribute_header(&mut self, id: u32, name: u16, ns: Option<u16>) {
        self.ops.push(op::SET_ATTRIBUTE);
        self.ops.extend_from_slice(&id.to_le_bytes());
        self.ops.extend_from_slice(&name.to_le_bytes());
        self.push_strref(ns);
    }

    /// `0x0c set-attribute` with `attrval` kind `0x00 text s:dynstr`.
    pub fn set_attribute_text(&mut self, id: u32, name: u16, ns: Option<u16>, value: &str) {
        self.set_attribute_header(id, name, ns);
        self.ops.push(attrval_kind::TEXT);
        self.push_dynstr(value);
    }

    /// `0x0c set-attribute` with `attrval` kind `0x01 float f64`.
    pub fn set_attribute_float(&mut self, id: u32, name: u16, ns: Option<u16>, value: f64) {
        self.set_attribute_header(id, name, ns);
        self.ops.push(attrval_kind::FLOAT);
        self.ops.extend_from_slice(&value.to_le_bytes());
    }

    /// `0x0c set-attribute` with `attrval` kind `0x02 int s64`.
    pub fn set_attribute_int(&mut self, id: u32, name: u16, ns: Option<u16>, value: i64) {
        self.set_attribute_header(id, name, ns);
        self.ops.push(attrval_kind::INT);
        self.ops.extend_from_slice(&value.to_le_bytes());
    }

    /// `0x0c set-attribute` with `attrval` kind `0x03 bool u8`.
    pub fn set_attribute_bool(&mut self, id: u32, name: u16, ns: Option<u16>, value: bool) {
        self.set_attribute_header(id, name, ns);
        self.ops.push(attrval_kind::BOOL);
        self.ops.push(value as u8);
    }

    /// `0x0c set-attribute` with `attrval` kind `0x04 none` (remove the
    /// attribute; no value operand).
    pub fn set_attribute_none(&mut self, id: u32, name: u16, ns: Option<u16>) {
        self.set_attribute_header(id, name, ns);
        self.ops.push(attrval_kind::NONE);
    }

    /// `0x0d set-text id text:dynstr`.
    pub fn set_text(&mut self, id: u32, text: &str) {
        self.ops.push(op::SET_TEXT);
        self.ops.extend_from_slice(&id.to_le_bytes());
        self.push_dynstr(text);
    }

    /// `0x0e new-event-listener id name:strref` (name is never `none` here;
    /// the `strref` optionality in the shared encoding is unused by this
    /// op, per wit/world.wit's opcode table which lists `name` without an
    /// optional annotation).
    pub fn new_event_listener(&mut self, id: u32, name: u16) {
        self.ops.push(op::NEW_EVENT_LISTENER);
        self.ops.extend_from_slice(&id.to_le_bytes());
        self.ops.extend_from_slice(&name.to_le_bytes());
    }

    /// `0x0f remove-event-listener id name:strref`.
    pub fn remove_event_listener(&mut self, id: u32, name: u16) {
        self.ops.push(op::REMOVE_EVENT_LISTENER);
        self.ops.extend_from_slice(&id.to_le_bytes());
        self.ops.extend_from_slice(&name.to_le_bytes());
    }

    /// `0x10 remove id`.
    pub fn remove(&mut self, id: u32) {
        self.ops.push(op::REMOVE);
        self.ops.extend_from_slice(&id.to_le_bytes());
    }

    /// `0x11 push-root id`.
    pub fn push_root(&mut self, id: u32) {
        self.ops.push(op::PUSH_ROOT);
        self.ops.extend_from_slice(&id.to_le_bytes());
    }

    /// Stream transport: append one frame to `out` and clear `self`.
    ///
    /// Frame layout (`wit/world.wit` "# Framing"):
    /// `frame-len:u32 strings-len:u32 strings:u8{strings-len} ops:u8{rest}`,
    /// where `frame-len` counts everything *after* the frame-len field
    /// itself (`4 + strings-len + len(ops)`).
    pub fn take_frame(&mut self, out: &mut Vec<u8>) {
        let strings_len = self.strings.len() as u32;
        let frame_len = 4u32 + strings_len + self.ops.len() as u32;
        out.extend_from_slice(&frame_len.to_le_bytes());
        out.extend_from_slice(&strings_len.to_le_bytes());
        out.extend_from_slice(self.strings.as_bytes());
        out.extend_from_slice(&self.ops);
        self.ops.clear();
        self.strings.clear();
    }

    /// Call transport: hand out `(ops, strings)` segments, clearing `self`.
    /// No framing header — the `flush` import call's two arguments *are*
    /// exactly one batch's segments (wit/world.wit: "Framing is NOT used").
    pub fn take_segments(&mut self) -> (Vec<u8>, String) {
        let ops = std::mem::take(&mut self.ops);
        let strings = std::mem::take(&mut self.strings);
        (ops, strings)
    }
}

impl Default for Batch {
    fn default() -> Self {
        Self::new()
    }
}

/// Interns `&'static str` names (tags, attribute/event names, namespaces) by
/// pointer identity, emitting a `cache-string` op into the batch the first
/// time a given pointer+length is seen.
///
/// Pointer-identity interning (rather than content hashing) is the fast
/// path documented for `register-template` guest identity ("templates are
/// 'static with unique identity, keyed guest-side by pointer" —
/// wit/world.wit `register-template` doc) and is reused here for all
/// `&'static str` names: two distinct statics with equal contents may get
/// two ids. That's harmless (a few extra cache-string ops / interned slots
/// at worst), and avoids hashing string contents on every intern call.
pub struct Interner {
    /// Keyed by `(ptr as usize, len)` — the fat-pointer components of the
    /// `&'static str`, which uniquely identify a given static allocation.
    ids: HashMap<(usize, usize), u16>,
    /// Reverse map for event dispatch (`resolve`): id -> the original
    /// `&'static str`.
    names: Vec<&'static str>,
}

impl Interner {
    /// Create an empty interner.
    pub fn new() -> Self {
        Interner { ids: HashMap::new(), names: Vec::new() }
    }

    /// Return the interned id for `s`, emitting `cache-string` into `batch`
    /// on first sight of this pointer identity.
    ///
    /// Panics if more than `u16::MAX - 1` distinct strings are interned
    /// (id `0xffff` is reserved as the `strref` "none" sentinel, so it must
    /// never be assigned).
    pub fn intern(&mut self, batch: &mut Batch, s: &'static str) -> u16 {
        let key = (s.as_ptr() as usize, s.len());
        if let Some(&id) = self.ids.get(&key) {
            return id;
        }
        let next = self.names.len();
        assert!(
            next < STRREF_NONE as usize,
            "protocol: interned more than {} strings; id space exhausted \
             (0xffff is reserved as the strref \"none\" sentinel)",
            STRREF_NONE
        );
        let id = next as u16;
        self.ids.insert(key, id);
        self.names.push(s);
        batch.cache_string(id, s);
        id
    }

    /// Reverse lookup for event dispatch: interned id -> the original
    /// `&'static str`, or `None` if `id` was never interned.
    pub fn resolve(&self, id: u16) -> Option<&'static str> {
        self.names.get(id as usize).copied()
    }
}

impl Default for Interner {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// UTF-16 code-unit counting per the `dynstr` doc: ASCII fast path,
    /// multi-byte BMP chars (1 code unit each), and surrogate pairs (2 code
    /// units for one `char` outside the BMP).
    #[test]
    fn utf16_len_cases() {
        assert_eq!(utf16_len(""), 0);
        assert_eq!(utf16_len("hello"), 5);
        // "wörld": 'ö' is one BMP char, one UTF-16 code unit, but 2 UTF-8
        // bytes -- exercises the non-ASCII path diverging from byte length.
        assert_eq!(utf16_len("wörld"), 5);
        // CJK: each char is one BMP code unit (3 UTF-8 bytes each).
        assert_eq!(utf16_len("你好世界"), 4);
        // Emoji outside the BMP: each is a surrogate pair (2 UTF-16 units,
        // 4 UTF-8 bytes). "👍🏽" is thumbs-up + skin-tone modifier, both
        // outside the BMP: 2 chars * 2 units = 4.
        assert_eq!(utf16_len("👍🏽"), 4);
        assert_eq!(utf16_len("👍🏽 emoji"), 4 + 6);
    }

    #[test]
    fn dynstr_escape_roundtrip_length() {
        // A string whose UTF-16 length exceeds u16::MAX-ish must use the
        // 0xffff escape followed by a u32 actual length.
        let long = "ab£".repeat(30000); // 'a','b' (1 unit each) + '£' (1 unit) = 3 units/rep
        let expected_len16 = utf16_len(&long);
        assert!(expected_len16 as u32 >= DYNSTR_ESCAPE as u32);

        let mut b = Batch::new();
        b.create_text_node(0, &long);
        let (ops, strings) = b.take_segments();
        // op byte, id:u32, then dynstr: 0xffff u16 + u32 actual len
        assert_eq!(ops[0], op::CREATE_TEXT_NODE);
        let len16_field = u16::from_le_bytes([ops[5], ops[6]]);
        assert_eq!(len16_field, DYNSTR_ESCAPE);
        let actual_len = u32::from_le_bytes([ops[7], ops[8], ops[9], ops[10]]);
        assert_eq!(actual_len, expected_len16);
        assert_eq!(strings, long);
    }

    #[test]
    fn cache_string_hits_reuse_id() {
        let mut batch = Batch::new();
        let mut interner = Interner::new();
        static DIV: &str = "div";
        let a = interner.intern(&mut batch, DIV);
        let b = interner.intern(&mut batch, DIV);
        assert_eq!(a, b);
        assert_eq!(interner.resolve(a), Some("div"));
        // Only one cache-string op should have been emitted.
        let (ops, _) = batch.take_segments();
        assert_eq!(ops[0], op::CACHE_STRING);
        assert_eq!(ops.iter().filter(|&&b| b == op::CACHE_STRING).count(), 1);
    }

    #[test]
    #[should_panic(expected = "path length")]
    fn assign_id_rejects_long_path() {
        let mut b = Batch::new();
        b.assign_id(&[0u8; 256], 0);
    }

    #[test]
    fn frame_header_matches_layout() {
        let mut b = Batch::new();
        b.push_root(42);
        let mut out = Vec::new();
        b.take_frame(&mut out);
        assert!(b.is_empty());
        let frame_len = u32::from_le_bytes(out[0..4].try_into().unwrap());
        let strings_len = u32::from_le_bytes(out[4..8].try_into().unwrap());
        assert_eq!(strings_len, 0);
        assert_eq!(frame_len as usize, out.len() - 4);
    }
}
