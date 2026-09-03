//! [`TypedWriter`]: the `run-typed` channel's `dioxus_core::WriteMutations`
//! sink, pushing `mutations::Operation` values into a `Vec` instead of
//! encoding bytes.
//!
//! This is [`crate::writer::MutationWriter`] op-for-op, against the explicit
//! WIT schema in `wit/world.wit`'s `mutations` interface rather than the
//! byte format documented on `run`. The two are deliberately parallel and
//! deliberately not factored together: the byte channel is the benchmark
//! baseline for this spike, so nothing here may perturb it. Read the two
//! side by side — a divergence between them is a bug in this file, and the
//! host-side equivalence test is what catches it (this module names the
//! generated bindings, so it is `wasm32`-only and `cargo test` never builds
//! it).
//!
//! # Interning invariant
//!
//! `writer.rs`'s module doc states the discipline for the byte encoder: a
//! `cache-string` op must never land in the middle of another op's operands,
//! so every name a composite op needs is interned before that op's first
//! byte is written. Here the *mechanics* of the hazard are gone — an
//! `Operation` is a value, and pushing a `CacheString` cannot split one —
//! but the *ordering* requirement is identical and just as binding: the host
//! resolves a `str-ref` against definitions it has already seen, so every
//! `CacheString` must precede the operation referencing it in the batch.
//! This module therefore keeps the same two-pass template walk
//! (`intern_template_node` then `flatten_template_node`) and the same
//! intern-then-build order in `set_attribute` and the listener ops.
//!
//! # Why template registration flattens
//!
//! WIT forbids recursive type definitions, so `register-template` carries an
//! arena (`nodes`, plus `u32` indices in `roots` and each element's
//! `children`) where the byte grammar carries a self-delimiting recursive
//! tree. See the `mutations` interface doc in `wit/world.wit`.

use std::cell::RefCell;
use std::rc::Rc;

use dioxus_core::{AttributeValue, ElementId, Template, TemplateAttribute, TemplateNode, WriteMutations};
use rustc_hash::FxHashMap;

use crate::bindings::polymorph::dioxus::mutations as m;
use crate::protocol::Interner;

/// Encodes dioxus mutations as `mutations::Operation` values.
///
/// The interner is shared (`Rc<RefCell<_>>`) with the event-dispatch path,
/// which needs the reverse `u16 -> &'static str` lookup to turn a
/// `handle-event` name id back into a dioxus event name — exactly as
/// [`crate::writer::MutationWriter`] does.
pub struct TypedWriter {
    /// The batch being filled. The driver drains it with `std::mem::take`
    /// once per flush and writes the whole `Vec` in one `write_all`. The
    /// operations are moved into the write, but the `Vec` itself comes back
    /// from `write_all` emptied with its capacity intact, and the driver
    /// hands that capacity back here — so a steady-state batch reuses one
    /// allocation, exactly as the byte channel reuses its frame scratch
    /// buffer. See `driver::flush_typed`.
    pub batch: Vec<m::Operation>,
    interner: Rc<RefCell<Interner>>,
    /// Guest-assigned template ids, keyed exactly as
    /// [`crate::writer::MutationWriter`]'s are: the pointer identity of
    /// `template`'s `roots`/`node_paths`/`attr_paths` slices. See that
    /// field's doc for the tradeoff (duplicate registration of structurally
    /// identical templates in unmerged-statics builds).
    templates: FxHashMap<(usize, usize, usize), u16>,
}

impl TypedWriter {
    /// Create a writer sharing `interner` with the event-dispatch path.
    pub fn new(interner: Rc<RefCell<Interner>>) -> Self {
        TypedWriter { batch: Vec::new(), interner, templates: FxHashMap::default() }
    }

    /// Intern `s`, pushing `Operation::CacheString` on first sight of this
    /// pointer identity — the same points at which `MutationWriter` emits
    /// the byte format's `cache-string` op.
    fn intern(&mut self, s: &'static str) -> u16 {
        let (id, is_new) = self.interner.borrow_mut().intern_raw(s);
        if is_new {
            self.batch.push(m::Operation::CacheString(m::CacheString { id, str: s.to_string() }));
        }
        id
    }

    fn intern_opt(&mut self, s: Option<&'static str>) -> Option<u16> {
        s.map(|s| self.intern(s))
    }

    /// Pass 1 of template registration: intern every `&'static str` the
    /// template references, so all their `CacheString` operations precede
    /// the `RegisterTemplate` that references their ids.
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

    /// Pass 2: append `node` and its subtree to `nodes` in pre-order,
    /// returning `node`'s own index.
    ///
    /// The node is reserved in `nodes` *before* its children are walked (a
    /// `Dynamic` placeholder stands in), so that the parent's index is fixed
    /// while the children — which occupy later slots — are appended. The
    /// reserved slot is then overwritten with the real element carrying the
    /// child indices just collected. Must run after
    /// [`Self::intern_template_node`].
    fn flatten_template_node(
        &mut self,
        node: &'static TemplateNode,
        nodes: &mut Vec<m::TemplateNode>,
    ) -> u32 {
        match node {
            TemplateNode::Element { tag, namespace, attrs, children } => {
                let tag_id = self.intern(tag);
                let ns_id = self.intern_opt(*namespace);
                // Dynamic template attributes are realized later through
                // `set_attribute`; only static ones are part of the template.
                let mut wit_attrs = Vec::new();
                for attr in *attrs {
                    if let TemplateAttribute::Static { name, value, namespace } = attr {
                        let name_id = self.intern(name);
                        let ns_id = self.intern_opt(*namespace);
                        wit_attrs.push(m::TemplateAttr {
                            name: name_id,
                            ns: ns_id,
                            value: value.to_string(),
                        });
                    }
                }
                let index = nodes.len() as u32;
                nodes.push(m::TemplateNode::Dynamic); // reserved; overwritten below
                let child_indices = children
                    .iter()
                    .map(|child| self.flatten_template_node(child, nodes))
                    .collect();
                nodes[index as usize] = m::TemplateNode::Element(m::TemplateElement {
                    tag: tag_id,
                    ns: ns_id,
                    attrs: wit_attrs,
                    children: child_indices,
                });
                index
            }
            TemplateNode::Text { text } => {
                let index = nodes.len() as u32;
                nodes.push(m::TemplateNode::Text(text.to_string()));
                index
            }
            // A runtime-supplied node slot; the host materializes a
            // placeholder that later ops (assign-id / replace-placeholder)
            // address by path.
            TemplateNode::Dynamic { .. } => {
                let index = nodes.len() as u32;
                nodes.push(m::TemplateNode::Dynamic);
                index
            }
        }
    }

    /// Return the id for `template`, registering it on first encounter.
    ///
    /// Panics if more than `u16::MAX` distinct templates are registered
    /// (mirrors `MutationWriter::template_id` and [`Interner::intern_raw`]'s
    /// id-space guard).
    fn template_id(&mut self, template: Template) -> u16 {
        let key = (
            template.roots.as_ptr() as usize,
            template.node_paths.as_ptr() as usize,
            template.attr_paths.as_ptr() as usize,
        );
        if let Some(&id) = self.templates.get(&key) {
            return id;
        }
        let next = self.templates.len();
        assert!(
            next < u16::MAX as usize,
            "typed: registered more than {} distinct templates; template id \
             space (u16) exhausted",
            u16::MAX
        );
        let id = next as u16;
        self.templates.insert(key, id);

        // Pass 1 first, so every CacheString precedes the RegisterTemplate
        // referencing its id (see the module doc).
        for root in template.roots.iter() {
            self.intern_template_node(root);
        }
        let mut nodes = Vec::new();
        let roots = template
            .roots
            .iter()
            .map(|root| self.flatten_template_node(root, &mut nodes))
            .collect();
        self.batch.push(m::Operation::RegisterTemplate(m::RegisterTemplate { id, nodes, roots }));
        id
    }
}

impl WriteMutations for TypedWriter {
    fn append_children(&mut self, id: ElementId, m: usize) {
        self.batch.push(m::Operation::AppendChildren(m::StackOp { id: id.0 as u32, m: m as u32 }));
    }

    fn assign_node_id(&mut self, path: &'static [u8], id: ElementId) {
        self.batch
            .push(m::Operation::AssignId(m::AssignId { path: path.to_vec(), id: id.0 as u32 }));
    }

    fn create_placeholder(&mut self, id: ElementId) {
        self.batch.push(m::Operation::CreatePlaceholder(id.0 as u32));
    }

    fn create_text_node(&mut self, value: &str, id: ElementId) {
        self.batch.push(m::Operation::CreateTextNode(m::CreateTextNode {
            id: id.0 as u32,
            text: value.to_string(),
        }));
    }

    fn load_template(&mut self, template: Template, index: usize, id: ElementId) {
        let tmpl = self.template_id(template);
        self.batch.push(m::Operation::LoadTemplate(m::LoadTemplate {
            id: id.0 as u32,
            tmpl,
            root: index as u16,
        }));
    }

    fn replace_node_with(&mut self, id: ElementId, m: usize) {
        self.batch.push(m::Operation::ReplaceWith(m::StackOp { id: id.0 as u32, m: m as u32 }));
    }

    fn replace_placeholder_with_nodes(&mut self, path: &'static [u8], m: usize) {
        self.batch
            .push(m::Operation::ReplacePlaceholder(m::PathOp { path: path.to_vec(), m: m as u32 }));
    }

    fn insert_nodes_after(&mut self, id: ElementId, m: usize) {
        self.batch.push(m::Operation::InsertAfter(m::StackOp { id: id.0 as u32, m: m as u32 }));
    }

    fn insert_nodes_before(&mut self, id: ElementId, m: usize) {
        self.batch.push(m::Operation::InsertBefore(m::StackOp { id: id.0 as u32, m: m as u32 }));
    }

    fn set_attribute(
        &mut self,
        name: &'static str,
        ns: Option<&'static str>,
        value: &AttributeValue,
        id: ElementId,
    ) {
        // Intern first: the CacheStrings must precede the SetAttribute that
        // names their ids.
        let name_id = self.intern(name);
        let ns_id = self.intern_opt(ns);
        let value = match value {
            AttributeValue::Text(s) => m::AttrValue::Text(s.clone()),
            AttributeValue::Float(f) => m::AttrValue::Float(*f),
            AttributeValue::Int(n) => m::AttrValue::Int(*n),
            AttributeValue::Bool(b) => m::AttrValue::Boolean(*b),
            AttributeValue::None => m::AttrValue::None,
            // Listener: reaches the renderer through `create_event_listener`
            // instead (dioxus never asks a renderer to serialize a callback).
            // Any: a renderer-opaque payload for custom (non-HTML)
            // renderers; there is nothing to put on the wire. Same as
            // `MutationWriter` — no operation at all.
            AttributeValue::Listener(_) | AttributeValue::Any(_) => return,
        };
        self.batch.push(m::Operation::SetAttribute(m::SetAttribute {
            id: id.0 as u32,
            name: name_id,
            ns: ns_id,
            value,
        }));
    }

    fn set_node_text(&mut self, value: &str, id: ElementId) {
        self.batch
            .push(m::Operation::SetText(m::SetText { id: id.0 as u32, text: value.to_string() }));
    }

    fn create_event_listener(&mut self, name: &'static str, id: ElementId) {
        let name_id = self.intern(name);
        self.batch.push(m::Operation::NewEventListener(m::EventListener {
            id: id.0 as u32,
            name: name_id,
            bubbles: dioxus_core_types::event_bubbles(name),
        }));
    }

    fn remove_event_listener(&mut self, name: &'static str, id: ElementId) {
        let name_id = self.intern(name);
        self.batch.push(m::Operation::RemoveEventListener(m::EventListener {
            id: id.0 as u32,
            name: name_id,
            bubbles: dioxus_core_types::event_bubbles(name),
        }));
    }

    fn remove_node(&mut self, id: ElementId) {
        self.batch.push(m::Operation::Remove(id.0 as u32));
    }

    fn push_root(&mut self, id: ElementId) {
        self.batch.push(m::Operation::PushRoot(id.0 as u32));
    }
}
