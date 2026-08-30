//! Host-transport test fixture: no-dioxus guest exercising both mutation
//! transports (stream / call, selected by the `call-transport` feature) and
//! the round-trip event path.
//!
//! Governing doc: wit/world.wit (normative wire format + world `app`).
//! Op-sequence/behavior spec: the polyengine-dioxus host-runtime dispatch
//! (fixtures/surface-probe territory) — see its "Behavior" section for the
//! exact template/listener layout this file builds; cited inline as
//! `dispatch:<item>` where a design choice needs the source.
//!
//! # DOM built (root id 0 is the host mount root)
//!
//! ```text
//! <section class="probe" title="probe-section">hdrready<!--placeholder--></section><input>
//! ```
//!
//! - `section` (id 1): static template attr `class="probe"` (register-
//!   template's own attr list — exercises the "nested + attrs" register-
//!   template shape), text child "hdr", a dynamic child replaced with the
//!   "ready" text node (id 2, via create-text-node + replace-placeholder),
//!   and a THIRD dynamic child left as a bare placeholder comment with an
//!   assigned id (assign-id, id 4) — exercising assign-id independently of
//!   replace-placeholder rather than on the same slot.
//!   Listeners: `click` and `keydown`, both bubbling (new-event-listener
//!   x2), plus a `set-attribute` TEXT op (`title`).
//! - `input` (id 5): a second template's root (load-template, register-
//!   template again), with an `input` listener (bubbling) and a
//!   `set-attribute` BOOL op (`disabled` = false, exercising the boolean-
//!   attribute-removal path — the applier's BOOL_ATTRS table treats a
//!   falsy bool as "remove", so this leaves `<input>` bare).
//!
//! # Event names / interned string ids
//!
//! Reused across BOTH roles where the text is identical (e.g. the string
//! "input" serves as both the second template's tag name and the third
//! listener's event name — same interned slot, no wire-format rule forbids
//! it): 0=`section` 1=`class` 2=`click` 3=`keydown` 4=`input` 5=`title`
//! 6=`disabled`. `handle-event`'s `name: u16` therefore arrives as one of
//! {2, 3, 4} for our own listeners; `event_name_for_id` below is this
//! fixture's (test-only) reverse lookup — real Dioxus tracks this
//! guest-side via its own event tables, which this minimal probe doesn't
//! reproduce.

wit_bindgen::generate!({
    path: "../../wit",
    world: "app",
});

#[cfg(not(feature = "call-transport"))]
use core::cell::RefCell;
use polymorph::dioxus::surface::{self, DomEvent as HostDomEvent};

// -- wire encoding ------------------------------------------------------------
//
// Mirrors host/src/decoder.ts's Cursor, in reverse (encode instead of
// decode). The byte layout is normative in wit/world.wit's "# Opcodes" /
// "# Primitive operand encodings" doc comments (reproduced above the
// `generate!` call via the WIT source itself); cited inline as
// `wit:<opcode>`.
mod wire {
    const NONE_STRREF: u16 = 0xffff;

    pub struct Encoder {
        pub ops: Vec<u8>,
        pub strings: String,
    }

    impl Encoder {
        pub fn new() -> Self {
            Self { ops: Vec::new(), strings: String::new() }
        }

        fn u8(&mut self, v: u8) {
            self.ops.push(v);
        }
        fn u16(&mut self, v: u16) {
            self.ops.extend_from_slice(&v.to_le_bytes());
        }
        fn u32(&mut self, v: u32) {
            self.ops.extend_from_slice(&v.to_le_bytes());
        }

        /// strref: u16, 0xffff = none (wit "Primitive operand encodings").
        fn strref(&mut self, v: Option<u16>) {
            self.u16(v.unwrap_or(NONE_STRREF));
        }

        /// path: u8 length, then that many u8 child indices.
        fn path(&mut self, p: &[u8]) {
            self.u8(p.len() as u8);
            self.ops.extend_from_slice(p);
        }

        /// dynstr: u16 UTF-16 code-unit length, then content appended to the
        /// string segment (wit "Primitive operand encodings" — the u32
        /// extended-length form is never needed by this fixture's short
        /// ASCII strings).
        fn dynstr(&mut self, s: &str) {
            let len16: usize = s.chars().map(char::len_utf16).sum();
            self.u16(len16 as u16);
            self.strings.push_str(s);
        }

        // -- ops (wit:0x01.."0x11) --------------------------------------------

        pub fn cache_string(&mut self, id: u16, s: &str) {
            self.u8(0x01);
            self.u16(id);
            self.dynstr(s);
        }

        /// Begin `register-template`; caller writes `nroots` node trees via
        /// `element_start`/`attr`/`children_count`/`text_node`/`dynamic_node`
        /// in wire order (depth-first, matching decodeTemplateNode).
        pub fn register_template_header(&mut self, tmpl: u16, nroots: u16) {
            self.u8(0x02);
            self.u16(tmpl);
            self.u16(nroots);
        }
        pub fn tmpl_element_header(&mut self, tag: u16, ns: Option<u16>, nattrs: u16) {
            self.u8(0x00); // node kind: element
            self.u16(tag);
            self.strref(ns);
            self.u16(nattrs);
        }
        pub fn tmpl_attr(&mut self, name: u16, ns: Option<u16>, value: &str) {
            self.u16(name);
            self.strref(ns);
            self.dynstr(value);
        }
        pub fn tmpl_children_header(&mut self, nchildren: u16) {
            self.u16(nchildren);
        }
        pub fn tmpl_text(&mut self, value: &str) {
            self.u8(0x01);
            self.dynstr(value);
        }
        pub fn tmpl_dynamic(&mut self) {
            self.u8(0x02);
        }

        pub fn append_children(&mut self, id: u32, m: u32) {
            self.u8(0x03);
            self.u32(id);
            self.u32(m);
        }
        pub fn assign_id(&mut self, path: &[u8], id: u32) {
            self.u8(0x04);
            self.path(path);
            self.u32(id);
        }
        pub fn create_text_node(&mut self, id: u32, text: &str) {
            self.u8(0x06);
            self.u32(id);
            self.dynstr(text);
        }
        pub fn load_template(&mut self, tmpl: u16, root: u16, id: u32) {
            self.u8(0x07);
            self.u16(tmpl);
            self.u16(root);
            self.u32(id);
        }
        pub fn replace_placeholder(&mut self, path: &[u8], m: u32) {
            self.u8(0x09);
            self.path(path);
            self.u32(m);
        }
        pub fn set_attribute_text(&mut self, id: u32, name: u16, ns: Option<u16>, value: &str) {
            self.u8(0x0c);
            self.u32(id);
            self.u16(name);
            self.strref(ns);
            self.u8(0x00); // attrval kind: text
            self.dynstr(value);
        }
        pub fn set_attribute_bool(&mut self, id: u32, name: u16, ns: Option<u16>, value: bool) {
            self.u8(0x0c);
            self.u32(id);
            self.u16(name);
            self.strref(ns);
            self.u8(0x03); // attrval kind: bool
            self.u8(value as u8);
        }
        pub fn set_text(&mut self, id: u32, text: &str) {
            self.u8(0x0d);
            self.u32(id);
            self.dynstr(text);
        }
        pub fn new_event_listener(&mut self, id: u32, name: u16, bubbles: bool) {
            self.u8(0x0e);
            self.u32(id);
            self.u16(name);
            self.u8(bubbles as u8); // flags bit0 = bubbles
        }

        pub fn finish(self) -> (Vec<u8>, String) {
            (self.ops, self.strings)
        }
    }

    /// Stream-transport framing (wit/world.wit "# Framing (stream transport
    /// only)"): `frame-len:u32 strings-len:u32 strings ops`.
    #[cfg(not(feature = "call-transport"))]
    pub fn frame(ops: &[u8], strings: &str) -> Vec<u8> {
        let strings_bytes = strings.as_bytes();
        let frame_len = 4 + strings_bytes.len() as u32 + ops.len() as u32;
        let mut buf = Vec::with_capacity(4 + frame_len as usize);
        buf.extend_from_slice(&frame_len.to_le_bytes());
        buf.extend_from_slice(&(strings_bytes.len() as u32).to_le_bytes());
        buf.extend_from_slice(strings_bytes);
        buf.extend_from_slice(ops);
        buf
    }
}

// -- interned string ids (see module doc) ------------------------------------

const STR_SECTION: u16 = 0;
const STR_CLASS: u16 = 1;
const STR_CLICK: u16 = 2;
const STR_KEYDOWN: u16 = 3;
const STR_INPUT: u16 = 4; // tag "input" AND event name "input" — same text
const STR_TITLE: u16 = 5;
const STR_DISABLED: u16 = 6;

fn event_name_for_id(id: u16) -> &'static str {
    match id {
        STR_CLICK => "click",
        STR_KEYDOWN => "keydown",
        STR_INPUT => "input",
        _ => "unknown",
    }
}

/// Builds the initial batch: see the module doc's "DOM built" section for
/// the exact op sequence and its rationale.
fn build_initial_batch() -> (Vec<u8>, String) {
    let mut e = wire::Encoder::new();

    e.cache_string(STR_SECTION, "section");
    e.cache_string(STR_CLASS, "class");
    e.cache_string(STR_CLICK, "click");
    e.cache_string(STR_KEYDOWN, "keydown");
    e.cache_string(STR_INPUT, "input");
    e.cache_string(STR_TITLE, "title");
    e.cache_string(STR_DISABLED, "disabled");

    // register-template(tmpl=0): <section class="probe">hdr{dyn}{dyn}</section>
    e.register_template_header(0, 1);
    e.tmpl_element_header(STR_SECTION, None, 1);
    e.tmpl_attr(STR_CLASS, None, "probe");
    e.tmpl_children_header(3);
    e.tmpl_text("hdr");
    e.tmpl_dynamic(); // idx1 — replaced below with the "ready" text node
    e.tmpl_dynamic(); // idx2 — left as a bare placeholder, assign-id'd

    // register-template(tmpl=1): <input>
    e.register_template_header(1, 1);
    e.tmpl_element_header(STR_INPUT, None, 0);
    e.tmpl_children_header(0);

    // load-template(tmpl=0) -> id=1 (section); stack: [root, section]
    e.load_template(0, 0, 1);
    // assign-id exercised on the OTHER dynamic slot (idx2), independently
    // of the replace-placeholder below (dispatch: "assign-id ... exercise
    // ... independently").
    e.assign_id(&[2], 4);
    // create-text-node(id=2, "ready"); stack: [root, section, text(2)]
    e.create_text_node(2, "ready");
    // replace-placeholder(path=[1], m=1): pop text(2), replace idx1 slot.
    // stack: [root, section]
    e.replace_placeholder(&[1], 1);
    // set-attribute TEXT on section.
    e.set_attribute_text(1, STR_TITLE, None, "probe-section");
    // two bubbling listeners on section.
    e.new_event_listener(1, STR_CLICK, true);
    e.new_event_listener(1, STR_KEYDOWN, true);
    // append-children(root, m=1): pop section, attach under root.
    e.append_children(0, 1);

    // load-template(tmpl=1) -> id=5 (input); stack: [root, input]
    e.load_template(1, 0, 5);
    // set-attribute BOOL (false -> removed by the applier's boolean-
    // attribute table; exercises the bool attrval path regardless).
    e.set_attribute_bool(5, STR_DISABLED, None, false);
    e.new_event_listener(5, STR_INPUT, true);
    // append-children(root, m=1): pop input, attach under root.
    e.append_children(0, 1);

    e.finish()
}

/// One-line deterministic summary written into the "ready" text node (id 2)
/// on every dispatched event: `{name}:{kind}:{detail}` (dispatch's exact
/// format). Returns `(summary, prevent_and_stop)`.
fn summarize(name: u16, payload: &Payload) -> (String, bool) {
    let name = event_name_for_id(name);
    match payload {
        Payload::Mouse(m) => {
            let detail = format!("{},{}", m.buttons, m.client_x as i64);
            let prevent = m.buttons == 7;
            (format!("{name}:mouse:{detail}"), prevent)
        }
        Payload::Keyboard(k) => (format!("{name}:keyboard:{}", k.key), false),
        Payload::Form(f) => (format!("{name}:form:{}", f.value), false),
        Payload::Empty => (format!("{name}:empty:-"), false),
        _ => (format!("{name}:other:-"), false),
    }
}

fn build_event_batch(name: u16, payload: &Payload) -> (Vec<u8>, String, bool) {
    let (summary, prevent) = summarize(name, payload);
    let mut e = wire::Encoder::new();
    e.set_text(2, &summary);
    let (ops, strings) = e.finish();
    (ops, strings, prevent)
}

// The stream transport's writer half, stashed between `run`'s initial write
// and every later `handle-event` write (dispatch: "stash the writer half ...
// in a thread_local RefCell; writes complete inline while the host session
// is parked, so no cross-task interleaving. Do not hold RefCell borrows
// across awaits." — every use below `take()`s the writer out of the cell
// before awaiting, and puts it back after, so no borrow spans an `.await`).
#[cfg(not(feature = "call-transport"))]
thread_local! {
    static WRITER: RefCell<Option<wit_bindgen::rt::async_support::StreamWriter<u8>>> = const { RefCell::new(None) };
}

// `run`'s permanent park (wit: "serve the Dioxus scheduler forever" — its
// promise never settles in normal operation). A bare `core::future::pending()`
// is NOT a legal way to park under the component-model-async callback ABI:
// it registers no waitable at all, and wit-bindgen's own generated shim hits
// an internal `unreachable!()` when a task polls Pending with nothing
// waitable armed. A genuinely parked `StreamReader::next()` on a spare
// never-written, never-dropped stream registers a REAL waitable (a stream
// read), so the task legitimately hangs — the documented "embedder may
// still act" park, never a trap. The writer half is stashed forever (never
// taken back out, so never dropped): dropping an unwritten stream writer is
// legal per the CABI (unlike `future`'s A8 write-before-drop obligation),
// but we don't even want the reader to observe end-of-stream.
#[cfg(not(feature = "call-transport"))]
thread_local! {
    static PARK_WRITER: RefCell<Option<wit_bindgen::rt::async_support::StreamWriter<u8>>> = const { RefCell::new(None) };
}

struct Component;

impl Guest for Component {
    async fn run() {
        let (ops, strings) = build_initial_batch();

        #[cfg(not(feature = "call-transport"))]
        {
            // Guest creates the stream and hands the host the read end
            // ONCE, before the first batch (wit: "Called at most once,
            // before the first batch is written").
            let (mut writer, reader) = wit_stream::new::<u8>();
            surface::open(reader).await;
            let frame = wire::frame(&ops, &strings);
            writer.write_all(frame).await;
            WRITER.with(|cell| *cell.borrow_mut() = Some(writer));
        }
        #[cfg(feature = "call-transport")]
        {
            surface::flush(&ops, &strings);
            // CONTRACT: the dispatch's spec says "For the call build run()
            // can also park the same way after the initial flush" — but a
            // purely-local park (a stream/future the host never sees) has
            // NO host-side retention (embedder-api.md amendment A15: the
            // deadlock-verdict suppression tracks host retention), and the
            // call transport's world surface (`flush` only, no channel)
            // gives the guest nothing host-retained to park on. Empirically
            // confirmed: parking here traps `deadlock detected: event loop
            // cannot make further progress` — a real, correctly-detected
            // deadlock, not a bug to work around. Returning normally is the
            // conservative reading: `handle-event` remains fully callable
            // afterward (it only ever calls the sync `flush` import, which
            // needs no ongoing task), so nothing in the dispatch's actual
            // test assertions (round-trip + ordering) depends on `run`
            // staying unsettled for this transport. Flagged prominently in
            // the track report.
        }

        // wit: "then serve the Dioxus scheduler forever" — this probe has
        // no scheduler; park via a genuine waitable (see PARK_WRITER doc).
        // Stream transport only (see the CONTRACT note above for why the
        // call transport can't do this).
        #[cfg(not(feature = "call-transport"))]
        {
            let (park_writer, mut park_reader) = wit_stream::new::<u8>();
            PARK_WRITER.with(|cell| *cell.borrow_mut() = Some(park_writer));
            park_reader.next().await;
            unreachable!("PARK_WRITER is held forever and never written/dropped");
        }
    }

    async fn handle_event(_target: u32, name: u16, payload: Payload, ev: &HostDomEvent) {
        let (ops, strings, prevent) = build_event_batch(name, &payload);

        #[cfg(not(feature = "call-transport"))]
        {
            let frame = wire::frame(&ops, &strings);
            let mut writer = WRITER
                .with(|cell| cell.borrow_mut().take())
                .expect("handle-event dispatched before run() opened the stream");
            writer.write_all(frame).await;
            WRITER.with(|cell| *cell.borrow_mut() = Some(writer));
        }
        #[cfg(feature = "call-transport")]
        {
            surface::flush(&ops, &strings);
        }

        if prevent {
            ev.prevent_default();
            ev.stop_propagation();
        }
    }
}

export!(Component);
