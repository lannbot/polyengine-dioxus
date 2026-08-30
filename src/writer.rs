//! [`MutationWriter`]: a `dioxus_core::WriteMutations` sink that encodes
//! straight into a [`protocol::Batch`] — no intermediate `Vec<Mutation>`.
//!
//! The mapping mirrors dioxus's own `WriteMutations`→channel renderer
//! (dioxus-interpreter-js `write_native_mutations.rs`): templates are
//! registered on first encounter and thereafter referenced by a guest-assigned
//! `u16`, and listener ops carry `event_bubbles(name)` because the host
//! delegates bubbling events at the mount root.
//!
//! # Interning invariant
//!
//! [`Interner::intern`] *emits* a `cache-string` op the first time it sees a
//! name. That op must never land in the middle of another op's operands, so
//! every string a composite op needs is interned **before** the op's first
//! byte is written. This matters most for `register-template`, whose node
//! grammar is recursive and self-delimiting: `intern_template_node` walks the
//! tree interning tags/namespaces/attribute names first, then
//! `emit_template_node` writes the grammar with no further interning.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use dioxus_core::{AttributeValue, ElementId, Template, TemplateAttribute, TemplateNode, WriteMutations};

use crate::protocol::{Batch, Interner};

/// Encodes dioxus mutations into a [`Batch`].
///
/// The interner is shared (`Rc<RefCell<_>>`) with the event-dispatch path,
/// which needs the reverse `u16 -> &'static str` lookup to turn a
/// `handle-event` name id back into a dioxus event name.
pub struct MutationWriter {
    /// The batch being filled. Drained by the driver's flush.
    pub batch: Batch,
    interner: Rc<RefCell<Interner>>,
    /// Guest-assigned template ids, keyed by `Template`'s pointer identity
    /// (dioxus's `Hash`/`PartialEq` for `Template` compare by pointer when
    /// the build merges identical statics, by value otherwise — either way a
    /// hit means the host already has the registration).
    templates: HashMap<Template, u16>,
}

impl MutationWriter {
    /// Create a writer sharing `interner` with the event-dispatch path.
    pub fn new(interner: Rc<RefCell<Interner>>) -> Self {
        MutationWriter { batch: Batch::new(), interner, templates: HashMap::new() }
    }

    /// The shared interner handle.
    pub fn interner(&self) -> &Rc<RefCell<Interner>> {
        &self.interner
    }

    fn intern(&mut self, s: &'static str) -> u16 {
        self.interner.borrow_mut().intern(&mut self.batch, s)
    }

    fn intern_opt(&mut self, s: Option<&'static str>) -> Option<u16> {
        s.map(|s| self.intern(s))
    }

    /// Pass 1 of template registration: intern every `&'static str` the node
    /// grammar will reference, so no `cache-string` op interleaves with the
    /// grammar emitted by [`Self::emit_template_node`].
    fn intern_template_node(&mut self, node: &'static TemplateNode) {
        if let TemplateNode::Element { tag, namespace, attrs, children } = node {
            self.intern(tag);
            self.intern_opt(*namespace);
            for attr in *attrs {
                // Dynamic template attributes are realized later through
                // `set_attribute`; only static ones are part of the template.
                if let TemplateAttribute::Static { name, namespace, .. } = attr {
                    self.intern(name);
                    self.intern_opt(*namespace);
                }
            }
            for child in *children {
                self.intern_template_node(child);
            }
        }
    }

    /// Pass 2: emit the `node` grammar from `wit/world.wit`'s
    /// `register-template`. Must run after [`Self::intern_template_node`].
    fn emit_template_node(&mut self, node: &'static TemplateNode) {
        match node {
            TemplateNode::Element { tag, namespace, attrs, children } => {
                let tag_id = self.intern(tag);
                let ns_id = self.intern_opt(*namespace);
                let statics: Vec<_> = attrs
                    .iter()
                    .filter_map(|attr| match attr {
                        TemplateAttribute::Static { name, value, namespace } => {
                            Some((*name, *value, *namespace))
                        }
                        TemplateAttribute::Dynamic { .. } => None,
                    })
                    .collect();
                self.batch.template_element_open(tag_id, ns_id, statics.len() as u16);
                for (name, value, ns) in statics {
                    let name_id = self.intern(name);
                    let ns_id = self.intern_opt(ns);
                    self.batch.template_attr(name_id, ns_id, value);
                }
                self.batch.template_element_children(children.len() as u16);
                for child in *children {
                    self.emit_template_node(child);
                }
            }
            TemplateNode::Text { text } => self.batch.template_text(text),
            // A runtime-supplied node slot; the host materializes a
            // placeholder that later ops (assign-id / replace-placeholder)
            // address by path.
            TemplateNode::Dynamic { .. } => self.batch.template_dynamic(),
        }
    }

    /// Return the id for `template`, registering it on first encounter.
    fn template_id(&mut self, template: Template) -> u16 {
        if let Some(&id) = self.templates.get(&template) {
            return id;
        }
        let id = self.templates.len() as u16;
        self.templates.insert(template, id);

        for root in template.roots.iter() {
            self.intern_template_node(root);
        }
        self.batch.register_template(id, template.roots.len() as u16);
        for root in template.roots.iter() {
            self.emit_template_node(root);
        }
        id
    }
}

impl WriteMutations for MutationWriter {
    fn append_children(&mut self, id: ElementId, m: usize) {
        self.batch.append_children(id.0 as u32, m as u32);
    }

    fn assign_node_id(&mut self, path: &'static [u8], id: ElementId) {
        self.batch.assign_id(path, id.0 as u32);
    }

    fn create_placeholder(&mut self, id: ElementId) {
        self.batch.create_placeholder(id.0 as u32);
    }

    fn create_text_node(&mut self, value: &str, id: ElementId) {
        self.batch.create_text_node(id.0 as u32, value);
    }

    fn load_template(&mut self, template: Template, index: usize, id: ElementId) {
        let tmpl = self.template_id(template);
        self.batch.load_template(tmpl, index as u16, id.0 as u32);
    }

    fn replace_node_with(&mut self, id: ElementId, m: usize) {
        self.batch.replace_with(id.0 as u32, m as u32);
    }

    fn replace_placeholder_with_nodes(&mut self, path: &'static [u8], m: usize) {
        self.batch.replace_placeholder(path, m as u32);
    }

    fn insert_nodes_after(&mut self, id: ElementId, m: usize) {
        self.batch.insert_after(id.0 as u32, m as u32);
    }

    fn insert_nodes_before(&mut self, id: ElementId, m: usize) {
        self.batch.insert_before(id.0 as u32, m as u32);
    }

    fn set_attribute(
        &mut self,
        name: &'static str,
        ns: Option<&'static str>,
        value: &AttributeValue,
        id: ElementId,
    ) {
        // Intern first: `cache-string` must not split the set-attribute op.
        let name_id = self.intern(name);
        let ns_id = self.intern_opt(ns);
        let id = id.0 as u32;
        match value {
            AttributeValue::Text(s) => self.batch.set_attribute_text(id, name_id, ns_id, s),
            AttributeValue::Float(f) => self.batch.set_attribute_float(id, name_id, ns_id, *f),
            AttributeValue::Int(n) => self.batch.set_attribute_int(id, name_id, ns_id, *n),
            AttributeValue::Bool(b) => self.batch.set_attribute_bool(id, name_id, ns_id, *b),
            AttributeValue::None => self.batch.set_attribute_none(id, name_id, ns_id),
            // Listener: reaches the renderer through `create_event_listener`
            // instead (dioxus never asks a renderer to serialize a callback).
            // Any: a renderer-opaque payload for custom (non-HTML) renderers;
            // there is nothing to put on the wire. dioxus's own channel
            // renderer treats both as unreachable/ignored.
            AttributeValue::Listener(_) | AttributeValue::Any(_) => {}
        }
    }

    fn set_node_text(&mut self, value: &str, id: ElementId) {
        self.batch.set_text(id.0 as u32, value);
    }

    fn create_event_listener(&mut self, name: &'static str, id: ElementId) {
        let name_id = self.intern(name);
        self.batch.new_event_listener(id.0 as u32, name_id, dioxus_core_types::event_bubbles(name));
    }

    fn remove_event_listener(&mut self, name: &'static str, id: ElementId) {
        let name_id = self.intern(name);
        self.batch.remove_event_listener(id.0 as u32, name_id, dioxus_core_types::event_bubbles(name));
    }

    fn remove_node(&mut self, id: ElementId) {
        self.batch.remove(id.0 as u32);
    }

    fn push_root(&mut self, id: ElementId) {
        self.batch.push_root(id.0 as u32);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dioxus::prelude::*;

    fn writer() -> MutationWriter {
        MutationWriter::new(Rc::new(RefCell::new(Interner::new())))
    }

    /// Rebuild a real VirtualDom through the writer and compare the produced
    /// segments against a hand-driven `Batch`. Any drift in op order, operand
    /// widths, or intern-before-emit ordering shows up as a byte mismatch.
    #[test]
    fn rebuild_matches_hand_driven_batch() {
        fn app() -> Element {
            rsx! {
                div { class: "root",
                    button { onclick: move |_| {}, "hi" }
                }
            }
        }

        let mut w = writer();
        let mut dom = VirtualDom::new(app);
        dom.rebuild(&mut w);
        let (ops, strings) = w.batch.take_segments();

        // Hand-driven expectation. Template 0 has one root:
        //   div(class="root")[ button[ text "hi" ] ]
        // and the onclick listener is a *dynamic* attribute, so it is not part
        // of the static template; it arrives as new-event-listener after the
        // load. Intern ids are assigned in first-touch order during the
        // interning pass over the template: div, class, button.
        let mut b = Batch::new();
        let mut i = Interner::new();
        let div = i.intern(&mut b, "div");
        let class = i.intern(&mut b, "class");
        let button = i.intern(&mut b, "button");
        b.register_template(0, 1);
        b.template_element_open(div, None, 1);
        b.template_attr(class, None, "root");
        b.template_element_children(1);
        b.template_element_open(button, None, 0);
        b.template_element_children(1);
        b.template_text("hi");
        b.load_template(0, 0, 1);
        b.assign_id(&[0], 2);
        let click = i.intern(&mut b, "click");
        b.new_event_listener(2, click, true);
        b.append_children(0, 1);
        let (exp_ops, exp_strings) = b.take_segments();

        assert_eq!(strings, exp_strings, "string segment");
        assert_eq!(ops, exp_ops, "op segment");
    }

    /// A template is registered exactly once no matter how many times it is
    /// loaded: two list items sharing one `rsx!` site produce one
    /// register-template and two load-template ops.
    #[test]
    fn template_registered_once_per_identity() {
        fn app() -> Element {
            rsx! {
                for n in 0..3 {
                    span { key: "{n}", "{n}" }
                }
            }
        }

        let mut w = writer();
        let mut dom = VirtualDom::new(app);
        dom.rebuild(&mut w);
        let (ops, strings) = w.batch.take_segments();

        // One `rsx!` site => one `Template` identity, registered once and
        // loaded three times. Asserting on bytes (rather than counting
        // opcode-valued bytes, which also occur inside operands) keeps this
        // honest: the expected batch below contains exactly one
        // register-template.
        assert_eq!(w.templates.len(), 1);

        let mut b = Batch::new();
        let mut i = Interner::new();
        let span = i.intern(&mut b, "span");
        b.register_template(0, 1);
        b.template_element_open(span, None, 0);
        b.template_element_children(1);
        b.template_dynamic();
        for (root_id, text_id) in [(1u32, 2u32), (3, 4), (5, 6)] {
            b.load_template(0, 0, root_id);
            b.create_text_node(text_id, &((root_id - 1) / 2).to_string());
            b.replace_placeholder(&[0], 1);
        }
        b.append_children(0, 3);
        let (exp_ops, exp_strings) = b.take_segments();
        assert_eq!(strings, exp_strings, "string segment");
        assert_eq!(ops, exp_ops, "op segment");

        // Re-rendering the same tree must not re-register anything.
        let before = w.templates.len();
        dom.render_immediate(&mut w);
        assert_eq!(w.templates.len(), before);
    }

    /// Wire flags bit0 is dioxus's own `event_bubbles` verdict. `click`
    /// bubbles; `focus` does not — the host keys its delegation strategy off
    /// this bit, so getting it backwards silently breaks event delivery.
    #[test]
    fn listener_bubbles_bit_follows_dioxus_table() {
        assert!(dioxus_core_types::event_bubbles("click"));
        assert!(!dioxus_core_types::event_bubbles("focus"));

        let mut w = writer();
        w.create_event_listener("click", ElementId(1));
        w.create_event_listener("focus", ElementId(2));
        w.remove_event_listener("focus", ElementId(2));
        let (ops, strings) = w.batch.take_segments();

        let mut b = Batch::new();
        let mut i = Interner::new();
        let click = i.intern(&mut b, "click");
        b.new_event_listener(1, click, true);
        let focus = i.intern(&mut b, "focus");
        b.new_event_listener(2, focus, false);
        b.remove_event_listener(2, focus, false);
        let (exp_ops, exp_strings) = b.take_segments();

        assert_eq!(ops, exp_ops);
        assert_eq!(strings, exp_strings);
    }

    /// `AttributeValue::None` is a distinct wire kind (unconditional removal),
    /// not an empty text value, and the float/int/bool kinds keep their
    /// numeric encodings rather than being stringified.
    #[test]
    fn attribute_value_kinds_map_one_to_one() {
        let mut w = writer();
        w.set_attribute("width", None, &AttributeValue::Float(1.5), ElementId(1));
        w.set_attribute("tabindex", None, &AttributeValue::Int(-3), ElementId(1));
        w.set_attribute("hidden", None, &AttributeValue::Bool(false), ElementId(1));
        w.set_attribute("title", None, &AttributeValue::None, ElementId(1));
        let (ops, strings) = w.batch.take_segments();

        let mut b = Batch::new();
        let mut i = Interner::new();
        let width = i.intern(&mut b, "width");
        b.set_attribute_float(1, width, None, 1.5);
        let tabindex = i.intern(&mut b, "tabindex");
        b.set_attribute_int(1, tabindex, None, -3);
        let hidden = i.intern(&mut b, "hidden");
        b.set_attribute_bool(1, hidden, None, false);
        let title = i.intern(&mut b, "title");
        b.set_attribute_none(1, title, None);
        let (exp_ops, exp_strings) = b.take_segments();

        assert_eq!(ops, exp_ops);
        assert_eq!(strings, exp_strings);
    }

    /// `AttributeValue::Any` is renderer-opaque (it exists for non-HTML
    /// renderers) and produces no op at all. The `Listener` arm is covered by
    /// `rebuild_matches_hand_driven_batch`: the `onclick` there reaches the
    /// writer as a listener attribute and contributes a new-event-listener op
    /// rather than a set-attribute one.
    #[test]
    fn any_attribute_value_is_skipped() {
        let mut w = writer();
        w.set_attribute("data-x", None, &AttributeValue::any_value(7u32), ElementId(1));
        let (ops, _) = w.batch.take_segments();
        // Only the `cache-string` for "data-x" — no set-attribute op.
        const CACHE_STRING: u8 = 0x01;
        assert_eq!(ops[0], CACHE_STRING);
        const SET_ATTRIBUTE: u8 = 0x0c;
        assert!(!ops.contains(&SET_ATTRIBUTE));
    }
}
