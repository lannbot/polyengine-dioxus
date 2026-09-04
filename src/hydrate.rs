//! The hydration id walk: the payload of the `hydrate` operation.
//!
//! In `render-mode.hydrate` the mount root already holds this component's
//! markup, written by `dioxus-ssr`'s `pre_render`. The guest still runs the
//! initial render — that is what makes dioxus-core assign ElementIds and
//! build its mount table — but emits no node-creating operations. What the
//! host needs instead is the binding: which already-present DOM node is
//! which ElementId. [`hydration_ids`] produces exactly that, as
//! `ids[n] = the ElementId for the server's hydration marker n`.
//!
//! # Why the correspondence is positional, not structural
//!
//! Neither side matches HTML against the vdom. `pre_render` writes a marker
//! wherever its own template walk reaches a node the client will need to
//! address, numbering them with a single monotonic counter
//! (`dynamic_node_id`, bumped at `DynamicNode::Text`,
//! `DynamicNode::Placeholder`, `Segment::AttributeNodeMarker` and
//! `Segment::RootNodeMarker` — dioxus-ssr-0.7.9 src/renderer.rs:190,216,268,282,
//! respectively).
//! This module walks the *same* templates in the *same* order and pushes an
//! id at exactly those four sites. So marker `n` and `ids[n]` are the `n`th
//! stop of one walk described twice, and the host can bind them by counting
//! rather than by comparing trees.
//!
//! That makes the mode's precondition sharp: the served HTML must come from
//! this component at this initial state. A structural disagreement does not
//! degrade into a partial match — it shifts the numbering, and the host
//! reports the count/marker mismatch rather than binding wrong nodes (see
//! the `hydrate` doc in `wit/world.wit`).
//!
//! # Where the walk comes from
//!
//! Ported from dioxus-web-0.7.10 src/hydration/hydrate.rs:244-372
//! (`rehydrate_scope` / `rehydrate_vnode` / `rehydrate_template_node` /
//! `rehydrate_dynamic_node`), minus its suspense bookkeeping (out of scope
//! here) and minus its `to_mount` vector: dioxus-web has to rediscover
//! `onmounted` elements during the walk because its hydration path also
//! suppresses `create_event_listener`. We do not — listener registrations
//! flow as ordinary `new-event-listener` operations, `mounted` included, so
//! there is nothing for a `to_mount` list to do. See the suppression comment
//! in [`crate::writer`].
//!
//! This module depends only on `dioxus-core`, so it is not `wasm32`-gated
//! and `cargo test` exercises the walk natively against `dioxus_ssr` — which
//! is the only place the two orders can be checked against each other.

use dioxus_core::{
    DynamicNode, ElementId, ScopeState, TemplateAttribute, TemplateNode, VNode,
    VirtualDom,
};

/// The walk reached a node the VirtualDom has not mounted.
///
/// `mounted_root` / `mounted_dynamic_node` / `mounted_dynamic_attribute` /
/// `mounted_scope` all return `Option`, being `None` for a vnode whose mount
/// entry does not exist yet. After the initial `rebuild` every node the walk
/// visits has one, so this is unreachable in the driver's usage — but it is
/// a real `Option` in the API and silently pushing a wrong id would corrupt
/// the positional correspondence, so it is an error, not an `unwrap`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VNodeNotInitialized;

impl std::fmt::Display for VNodeNotInitialized {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("hydration walk reached a vnode with no mount entry")
    }
}

impl std::error::Error for VNodeNotInitialized {}

/// Collect the ElementIds of `dom`'s rendered tree in `pre_render`'s marker
/// order. `dom` must already have been rebuilt.
pub fn hydration_ids(dom: &VirtualDom) -> Result<Vec<u32>, VNodeNotInitialized> {
    let mut ids = Vec::new();
    scope(dom, dom.base_scope(), &mut ids)?;
    Ok(ids)
}

fn scope(
    dom: &VirtualDom,
    scope: &ScopeState,
    ids: &mut Vec<u32>,
) -> Result<(), VNodeNotInitialized> {
    vnode(dom, scope.root_node(), ids)
}

fn vnode(dom: &VirtualDom, node: &VNode, ids: &mut Vec<u32>) -> Result<(), VNodeNotInitialized> {
    for (i, root) in node.template.roots.iter().enumerate() {
        // Only roots carry a mounted id into `template_node`: a nested
        // static node is addressable through its root and the server writes
        // no marker for it.
        let root_id = node.mounted_root(i, dom).ok_or(VNodeNotInitialized)?;
        template_node(dom, node, root, Some(root_id), ids)?;
    }
    Ok(())
}

fn template_node(
    dom: &VirtualDom,
    vn: &VNode,
    node: &TemplateNode,
    root_id: Option<ElementId>,
    ids: &mut Vec<u32>,
) -> Result<(), VNodeNotInitialized> {
    match node {
        TemplateNode::Element { children, attrs, .. } => {
            // The server writes `data-node-hydration` on an element that is
            // either a template root or carries dynamic attributes, and
            // exactly once either way (dioxus-ssr-0.7.9 src/cache.rs:261-273
            // — `has_dyn_attrs || is_root`, with the attribute marker
            // winning). Hence one `Option` narrowed by both conditions
            // rather than two pushes.
            let mut mounted_id = root_id;
            for attr in *attrs {
                if let TemplateAttribute::Dynamic { id } = attr {
                    let attr_id =
                        vn.mounted_dynamic_attribute(*id, dom).ok_or(VNodeNotInitialized)?;
                    // Claimed even when the attribute list is empty: an
                    // empty spread still needs the element mounted so a
                    // later render can fill it (dioxus-web hydrate.rs:301-305).
                    mounted_id = Some(attr_id);
                    // Upstream harvests `onmounted` listeners here into
                    // `to_mount`; we do not — see the module doc.
                }
            }
            if let Some(id) = mounted_id {
                ids.push(id.0 as u32);
            }
            for child in *children {
                template_node(dom, vn, child, None, ids)?;
            }
        }
        TemplateNode::Dynamic { id } => dynamic_node(dom, vn, &vn.dynamic_nodes[*id], *id, ids)?,
        // A root text node gets `<!--node-idN-->` so the client can find it
        // again after adjacent text nodes merge (dioxus-ssr src/cache.rs:299-306);
        // a nested one gets nothing, and arrives here with `root_id` None.
        TemplateNode::Text { .. } => {
            if let Some(id) = root_id {
                ids.push(id.0 as u32);
            }
        }
    }
    Ok(())
}

fn dynamic_node(
    dom: &VirtualDom,
    vn: &VNode,
    node: &DynamicNode,
    index: usize,
    ids: &mut Vec<u32>,
) -> Result<(), VNodeNotInitialized> {
    match node {
        // `<!--node-idN-->text<!--#-->` and `<!--placeholderN-->`: one
        // marker each, and the same counter.
        DynamicNode::Text(_) | DynamicNode::Placeholder(_) => {
            let id = vn.mounted_dynamic_node(index, dom).ok_or(VNodeNotInitialized)?;
            ids.push(id.0 as u32);
        }
        // The server renders a component inline at this point in the byte
        // stream, so the walk must descend here rather than after the
        // parent template.
        DynamicNode::Component(comp) => {
            let child = comp.mounted_scope(index, vn, dom).ok_or(VNodeNotInitialized)?;
            scope(dom, child, ids)?;
        }
        DynamicNode::Fragment(nodes) => {
            for child in nodes {
                vnode(dom, child, ids)?;
            }
        }
    }
    Ok(())
}
