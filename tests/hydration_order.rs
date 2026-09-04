//! The hydration walk agrees with `dioxus-ssr` `pre_render`'s marker
//! numbering.
//!
//! This is the only place the two orders can meet: `pre_render` numbers its
//! markers with one monotonic counter as it writes the HTML, and
//! `polyengine_dioxus::hydrate` walks the same templates pushing an
//! ElementId at the same four sites. The host binds `ids[n]` to marker `n`
//! by counting, so a porting slip in the walk shows up as a count mismatch
//! here — and as silently wrong nodes in production if it does not.
//!
//! The corpus is dioxus-ssr-0.7.9 tests/hydration.rs, whose apps between
//! them cover template roots, elements with dynamic attributes, listeners,
//! dynamic text, placeholders, child components, fragments, and (app4) a
//! tree that is two dynamic texts with no element marker at all.
//!
//! Positional correctness *within* a matching count is a DOM property and
//! belongs to the host-side test; there is no DOM here and nothing is
//! asserted about which node an id names.

use dioxus::prelude::*;
use dioxus_core::{
    AttributeValue, ElementId, Template, WriteMutations,
};
use polyengine_dioxus::hydrate::hydration_ids;

/// A `WriteMutations` that encodes nothing.
///
/// The production suppressed path runs through `MutationWriter` with
/// `suppress_nodes(true)`, but that module names the generated WIT bindings
/// and so is `wasm32`-only; this sink stands in for it natively. What
/// matters for the walk is the property both share and that
/// `rebuild`-with-no-writer would not: dioxus-core still assigns ElementIds
/// and fills its mount table (dioxus-web-0.7.10 src/dom.rs:45-47).
struct Discard;

impl WriteMutations for Discard {
    fn append_children(&mut self, _: ElementId, _: usize) {}
    fn assign_node_id(&mut self, _: &'static [u8], _: ElementId) {}
    fn create_placeholder(&mut self, _: ElementId) {}
    fn create_text_node(&mut self, _: &str, _: ElementId) {}
    fn load_template(&mut self, _: Template, _: usize, _: ElementId) {}
    fn replace_node_with(&mut self, _: ElementId, _: usize) {}
    fn replace_placeholder_with_nodes(&mut self, _: &'static [u8], _: usize) {}
    fn insert_nodes_after(&mut self, _: ElementId, _: usize) {}
    fn insert_nodes_before(&mut self, _: ElementId, _: usize) {}
    fn set_attribute(
        &mut self,
        _: &'static str,
        _: Option<&'static str>,
        _: &AttributeValue,
        _: ElementId,
    ) {
    }
    fn set_node_text(&mut self, _: &str, _: ElementId) {}
    fn create_event_listener(&mut self, _: &'static str, _: ElementId) {}
    fn remove_event_listener(&mut self, _: &'static str, _: ElementId) {}
    fn remove_node(&mut self, _: ElementId) {}
    fn push_root(&mut self, _: ElementId) {}
}

/// The marker numbers `pre_render` wrote, in document order.
///
/// Three forms, one counter: `data-node-hydration="N` on an element (the
/// `,click:1` listener suffix is not our business — see the module doc of
/// `polyengine_dioxus::writer`), `<!--node-idN-->` opening a dynamic or
/// root text node, and `<!--placeholderN-->`.
fn markers(html: &str) -> Vec<usize> {
    let mut found: Vec<(usize, usize)> = Vec::new();
    for prefix in [r#"data-node-hydration=""#, "<!--node-id", "<!--placeholder"] {
        for (at, _) in html.match_indices(prefix) {
            let rest = &html[at + prefix.len()..];
            let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
            assert!(!digits.is_empty(), "marker at {at} has no number: {rest:.40}");
            found.push((at, digits.parse().unwrap()));
        }
    }
    found.sort_unstable();
    found.into_iter().map(|(_, n)| n).collect()
}

/// Rebuild `app` suppressed, then check the walk against the markers
/// `pre_render` writes for the same dom.
#[track_caller]
fn check(name: &str, app: fn() -> Element) {
    let mut dom = VirtualDom::new(app);
    dom.rebuild(&mut Discard);

    let html = dioxus_ssr::pre_render(&dom);
    let seq = markers(&html);
    // If this fails the scanner is wrong, not dioxus: `pre_render` numbers
    // with a single counter bumped in write order.
    assert_eq!(
        seq,
        (0..seq.len()).collect::<Vec<_>>(),
        "{name}: marker numbers are not 0..N in document order; html = {html}"
    );

    let ids = hydration_ids(&dom).expect("walk on a rebuilt dom");
    assert_eq!(ids.len(), seq.len(), "{name}: walk yielded {ids:?} for html = {html}");

    let mut sorted = ids.clone();
    sorted.sort_unstable();
    sorted.dedup();
    assert_eq!(sorted.len(), ids.len(), "{name}: duplicate ElementId in {ids:?}");
}

#[test]
fn root_ids() {
    fn app() -> Element {
        rsx! { div { width: "100px" } }
    }
    check("root_ids", app);
}

#[test]
fn dynamic_attributes() {
    fn app() -> Element {
        let dynamic = 123;
        rsx! { div { width: "100px", div { width: "{dynamic}px" } } }
    }
    check("dynamic_attributes", app);
}

#[test]
fn listeners() {
    fn app() -> Element {
        rsx! { div { width: "100px", div { onclick: |_| {} } } }
    }
    check("listeners", app);

    fn app2() -> Element {
        let dynamic = 123;
        rsx! { div { width: "100px", div { width: "{dynamic}px", onclick: |_| {} } } }
    }
    check("listeners/app2", app2);
}

#[test]
fn text_nodes() {
    fn app() -> Element {
        let dynamic_text = "hello";
        rsx! { div { {dynamic_text} } }
    }
    check("text_nodes", app);

    fn app2() -> Element {
        let dynamic = 123;
        rsx! { div { "{dynamic}" "{1234}" } }
    }
    check("text_nodes/app2", app2);
}

#[allow(non_snake_case)]
#[test]
fn components_hydrate() {
    fn Child() -> Element {
        rsx! { div { "hello" } }
    }
    fn app() -> Element {
        rsx! { Child {} }
    }
    check("components_hydrate/app1", app);

    fn Child2() -> Element {
        let dyn_text = "hello";
        rsx! { div { {dyn_text} } }
    }
    fn app2() -> Element {
        rsx! { Child2 {} }
    }
    check("components_hydrate/app2", app2);

    fn Child3() -> Element {
        rsx! { div { width: "{1}" } }
    }
    fn app3() -> Element {
        rsx! { Child3 {} }
    }
    check("components_hydrate/app3", app3);

    // The whole tree is two dynamic texts inside a fragment: no element
    // marker at all, so an element-centric walk would come back empty.
    fn Child4() -> Element {
        rsx! {
            for _ in 0..2 {
                {rsx! { "{1}" }}
            }
        }
    }
    fn app4() -> Element {
        rsx! { Child4 {} }
    }
    check("components_hydrate/app4", app4);
}

#[test]
fn hello_world_hydrates() {
    fn app() -> Element {
        let mut count = use_signal(|| 0);
        rsx! {
            h1 { "High-Five counter: {count}" }
            button { onclick: move |_| count += 1, "Up high!" }
            button { onclick: move |_| count -= 1, "Down low!" }
        }
    }
    check("hello_world_hydrates", app);
}

/// Not in the upstream corpus, which never renders a `DynamicNode::Placeholder`
/// — so without this the `<!--placeholderN-->` arm of the walk is unexercised
/// (verified: deleting that arm leaves every other case green).
#[test]
fn empty_body_is_a_placeholder() {
    fn app() -> Element {
        rsx! {
            div {
                for _ in 0..0 {
                    div {}
                }
            }
        }
    }
    check("empty_body_is_a_placeholder", app);
}
