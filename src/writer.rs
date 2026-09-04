//! [`MutationWriter`]: the mutation channel's `dioxus_core::WriteMutations`
//! sink, pushing `mutations::Operation` values into the batch the driver
//! flushes.
//!
//! The mapping mirrors dioxus's own `WriteMutations`→channel renderer
//! (dioxus-interpreter-js `write_native_mutations.rs`): templates are
//! registered on first encounter and thereafter referenced by a
//! guest-assigned `u16`, and listener ops carry `event_bubbles(name)`
//! because the host delegates bubbling events at the mount root. The schema
//! it writes against is the `mutations` interface in `wit/world.wit`. (This
//! module names the generated bindings, so it is `wasm32`-only and
//! `cargo test` never builds it.)
//!
//! # Interning invariant
//!
//! The host resolves a `str-ref` against `cache-string` definitions it has
//! already seen, so every `CacheString` must precede the operation
//! referencing its id in the batch. Hence the two-pass template walk
//! (`intern_template_node` then `flatten_template_node`) and the
//! intern-then-build order in `set_attribute` and the listener ops.
//!
//! # Why template registration flattens
//!
//! WIT forbids recursive type definitions, so `register-template` carries an
//! arena (`nodes`, plus `u32` indices in `roots` and each element's
//! `children`) rather than a tree. See the `mutations` interface doc in
//! `wit/world.wit`.

use std::cell::RefCell;
use std::rc::Rc;

use dioxus_core::{AttributeValue, ElementId, Template, TemplateAttribute, TemplateNode, WriteMutations};
use rustc_hash::FxHashMap;

use crate::bindings::polymorph::dioxus::mutations as m;
use crate::interner::Interner;

/// Encodes dioxus mutations as `mutations::Operation` values.
///
/// The interner is shared (`Rc<RefCell<_>>`) with the event-dispatch path,
/// which needs the reverse `u16 -> &'static str` lookup to turn a
/// `handle-event` name id back into a dioxus event name.
pub struct MutationWriter {
    /// The batch being filled. The driver drains it with `std::mem::take`
    /// once per flush and writes the whole `Vec` in one `write_all`. The
    /// operations are moved into the write, but the `Vec` itself comes back
    /// from `write_all` emptied with its capacity intact, and the driver
    /// hands that capacity back here — so a steady-state batch reuses one
    /// allocation. See `driver::flush`.
    pub batch: Vec<m::Operation>,
    /// While set, node-creating operations are dropped instead of encoded;
    /// see [`MutationWriter::suppress_nodes`].
    suppressed: bool,
    interner: Rc<RefCell<Interner>>,
    /// Guest-assigned template ids, keyed by the pointer identity of
    /// `template`'s `roots`/`node_paths`/`attr_paths` slices — mirroring
    /// upstream `Template`'s own pointer-mode `Hash`/`PartialEq`
    /// (dioxus-core-0.7.10 src/nodes.rs:312-341) unconditionally, rather
    /// than only when the build merges identical statics. This makes
    /// `template_id` O(1) in all build modes; in unmerged-statics builds
    /// (e.g. debug/dev), two structurally identical templates from distinct
    /// `rsx!` sites register twice instead of once — a harmless duplicate
    /// registration, the same tradeoff [`Interner`]'s pointer-identity doc
    /// records for strings.
    templates: FxHashMap<(usize, usize, usize), u16>,
}

impl MutationWriter {
    /// Create a writer sharing `interner` with the event-dispatch path.
    pub fn new(interner: Rc<RefCell<Interner>>) -> Self {
        MutationWriter {
            batch: Vec::new(),
            suppressed: false,
            interner,
            templates: FxHashMap::default(),
        }
    }

    /// Drop node-creating operations rather than encoding them, for the
    /// initial render of `render-mode.hydrate`: the nodes already exist in
    /// the document, and the host binds them by id through the `hydrate`
    /// operation instead. The rebuild still runs through this writer, so
    /// dioxus-core assigns ElementIds and fills its mount table exactly as
    /// in `fresh` — that assignment is the entire point of the pass, and is
    /// what dioxus-web's own note distinguishes from running with no
    /// mutation writer at all (dioxus-web-0.7.10 src/dom.rs:45-47).
    ///
    /// The suppressed methods return before interning or template
    /// registration, so a suppressed rebuild also emits no `cache-string`
    /// and no `register-template` — except the name interning the listener
    /// ops below do for themselves.
    ///
    /// DELIBERATE DIVERGENCE FROM dioxus-web, which suppresses
    /// `create_event_listener` too and rebuilds listeners by parsing the
    /// `,click:1` suffix of `data-node-hydration`
    /// (dioxus-web-0.7.10 src/hydration/hydrate.rs, `write_comma_separated`).
    /// Here listener ops flow normally and the host ignores that suffix,
    /// because: our `new-event-listener` carries an *interned* name id,
    /// which the marker cannot supply; the host's synthetic `mounted` event
    /// and its observer-backed `resize`/`visible` families are driven by
    /// listener registration and are not expressible in the marker format
    /// at all; and `data-dioxus-id` tagging already happens host-side in
    /// `EventDispatcher.add`. Consequently there is no `to_mount` vector
    /// and no special `onmounted` path — see [`crate::hydrate`].
    ///
    /// Suppression covers the initial rebuild only; the driver clears it
    /// before the first flush, and every later render is byte-identical to
    /// `fresh` mode.
    pub fn suppress_nodes(&mut self, suppressed: bool) {
        self.suppressed = suppressed;
    }

    /// Intern `s`, pushing `Operation::CacheString` on first sight of this
    /// pointer identity.
    fn intern(&mut self, s: &'static str) -> u16 {
        let (id, is_new) = self.interner.borrow_mut().intern(s);
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
    /// (mirrors [`Interner::intern`]'s id-space guard).
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
            "writer: registered more than {} distinct templates; template id \
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

impl WriteMutations for MutationWriter {
    fn append_children(&mut self, id: ElementId, m: usize) {
        if self.suppressed {
            return;
        }

        self.batch.push(m::Operation::AppendChildren(m::StackOp { id: id.0 as u32, m: m as u32 }));
    }

    fn assign_node_id(&mut self, path: &'static [u8], id: ElementId) {
        if self.suppressed {
            return;
        }

        self.batch
            .push(m::Operation::AssignId(m::AssignId { path: path.to_vec(), id: id.0 as u32 }));
    }

    fn create_placeholder(&mut self, id: ElementId) {
        if self.suppressed {
            return;
        }

        self.batch.push(m::Operation::CreatePlaceholder(id.0 as u32));
    }

    fn create_text_node(&mut self, value: &str, id: ElementId) {
        if self.suppressed {
            return;
        }

        self.batch.push(m::Operation::CreateTextNode(m::CreateTextNode {
            id: id.0 as u32,
            text: value.to_string(),
        }));
    }

    fn load_template(&mut self, template: Template, index: usize, id: ElementId) {
        if self.suppressed {
            return;
        }

        let tmpl = self.template_id(template);
        self.batch.push(m::Operation::LoadTemplate(m::LoadTemplate {
            id: id.0 as u32,
            tmpl,
            root: index as u16,
        }));
    }

    fn replace_node_with(&mut self, id: ElementId, m: usize) {
        if self.suppressed {
            return;
        }

        self.batch.push(m::Operation::ReplaceWith(m::StackOp { id: id.0 as u32, m: m as u32 }));
    }

    fn replace_placeholder_with_nodes(&mut self, path: &'static [u8], m: usize) {
        if self.suppressed {
            return;
        }

        self.batch
            .push(m::Operation::ReplacePlaceholder(m::PathOp { path: path.to_vec(), m: m as u32 }));
    }

    fn insert_nodes_after(&mut self, id: ElementId, m: usize) {
        if self.suppressed {
            return;
        }

        self.batch.push(m::Operation::InsertAfter(m::StackOp { id: id.0 as u32, m: m as u32 }));
    }

    fn insert_nodes_before(&mut self, id: ElementId, m: usize) {
        if self.suppressed {
            return;
        }

        self.batch.push(m::Operation::InsertBefore(m::StackOp { id: id.0 as u32, m: m as u32 }));
    }

    fn set_attribute(
        &mut self,
        name: &'static str,
        ns: Option<&'static str>,
        value: &AttributeValue,
        id: ElementId,
    ) {
        if self.suppressed {
            return;
        }
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
            // renderers; there is nothing to put on the wire. dioxus's own
            // channel renderer treats both as unreachable/ignored.
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
        if self.suppressed {
            return;
        }

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
        if self.suppressed {
            return;
        }

        self.batch.push(m::Operation::Remove(id.0 as u32));
    }

    fn push_root(&mut self, id: ElementId) {
        if self.suppressed {
            return;
        }

        self.batch.push(m::Operation::PushRoot(id.0 as u32));
    }
}
