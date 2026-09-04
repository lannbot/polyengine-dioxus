//! Host test fixture: no-dioxus guest exercising the mutation channel and
//! the round-trip event path.
//!
//! Governing doc: wit/world.wit (the `mutations` interface — the normative
//! operation schema — and the world `app`).
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
//!   Listeners: `click`, `keydown` and `touchstart`, all bubbling
//!   (new-event-listener x3), plus a `set-attribute` TEXT op (`title`).
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
//! listener's event name — same interned slot, nothing in the schema forbids
//! it): 0=`section` 1=`class` 2=`click` 3=`keydown` 4=`input` 5=`title`
//! 6=`disabled` 7=`touchstart`. `handle-event`'s `name: u16` therefore
//! arrives as one of {2, 3, 4, 7} for our own listeners;
//! `event_name_for_id` below is this
//! fixture's (test-only) reverse lookup — real Dioxus tracks this
//! guest-side via its own event tables, which this minimal probe doesn't
//! reproduce.
//!
//! # Event summary format
//!
//! Every dispatched event writes one deterministic line into the "ready"
//! text node (id 2): `{name}:{kind}:{detail}`. `detail` is per-kind:
//!
//! - `mouse`: `{buttons},{client-x as i64}`
//! - `keyboard`: `{key}`
//! - `form`: `{value}`
//! - `empty`: `-`
//! - `touch`: `{nt}/{nc}/{ng};{point0};{mods}`, where `nt`/`nc`/`ng` are
//!   the lengths of `touches`/`changed-touches`/`target-touches`;
//!   `point0` is `touches[0]`'s eleven fields in wit declaration order —
//!   `identifier,client-x,client-y,page-x,page-y,screen-x,screen-y,
//!   radius-x,radius-y,rotation-angle,force` (f64s via Rust's
//!   shortest-round-trip `Display`, so `100.0` prints `100`), or `-` when
//!   `touches` is empty; and `mods` is a fixed four-slot mask
//!   `alt|ctrl|meta|shift` rendering each set flag as `a`/`c`/`m`/`s` and
//!   each unset one as `-`. Witnessing the three lengths, every nested
//!   per-point field AND the flags is deliberate: the host builds these
//!   values by a hand-written kebab->camelCase naming convention
//!   (host/src/events.ts) and a misnamed field lowers silently as a
//!   default, so a detail that reported only list lengths would pass with
//!   every point field zeroed.
//! - anything else: `-`

wit_bindgen::generate!({
    path: "../../wit",
    world: "app",
});

use core::cell::RefCell;
use polymorph::dioxus::events::{DomEvent as HostDomEvent, Modifiers};
// `Operation` itself is already in scope: the world `use`s it, so
// `generate!` re-exports it at the crate root.
use polymorph::dioxus::mutations::{
    AssignId, AttrValue, CacheString, CreateTextNode, EventListener, LoadTemplate, PathOp,
    RegisterTemplate, SetAttribute, SetText, StackOp, TemplateAttr, TemplateElement, TemplateNode,
};

// -- interned string ids (see module doc) ------------------------------------

const STR_SECTION: u16 = 0;
const STR_CLASS: u16 = 1;
const STR_CLICK: u16 = 2;
const STR_KEYDOWN: u16 = 3;
const STR_INPUT: u16 = 4; // tag "input" AND event name "input" — same text
const STR_TITLE: u16 = 5;
const STR_DISABLED: u16 = 6;
const STR_TOUCHSTART: u16 = 7;

fn event_name_for_id(id: u16) -> &'static str {
    match id {
        STR_CLICK => "click",
        STR_KEYDOWN => "keydown",
        STR_INPUT => "input",
        STR_TOUCHSTART => "touchstart",
        _ => "unknown",
    }
}

/// Builds the initial batch: see the module doc's "DOM built" section for
/// the exact op sequence and its rationale.
fn build_initial_batch() -> Vec<Operation> {
    fn cache(id: u16, s: &str) -> Operation {
        Operation::CacheString(CacheString { id, str: s.to_string() })
    }

    vec![
        cache(STR_SECTION, "section"),
        cache(STR_CLASS, "class"),
        cache(STR_CLICK, "click"),
        cache(STR_KEYDOWN, "keydown"),
        cache(STR_INPUT, "input"),
        cache(STR_TITLE, "title"),
        cache(STR_DISABLED, "disabled"),
        cache(STR_TOUCHSTART, "touchstart"),
        // register-template(tmpl=0): <section class="probe">hdr{dyn}{dyn}</section>
        // `nodes` is the arena, in pre-order; `roots` and `children` index
        // into it (wit: `register-template` is not a tree — recursive WIT
        // types are rejected).
        Operation::RegisterTemplate(RegisterTemplate {
            id: 0,
            nodes: vec![
                TemplateNode::Element(TemplateElement {
                    tag: STR_SECTION,
                    ns: None,
                    attrs: vec![TemplateAttr {
                        name: STR_CLASS,
                        ns: None,
                        value: "probe".to_string(),
                    }],
                    children: vec![1, 2, 3],
                }),
                TemplateNode::Text("hdr".to_string()),
                TemplateNode::Dynamic, // child idx1 — replaced below with "ready"
                TemplateNode::Dynamic, // child idx2 — left bare, assign-id'd
            ],
            roots: vec![0],
        }),
        // register-template(tmpl=1): <input>
        Operation::RegisterTemplate(RegisterTemplate {
            id: 1,
            nodes: vec![TemplateNode::Element(TemplateElement {
                tag: STR_INPUT,
                ns: None,
                attrs: Vec::new(),
                children: Vec::new(),
            })],
            roots: vec![0],
        }),
        // load-template(tmpl=0) -> id=1 (section); stack: [root, section]
        Operation::LoadTemplate(LoadTemplate { id: 1, tmpl: 0, root: 0 }),
        // assign-id exercised on the OTHER dynamic slot (idx2), independently
        // of the replace-placeholder below (dispatch: "assign-id ... exercise
        // ... independently").
        Operation::AssignId(AssignId { path: vec![2], id: 4 }),
        // create-text-node(id=2, "ready"); stack: [root, section, text(2)]
        Operation::CreateTextNode(CreateTextNode { id: 2, text: "ready".to_string() }),
        // replace-placeholder(path=[1], m=1): pop text(2), replace idx1 slot.
        // stack: [root, section]
        Operation::ReplacePlaceholder(PathOp { path: vec![1], m: 1 }),
        // set-attribute TEXT on section.
        Operation::SetAttribute(SetAttribute {
            id: 1,
            name: STR_TITLE,
            ns: None,
            value: AttrValue::Text("probe-section".to_string()),
        }),
        // three bubbling listeners on section.
        Operation::NewEventListener(EventListener { id: 1, name: STR_CLICK, bubbles: true }),
        Operation::NewEventListener(EventListener { id: 1, name: STR_KEYDOWN, bubbles: true }),
        Operation::NewEventListener(EventListener { id: 1, name: STR_TOUCHSTART, bubbles: true }),
        // append-children(root, m=1): pop section, attach under root.
        Operation::AppendChildren(StackOp { id: 0, m: 1 }),
        // load-template(tmpl=1) -> id=5 (input); stack: [root, input]
        Operation::LoadTemplate(LoadTemplate { id: 5, tmpl: 1, root: 0 }),
        // set-attribute BOOL (false -> removed by the applier's boolean-
        // attribute table; exercises the bool attr-value path regardless).
        Operation::SetAttribute(SetAttribute {
            id: 5,
            name: STR_DISABLED,
            ns: None,
            value: AttrValue::Boolean(false),
        }),
        Operation::NewEventListener(EventListener { id: 5, name: STR_INPUT, bubbles: true }),
        // append-children(root, m=1): pop input, attach under root.
        Operation::AppendChildren(StackOp { id: 0, m: 1 }),
    ]
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
        Payload::Touch(t) => {
            // Witnesses the three list lengths, every nested field of
            // touches[0], and the modifiers flags — see the module doc's
            // "Event summary format". Anything less would still pass with
            // the per-point fields silently defaulted to 0.
            let point = t.touches.first().map_or_else(
                || "-".to_string(),
                |p| {
                    format!(
                        "{},{},{},{},{},{},{},{},{},{},{}",
                        p.identifier,
                        p.client_x,
                        p.client_y,
                        p.page_x,
                        p.page_y,
                        p.screen_x,
                        p.screen_y,
                        p.radius_x,
                        p.radius_y,
                        p.rotation_angle,
                        p.force,
                    )
                },
            );
            let flag = |on: bool, c: char| if on { c } else { '-' };
            let m = t.mods;
            let mods: String = [
                flag(m.contains(Modifiers::ALT), 'a'),
                flag(m.contains(Modifiers::CTRL), 'c'),
                flag(m.contains(Modifiers::META), 'm'),
                flag(m.contains(Modifiers::SHIFT), 's'),
            ]
            .iter()
            .collect();
            let detail = format!(
                "{}/{}/{};{point};{mods}",
                t.touches.len(),
                t.changed_touches.len(),
                t.target_touches.len(),
            );
            (format!("{name}:touch:{detail}"), false)
        }
        Payload::Empty => (format!("{name}:empty:-"), false),
        _ => (format!("{name}:other:-"), false),
    }
}

fn build_event_batch(name: u16, payload: &Payload) -> (Vec<Operation>, bool) {
    let (summary, prevent) = summarize(name, payload);
    (vec![Operation::SetText(SetText { id: 2, text: summary })], prevent)
}

// The mutation channel's writer half. `run` creates it and parks it here;
// the spawned initial-batch task and every later `handle-event` write take
// it out and put it back (dispatch: "stash the writer half ...
// in a thread_local RefCell; writes complete inline while the host is
// reading, so no cross-task interleaving. Do not hold RefCell borrows
// across awaits." — every use below `take()`s the writer out of the cell
// before awaiting, and puts it back after, so no borrow spans an `.await`).
// Keeping it here is also what holds the stream OPEN: dropping this writer
// is what would signal end-of-stream to the host, so it is never dropped.
thread_local! {
    static WRITER: RefCell<Option<wit_bindgen::rt::async_support::StreamWriter<Operation>>> = const { RefCell::new(None) };
}

struct Component;

impl Guest for Component {
    async fn run() -> wit_bindgen::rt::async_support::StreamReader<Operation> {
        // Create the channel and hand the read end back as `run`'s return
        // value (wit: `export run: async func() -> stream<operation>`).
        // Nothing is written from this body: a write here would park waiting
        // for a reader the host cannot have until this promise settles.
        let (writer, reader) = wit_stream::new::<Operation>();
        WRITER.with(|cell| *cell.borrow_mut() = Some(writer));

        // The initial batch goes out from a spawned task, after the return.
        // Rendezvous semantics make the ordering safe: the write parks until
        // the host reads, so it cannot be lost by racing ahead of the host.
        wit_bindgen::rt::async_support::spawn_local(async move {
            let batch = build_initial_batch();
            let mut writer = WRITER
                .with(|cell| cell.borrow_mut().take())
                .expect("initial batch: writer taken before the first write");
            writer.write_all(batch).await;
            WRITER.with(|cell| *cell.borrow_mut() = Some(writer));
        });
        // This task ends here; the spawned task ends once the initial batch
        // is delivered. Neither closes the stream, because the WRITER half is
        // put back into the thread_local rather than dropped — it stays alive
        // there for `handle-event`, and the stream is open exactly as long as
        // it is. (The old park-forever spare-stream hack this fixture used to
        // keep `run` alive is gone with the return-the-stream contract.)

        reader
    }

    async fn handle_event(_target: u32, name: u16, payload: Payload, ev: &HostDomEvent) {
        let (batch, prevent) = build_event_batch(name, &payload);

        let mut writer = WRITER
            .with(|cell| cell.borrow_mut().take())
            .expect("handle-event dispatched before run() opened the stream");
        writer.write_all(batch).await;
        WRITER.with(|cell| *cell.borrow_mut() = Some(writer));

        if prevent {
            ev.prevent_default();
            ev.stop_propagation();
        }
    }
}

export!(Component);
