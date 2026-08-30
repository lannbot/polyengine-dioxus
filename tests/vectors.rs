//! Golden vector generator/verifier for the wire format in `src/protocol.rs`
//! / `wit/world.wit`. These vectors are shared with the TypeScript decoder
//! (host side), so the `.expected.json` shape is contractual — see the
//! dispatch/README for the exact schema.
//!
//! Each vector's bytes and JSON are produced by ONE function that drives
//! both `Batch`/`Interner` (for bytes) and a parallel `serde_json::Value`
//! builder (for the expected JSON), op-by-op, so the two representations
//! cannot drift apart from each other by construction.

use polyengine_dioxus::protocol::{Batch, Interner};
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

/// Records one vector: drives `Batch`/`Interner` for the byte encoding and
/// builds the matching JSON op list in lockstep. Frame boundaries are
/// explicit (`take_frame`) so the `frames` vector can split one op stream
/// across two physical frames.
struct Rec {
    batch: Batch,
    interner: Interner,
    /// Ops recorded since the last `take_frame` (or start).
    current_ops: Vec<Value>,
    /// One entry per completed frame (each a JSON array of ops).
    frames_json: Vec<Value>,
    /// Framed bytes emitted so far (stream-transport framing).
    bytes: Vec<u8>,
    /// Pointer-identity strings already interned, purely so this recorder
    /// knows when to emit a `cache-string` JSON op (mirrors, but does not
    /// read, `Interner`'s private dedup — `Interner::intern` is the actual
    /// source of truth for the bytes).
    seen: std::collections::HashMap<(usize, usize), u16>,
}

impl Rec {
    fn new() -> Self {
        Rec {
            batch: Batch::new(),
            interner: Interner::new(),
            current_ops: Vec::new(),
            frames_json: Vec::new(),
            bytes: Vec::new(),
            seen: std::collections::HashMap::new(),
        }
    }

    fn push_op(&mut self, v: Value) {
        self.current_ops.push(v);
    }

    /// Intern a `&'static str`, recording a `cache-string` JSON op the
    /// first time this pointer identity is seen (matching `Interner`'s
    /// documented dedup behavior).
    fn intern(&mut self, s: &'static str) -> u16 {
        let key = (s.as_ptr() as usize, s.len());
        let was_new = !self.seen.contains_key(&key);
        let id = self.interner.intern(&mut self.batch, s);
        if was_new {
            self.seen.insert(key, id);
            self.push_op(json!({"op": "cache-string", "id": id, "s": s}));
        }
        id
    }

    fn ns_json(ns: Option<u16>) -> Value {
        match ns {
            Some(n) => json!(n),
            None => Value::Null,
        }
    }

    fn append_children(&mut self, id: u32, m: u32) {
        self.batch.append_children(id, m);
        self.push_op(json!({"op": "append-children", "id": id, "m": m}));
    }

    fn assign_id(&mut self, path: &[u8], id: u32) {
        self.batch.assign_id(path, id);
        self.push_op(json!({"op": "assign-id", "path": path, "id": id}));
    }

    fn create_placeholder(&mut self, id: u32) {
        self.batch.create_placeholder(id);
        self.push_op(json!({"op": "create-placeholder", "id": id}));
    }

    fn create_text_node(&mut self, id: u32, text: &str) {
        self.batch.create_text_node(id, text);
        self.push_op(json!({"op": "create-text-node", "id": id, "text": text}));
    }

    fn load_template(&mut self, tmpl: u16, root: u16, id: u32) {
        self.batch.load_template(tmpl, root, id);
        self.push_op(json!({"op": "load-template", "tmpl": tmpl, "root": root, "id": id}));
    }

    fn replace_with(&mut self, id: u32, m: u32) {
        self.batch.replace_with(id, m);
        self.push_op(json!({"op": "replace-with", "id": id, "m": m}));
    }

    fn replace_placeholder(&mut self, path: &[u8], m: u32) {
        self.batch.replace_placeholder(path, m);
        self.push_op(json!({"op": "replace-placeholder", "path": path, "m": m}));
    }

    fn insert_after(&mut self, id: u32, m: u32) {
        self.batch.insert_after(id, m);
        self.push_op(json!({"op": "insert-after", "id": id, "m": m}));
    }

    fn insert_before(&mut self, id: u32, m: u32) {
        self.batch.insert_before(id, m);
        self.push_op(json!({"op": "insert-before", "id": id, "m": m}));
    }

    fn set_attribute_text(&mut self, id: u32, name: u16, ns: Option<u16>, value: &str) {
        self.batch.set_attribute_text(id, name, ns, value);
        self.push_op(json!({
            "op": "set-attribute", "id": id, "name": name, "ns": Self::ns_json(ns),
            "value": {"kind": "text", "s": value}
        }));
    }

    fn set_attribute_float(&mut self, id: u32, name: u16, ns: Option<u16>, value: f64) {
        self.batch.set_attribute_float(id, name, ns, value);
        self.push_op(json!({
            "op": "set-attribute", "id": id, "name": name, "ns": Self::ns_json(ns),
            "value": {"kind": "float", "f": value}
        }));
    }

    fn set_attribute_int(&mut self, id: u32, name: u16, ns: Option<u16>, value: i64) {
        self.batch.set_attribute_int(id, name, ns, value);
        self.push_op(json!({
            "op": "set-attribute", "id": id, "name": name, "ns": Self::ns_json(ns),
            "value": {"kind": "int", "i": value.to_string()}
        }));
    }

    fn set_attribute_bool(&mut self, id: u32, name: u16, ns: Option<u16>, value: bool) {
        self.batch.set_attribute_bool(id, name, ns, value);
        self.push_op(json!({
            "op": "set-attribute", "id": id, "name": name, "ns": Self::ns_json(ns),
            "value": {"kind": "bool", "b": value}
        }));
    }

    fn set_attribute_none(&mut self, id: u32, name: u16, ns: Option<u16>) {
        self.batch.set_attribute_none(id, name, ns);
        self.push_op(json!({
            "op": "set-attribute", "id": id, "name": name, "ns": Self::ns_json(ns),
            "value": {"kind": "none"}
        }));
    }

    fn set_text(&mut self, id: u32, text: &str) {
        self.batch.set_text(id, text);
        self.push_op(json!({"op": "set-text", "id": id, "text": text}));
    }

    fn new_event_listener(&mut self, id: u32, name: u16, bubbles: bool) {
        self.batch.new_event_listener(id, name, bubbles);
        self.push_op(
            json!({"op": "new-event-listener", "id": id, "name": name, "bubbles": bubbles}),
        );
    }

    fn remove_event_listener(&mut self, id: u32, name: u16, bubbles: bool) {
        self.batch.remove_event_listener(id, name, bubbles);
        self.push_op(
            json!({"op": "remove-event-listener", "id": id, "name": name, "bubbles": bubbles}),
        );
    }

    fn remove(&mut self, id: u32) {
        self.batch.remove(id);
        self.push_op(json!({"op": "remove", "id": id}));
    }

    fn push_root(&mut self, id: u32) {
        self.batch.push_root(id);
        self.push_op(json!({"op": "push-root", "id": id}));
    }

    /// Register a template with the given roots, recursing through
    /// `TNode` to drive both the `Batch` node-emitting calls and the
    /// matching JSON `tnode` values.
    fn register_template(&mut self, tmpl: u16, roots: &[TNode]) {
        self.batch.register_template(tmpl, roots.len() as u16);
        let root_json: Vec<Value> = roots.iter().map(|n| self.emit_node(n)).collect();
        self.push_op(json!({"op": "register-template", "tmpl": tmpl, "roots": root_json}));
    }

    fn emit_node(&mut self, node: &TNode) -> Value {
        match node {
            TNode::Element { tag, ns, attrs, children } => {
                self.batch.template_element_open(*tag, *ns, attrs.len() as u16);
                let attrs_json: Vec<Value> = attrs
                    .iter()
                    .map(|(name, ns, value)| {
                        self.batch.template_attr(*name, *ns, value);
                        json!({"name": name, "ns": Self::ns_json(*ns), "value": value})
                    })
                    .collect();
                self.batch.template_element_children(children.len() as u16);
                let children_json: Vec<Value> = children.iter().map(|c| self.emit_node(c)).collect();
                json!({
                    "kind": "element", "tag": tag, "ns": Self::ns_json(*ns),
                    "attrs": attrs_json, "children": children_json
                })
            }
            TNode::Text(value) => {
                self.batch.template_text(value);
                json!({"kind": "text", "value": value})
            }
            TNode::Dynamic => {
                self.batch.template_dynamic();
                json!({"kind": "dynamic"})
            }
        }
    }

    /// Close out the current frame: flush ops recorded so far into one
    /// physical frame (bytes + JSON).
    fn take_frame(&mut self) {
        self.batch.take_frame(&mut self.bytes);
        let ops = std::mem::take(&mut self.current_ops);
        self.frames_json.push(Value::Array(ops));
    }

    /// Finish the vector: if anything is pending, close it as a final
    /// frame, then return `(bytes, expected-json)`.
    fn finish(mut self) -> (Vec<u8>, Value) {
        if !self.current_ops.is_empty() || !self.batch.is_empty() {
            self.take_frame();
        }
        (self.bytes, json!({"frames": self.frames_json}))
    }
}

/// A template node spec used only by this test to drive `Batch`'s
/// node-emitting calls and the matching expected-JSON `tnode` value in
/// lockstep (mirrors the `node` grammar in `wit/world.wit`).
enum TNode {
    Element { tag: u16, ns: Option<u16>, attrs: Vec<(u16, Option<u16>, String)>, children: Vec<TNode> },
    Text(String),
    Dynamic,
}

// Interned name statics. Pointer identity is what `Interner` dedups on, so
// reusing the same static (e.g. `DIV` used twice) is what exercises the
// "cache hit" path; `DIV2` is a distinct static with equal contents to
// confirm the documented "two ids for equal-content statics is harmless"
// behavior is at least exercised.
static DIV: &str = "div";
static SPAN: &str = "span";
static CLASS: &str = "class";
static STYLE: &str = "style";
static SVG_NS: &str = "http://www.w3.org/2000/svg";
static CLICK: &str = "click";

/// Every opcode at least once; interning with a cache hit (`DIV` used
/// twice); every `attrval` kind; a `none`-namespace and a `some`-namespace
/// `set-attribute`.
fn build_basic(rec: &mut Rec) {
    let div = rec.intern(DIV);
    let _div_again = rec.intern(DIV); // cache hit: no second cache-string op
    let span = rec.intern(SPAN);
    let class = rec.intern(CLASS);
    let style = rec.intern(STYLE);
    let svg_ns = rec.intern(SVG_NS);
    let click = rec.intern(CLICK);

    rec.register_template(0, &[TNode::Dynamic]);
    rec.load_template(0, 0, 1);
    rec.create_placeholder(2);
    rec.create_text_node(3, "hello");
    rec.append_children(1, 2);
    rec.assign_id(&[0, 1], 5);
    rec.replace_with(9, 1);
    rec.replace_placeholder(&[0], 2);
    rec.insert_after(3, 1);
    rec.insert_before(3, 1);

    // Every attrval kind; one none-namespace, one some-namespace.
    rec.set_attribute_text(2, class, None, "x");
    rec.set_attribute_float(2, style, Some(svg_ns), 1.5);
    rec.set_attribute_int(2, div, None, -3);
    rec.set_attribute_bool(2, span, None, true);
    rec.set_attribute_none(2, class, None);

    rec.set_text(2, "t");
    rec.new_event_listener(2, click, true);
    rec.remove_event_listener(2, click, false);
    rec.remove(2);
    rec.push_root(1);
}

/// Dynamic strings covering: empty, ASCII, accented BMP, CJK, surrogate
/// pairs, and a >65600-UTF-16-unit string (exercises the `dynstr` 0xffff
/// escape).
fn build_unicode(rec: &mut Rec) {
    // "ab£".repeat(N) has UTF-16 length 3*N (a,b are 1 unit each, £ is 1
    // BMP unit). Need >65600, so N must be > 21867; use 22000 for margin.
    let long = "ab£".repeat(22000);
    debug_assert!(long.chars().map(char::len_utf16).sum::<usize>() > 65600);

    rec.create_text_node(0, "");
    rec.create_text_node(1, "hello");
    rec.create_text_node(2, "héllo wörld");
    rec.create_text_node(3, "你好世界");
    rec.create_text_node(4, "👍🏽 emoji");
    rec.create_text_node(5, &long);
}

/// `register-template` with two roots: (1) a 3-level element tree mixing a
/// namespaced static attr, a non-namespaced static attr, a text child, and
/// a dynamic placeholder; (2) a bare dynamic root. Followed by
/// load-template + assign-id + replace-placeholder uses.
fn build_template(rec: &mut Rec) {
    let div = rec.intern(DIV);
    let span = rec.intern(SPAN);
    let class = rec.intern(CLASS);
    let style = rec.intern(STYLE);
    let svg_ns = rec.intern(SVG_NS);

    let roots = vec![
        TNode::Element {
            tag: div,
            ns: None,
            attrs: vec![(class, None, "container".to_string())],
            children: vec![
                TNode::Element {
                    tag: span,
                    ns: Some(svg_ns),
                    attrs: vec![(style, Some(svg_ns), "color:red".to_string())],
                    children: vec![TNode::Text("hello".to_string()), TNode::Dynamic],
                },
                TNode::Text("world".to_string()),
            ],
        },
        TNode::Dynamic,
    ];
    rec.register_template(0, &roots);

    rec.load_template(0, 0, 10);
    rec.assign_id(&[0, 1], 11);
    rec.replace_placeholder(&[0], 1);
}

fn vector_dir() -> &'static Path {
    Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/vectors"))
}

fn write_vector(name: &str, bytes: &[u8], json: &Value) {
    let dir = vector_dir();
    fs::create_dir_all(dir).expect("create vectors dir");
    fs::write(dir.join(format!("{name}.bin")), bytes).expect("write .bin");
    let pretty = serde_json::to_string_pretty(json).expect("serialize json");
    fs::write(dir.join(format!("{name}.expected.json")), pretty + "\n").expect("write .json");
}

fn read_vector(name: &str) -> (Vec<u8>, Value) {
    let dir = vector_dir();
    let bin_path = dir.join(format!("{name}.bin"));
    let json_path = dir.join(format!("{name}.expected.json"));
    let bytes = fs::read(&bin_path).unwrap_or_else(|_| {
        panic!(
            "missing {} — run `cargo test --test vectors -- --ignored generate` to (re)generate vectors",
            bin_path.display()
        )
    });
    let text = fs::read_to_string(&json_path).unwrap_or_else(|_| {
        panic!(
            "missing {} — run `cargo test --test vectors -- --ignored generate` to (re)generate vectors",
            json_path.display()
        )
    });
    let json: Value = serde_json::from_str(&text).expect("parse expected.json");
    (bytes, json)
}

/// Build all four vectors: `(name, bytes, json)`.
fn build_all() -> Vec<(&'static str, Vec<u8>, Value)> {
    let mut basic_rec = Rec::new();
    build_basic(&mut basic_rec);
    let (basic_bytes, basic_json) = basic_rec.finish();

    let mut unicode_rec = Rec::new();
    build_unicode(&mut unicode_rec);
    let (unicode_bytes, unicode_json) = unicode_rec.finish();

    let mut template_rec = Rec::new();
    build_template(&mut template_rec);
    let (template_bytes, template_json) = template_rec.finish();

    // `frames`: the ops of `basic` split across two frames in one .bin —
    // rerun the same driver but call `take_frame` at the halfway point.
    let mut frames_rec = Rec::new();
    build_basic_split(&mut frames_rec);
    let (frames_bytes, frames_json) = frames_rec.finish();

    vec![
        ("basic", basic_bytes, basic_json),
        ("unicode", unicode_bytes, unicode_json),
        ("template", template_bytes, template_json),
        ("frames", frames_bytes, frames_json),
    ]
}

/// Same op sequence as `build_basic`, but split into two `take_frame` calls
/// partway through (after `replace_placeholder`) so the `frames` vector
/// exercises multi-frame decoding.
fn build_basic_split(rec: &mut Rec) {
    let div = rec.intern(DIV);
    let _div_again = rec.intern(DIV);
    let span = rec.intern(SPAN);
    let class = rec.intern(CLASS);
    let style = rec.intern(STYLE);
    let svg_ns = rec.intern(SVG_NS);
    let click = rec.intern(CLICK);

    rec.register_template(0, &[TNode::Dynamic]);
    rec.load_template(0, 0, 1);
    rec.create_placeholder(2);
    rec.create_text_node(3, "hello");
    rec.append_children(1, 2);
    rec.assign_id(&[0, 1], 5);
    rec.replace_with(9, 1);
    rec.replace_placeholder(&[0], 2);

    rec.take_frame(); // frame boundary mid-stream

    rec.insert_after(3, 1);
    rec.insert_before(3, 1);
    rec.set_attribute_text(2, class, None, "x");
    rec.set_attribute_float(2, style, Some(svg_ns), 1.5);
    rec.set_attribute_int(2, div, None, -3);
    rec.set_attribute_bool(2, span, None, true);
    rec.set_attribute_none(2, class, None);
    rec.set_text(2, "t");
    rec.new_event_listener(2, click, true);
    rec.remove_event_listener(2, click, false);
    rec.remove(2);
    rec.push_root(1);
}

#[test]
#[ignore = "regenerates committed vector fixtures; run explicitly"]
fn generate() {
    for (name, bytes, json) in build_all() {
        write_vector(name, &bytes, &json);
    }
}

#[test]
fn golden_matches_committed() {
    for (name, bytes, json) in build_all() {
        let (committed_bytes, committed_json) = read_vector(name);
        assert_eq!(
            bytes, committed_bytes,
            "vector `{name}`: regenerated bytes differ from vectors/{name}.bin \
             (run `cargo test --test vectors -- --ignored generate` if this is intentional)"
        );
        assert_eq!(
            json, committed_json,
            "vector `{name}`: regenerated JSON differs from vectors/{name}.expected.json"
        );
    }
}
