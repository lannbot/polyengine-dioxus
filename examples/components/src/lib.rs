//! Component gallery for `dioxus_components` (crates.io "dioxus_components"
//! v0.1.2), running as a polyengine-dioxus component instead of the native
//! dioxus-web renderer the library's own examples assume. Constraints
//! required to make that swap work, in the style of examples/todomvc's
//! header:
//!
//!   1. `dioxus_components = { default-features = false }` in Cargo.toml —
//!      the default `web` feature pulls in the whole dioxus-web renderer,
//!      which this pipeline's plain `cargo build` -> Wasm Component flow
//!      neither needs nor supports.
//!   2. That in turn needs a `web-sys` shim dependency (see Cargo.toml's
//!      comment) purely so the crate's (unused-here) `dialog` module
//!      type-checks; those JS-boundary calls are dead code from this
//!      example's point of view; on wasm32-wasip2 wasm-bindgen emits no
//!      imports at all, so they only need to typecheck.
//!   3. **The UPSTREAM Dialog, Portal, and Tooltip are never used below.**
//!      All three cross the JS boundary at runtime (scroll lock / focus
//!      trap / reparenting / `setTimeout` delays), which traps once
//!      the guest is built for wasm32-wasip2, where wasm-bindgen compiles to
//!      off-target stubs that abort on call — this renderer
//!      has no JS boundary left at instantiation time. JS-free replacements
//!      for Dialog and Tooltip live in `jsfree.rs` (which also explains why
//!      Portal needs no replacement); the gallery uses those. Everything
//!      else shown here (Button, Checkbox, Accordion, Badge, Card, Avatar,
//!      Spinner, Empty) is the upstream component, plain DOM + Rust-side
//!      state, no JS calls.
//!
//! Structural ids referenced by the e2e harness (see the dispatch): the root
//! `#showcase`, `#demo-button` / `#click-count`, `#checkbox-state`,
//! `#demo-accordion`, `#demo-tooltip-trigger` / `#demo-tooltip`,
//! `#demo-dialog-open` / `#demo-dialog` / `#demo-dialog-close`, and the
//! MountedData section's `#demo-scrollbox` / `#demo-measure` /
//! `#demo-scroll` with its readouts `#rect-width` / `#rect-height` /
//! `#scroll-height` / `#scroll-top`, plus `#demo-scroll-into-view` /
//! `#scroll-to-status` / `#demo-scroll-target`; and the observer sections'
//! `#demo-resize-box` / `#demo-resize-toggle` with its readouts
//! `#resize-width` / `#resize-height`, and `#demo-visible-target` with its
//! readouts `#visible-intersecting` / `#visible-ratio`.

mod jsfree;

use dioxus::html::geometry::PixelsVector2D;
use dioxus::prelude::*;
use dioxus_components::{
    Accordion, AccordionContent, AccordionItem, AccordionTrigger, AccordionType, Avatar,
    AvatarFallback, Badge, BadgeVariant, Button, ButtonVariant, Card, CardContent, CardFooter,
    CardHeader, CardTitle, CheckboxIndicator, CheckboxProvider, CheckboxTrigger, CheckedState,
    Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle, Spinner, SpinnerSize,
};
use std::rc::Rc;

/// Sentinel for "no measurement taken yet", so the e2e lane can tell an
/// unmeasured field from a genuine zero (`#scroll-top` legitimately reads 0
/// before the box is scrolled).
const UNMEASURED: i64 = -1;
/// Sentinel for "the `MountedResult` came back `Err`". Rendered instead of
/// leaving a stale value, so a failed query is visible in the UI and fails
/// the test rather than passing quietly on the previous reading.
const QUERY_FAILED: i64 = -2;

fn app() -> Element {
    let mut count = use_signal(|| 0i32);
    let mut checkbox_state = use_signal(|| CheckedState::Unchecked);
    let mut dialog_open = use_signal(|| false);

    // MountedData section state: the handle for #demo-scrollbox, captured at
    // onmounted, plus one signal per rendered measurement.
    let mut scrollbox: Signal<Option<Rc<MountedData>>> = use_signal(|| None);
    let mut rect_width = use_signal(|| UNMEASURED);
    let mut rect_height = use_signal(|| UNMEASURED);
    let mut scroll_height = use_signal(|| UNMEASURED);
    let mut scroll_top = use_signal(|| UNMEASURED);
    let mut scroll_target: Signal<Option<Rc<MountedData>>> = use_signal(|| None);
    let mut scroll_to_status = use_signal(|| "scroll-to-idle");

    // Observer section state. `resize_wide` drives the observed element's
    // inline width; the two readouts hold whatever the last ResizeObserver
    // delivery reported.
    let mut resize_wide = use_signal(|| false);
    let mut resize_width = use_signal(|| UNMEASURED);
    let mut resize_height = use_signal(|| UNMEASURED);
    let mut visible_intersecting = use_signal(|| "visible-unknown");
    let mut visible_ratio = use_signal(|| UNMEASURED as f64);

    // Inline `style:` rather than Tailwind width classes: harness/components.css
    // is a generated artifact, so a class that isn't already in it would not
    // exist at runtime. Reading `resize_wide()` here subscribes the component,
    // so the click re-renders with the other width and the observer fires.
    let resize_box_style = if resize_wide() {
        "background-color: #e5e5e5; width: 240px; height: 96px"
    } else {
        "background-color: #e5e5e5; width: 160px; height: 96px"
    };

    rsx! {
        div { id: "showcase", class: "p-6 flex flex-col gap-8",

            section {
                h2 { "Button" }
                div { class: "flex gap-2 items-center flex-wrap",
                    Button { variant: ButtonVariant::Default, "Default" }
                    Button { variant: ButtonVariant::Secondary, "Secondary" }
                    Button { variant: ButtonVariant::Outline, "Outline" }
                    Button { variant: ButtonVariant::Destructive, "Destructive" }
                    Button { variant: ButtonVariant::Ghost, "Ghost" }
                    Button { variant: ButtonVariant::Link, "Link" }
                    // `Button` has no `id` prop (see the crate's ButtonProps),
                    // so the id an e2e test looks up lives on a wrapping
                    // span instead of the rendered <button> itself.
                    span { id: "demo-button",
                        Button {
                            onclick: move |_| count += 1,
                            "Click me"
                        }
                    }
                    span { id: "click-count", "{count}" }
                }
            }

            section {
                h2 { "Checkbox" }
                div { class: "flex gap-2 items-center",
                    CheckboxProvider {
                        default_checked: CheckedState::Unchecked,
                        CheckboxTrigger {
                            // Upstream's `CheckboxTrigger::handle_click`
                            // (dioxus_components-0.1.2
                            // src/components/checkbox/mod.rs:224-240) toggles
                            // its own internal context signal and only
                            // *afterward* invokes this `onclick` — but never
                            // calls `CheckboxProvider::onchange` (that call is
                            // a literal `// TODO` there, never implemented).
                            // So we mirror state off `onclick` instead: it
                            // fires post-toggle, both signals start
                            // Unchecked, and both flip exactly once per
                            // click, so they stay in lockstep.
                            onclick: move |_| checkbox_state.set(checkbox_state().toggle()),
                            CheckboxIndicator {}
                        }
                    }
                    span { id: "checkbox-state", "{checkbox_state().data_state()}" }
                }
            }

            section {
                h2 { "Accordion" }
                // `Accordion` has no `id` prop either, so wrap it.
                div { id: "demo-accordion",
                    Accordion { accordion_type: AccordionType::Single { collapsible: true },
                        AccordionItem { value: "item-1",
                            AccordionTrigger { "Accordion Item One" }
                            AccordionContent { "Content for the first accordion item." }
                        }
                        AccordionItem { value: "item-2",
                            AccordionTrigger { "Accordion Item Two" }
                            AccordionContent { "Content for the second accordion item." }
                        }
                    }
                }
            }

            section {
                h2 { "Tooltip (JS-free)" }
                // See jsfree.rs: pure CSS, no state, no listeners. The
                // trigger is a real <button> so `group-focus-within` (the
                // keyboard path) has something focusable to fire on.
                jsfree::Tooltip { text: "Tooltip content", bubble_id: "demo-tooltip",
                    button {
                        id: "demo-tooltip-trigger",
                        class: "rounded-md border px-3 py-1.5 text-sm",
                        "Hover or focus me"
                    }
                }
            }

            section {
                h2 { "Dialog (JS-free)" }
                button {
                    id: "demo-dialog-open",
                    class: "rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white",
                    onclick: move |_| dialog_open.set(true),
                    "Open dialog"
                }
                jsfree::Dialog {
                    open: dialog_open,
                    title: "JS-free dialog",
                    panel_id: "demo-dialog",
                    close_id: "demo-dialog-close",
                    p { "Dialog body" }
                }
            }

            section {
                h2 { "MountedData (element queries)" }
                // Exercises the five non-focus `RenderedElementBacking`
                // methods against a real layout engine. The host-side unit
                // tests run under linkedom, which has no layout at all, so
                // "width > 0" is an assertion only a real browser can make —
                // and this is also the only coverage of the record/enum
                // conversions (rect/size/point, ScrollBehavior) across the
                // guest -> host -> guest round trip.
                div { class: "flex flex-col gap-2 items-start",
                    div {
                        id: "demo-scrollbox",
                        // Fixed height + overflow-y:auto so scroll size
                        // genuinely exceeds client size; 20 rows overflow it.
                        class: "h-24 w-64 overflow-y-auto rounded-md border p-2 text-sm",
                        onmounted: move |evt| scrollbox.set(Some(evt.data())),
                        for i in 0..20 {
                            div { key: "{i}", class: "py-0.5", "Row {i}" }
                        }
                    }
                    div { class: "flex gap-2",
                        button {
                            id: "demo-measure",
                            class: "rounded-md border px-3 py-1.5 text-sm",
                            onclick: move |_| {
                                let Some(data) = scrollbox.peek().clone() else { return };
                                spawn(async move {
                                    // Each query is awaited and reported
                                    // independently: one failing method must
                                    // not mask the others' results.
                                    match data.get_client_rect().await {
                                        Ok(rect) => {
                                            rect_width.set(rect.size.width.round() as i64);
                                            rect_height.set(rect.size.height.round() as i64);
                                        }
                                        Err(_) => {
                                            rect_width.set(QUERY_FAILED);
                                            rect_height.set(QUERY_FAILED);
                                        }
                                    }
                                    match data.get_scroll_size().await {
                                        Ok(size) => scroll_height.set(size.height.round() as i64),
                                        Err(_) => scroll_height.set(QUERY_FAILED),
                                    }
                                    match data.get_scroll_offset().await {
                                        Ok(offset) => scroll_top.set(offset.y.round() as i64),
                                        Err(_) => scroll_top.set(QUERY_FAILED),
                                    }
                                });
                            },
                            "Measure"
                        }
                        button {
                            id: "demo-scroll",
                            class: "rounded-md border px-3 py-1.5 text-sm",
                            onclick: move |_| {
                                let Some(data) = scrollbox.peek().clone() else { return };
                                spawn(async move {
                                    // `scroll` is absolute (host side maps it
                                    // to `el.scrollTo({top, left, behavior})`),
                                    // so this parks scrollTop at 120.
                                    // `Instant`, not `Smooth`: a smooth scroll
                                    // animates asynchronously and the
                                    // follow-up measurement would race it.
                                    if data
                                        .scroll(PixelsVector2D::new(0.0, 120.0), ScrollBehavior::Instant)
                                        .await
                                        .is_err()
                                    {
                                        scroll_top.set(QUERY_FAILED);
                                    }
                                });
                            },
                            "Scroll down"
                        }
                    }
                    // Bare integers only — the e2e lane parses these with
                    // Number(textContent).
                    dl { class: "grid grid-cols-2 gap-x-4 text-sm",
                        dt { "client rect width" }
                        dd { id: "rect-width", "{rect_width}" }
                        dt { "client rect height" }
                        dd { id: "rect-height", "{rect_height}" }
                        dt { "scroll height" }
                        dd { id: "scroll-height", "{scroll_height}" }
                        dt { "scroll top" }
                        dd { id: "scroll-top", "{scroll_top}" }
                    }

                    // `scroll_to` is the conversion-heaviest method on the
                    // trait: its `ScrollToOptions` carries three enums, two
                    // of them the same type in different fields. The
                    // `vertical`/`horizontal` values below are deliberately
                    // DIFFERENT (Start vs Nearest) — with matching values, a
                    // conversion that transposed or collapsed the two fields
                    // would produce identical behaviour and hide the bug.
                    button {
                        id: "demo-scroll-into-view",
                        class: "rounded-md border px-3 py-1.5 text-sm",
                        onclick: move |_| {
                            let Some(data) = scroll_target.peek().clone() else { return };
                            spawn(async move {
                                // `MountedData::scroll_to` only takes a
                                // behavior and defaults the rest; the full
                                // record (the thing worth exercising) goes
                                // through `scroll_to_with_options`.
                                let options = ScrollToOptions {
                                    // Instant, so the assertion that follows
                                    // is not racing a smooth-scroll animation.
                                    behavior: ScrollBehavior::Instant,
                                    vertical: ScrollLogicalPosition::Start,
                                    horizontal: ScrollLogicalPosition::Nearest,
                                };
                                scroll_to_status.set(match data.scroll_to_with_options(options).await {
                                    Ok(()) => "scroll-to-ok",
                                    Err(_) => "scroll-to-failed",
                                });
                            });
                        },
                        "Scroll target into view"
                    }
                    span { id: "scroll-to-status", class: "text-sm", "{scroll_to_status}" }

                    // The scroll_to target. `mt-[120vh]` pushes it at least a
                    // full viewport below the section regardless of window
                    // size, so "off-screen at load" is guaranteed rather than
                    // dependent on how tall the rest of the gallery happens
                    // to render.
                    div {
                        id: "demo-scroll-target",
                        class: "mt-[120vh] rounded-md border p-2 text-sm",
                        onmounted: move |evt| scroll_target.set(Some(evt.data())),
                        "Scroll target"
                    }
                }
            }

            section {
                h2 { "onresize (ResizeObserver)" }
                // The real-browser witness for `onresize`. Host-side unit
                // tests run under linkedom, which has no ResizeObserver at
                // all, so they synthesize entry objects by hand: they prove
                // the serializer's arithmetic and nothing about whether an
                // observer is ever created, ever observes this element, or
                // ever delivers a callback. Only a real browser can show
                // that.
                //
                // Deterministic by construction: the observed box's size is
                // set by inline `style:` in absolute pixels, never derived
                // from the viewport, so the numbers below are exact
                // constants the e2e lane can assert. Width (160 or 240) and
                // height (96) are all DIFFERENT — a writing-mode mapping
                // that transposed inline/block onto height/width would
                // report 96 for the width and fail loudly instead of
                // looking plausible.
                //
                // ResizeObserver fires once immediately on observe with the
                // element's initial size, so the readouts must leave the
                // UNMEASURED sentinel with no user interaction at all; that
                // first delivery is itself the proof the observer exists.
                div { class: "flex flex-col gap-2 items-start",
                    div {
                        id: "demo-resize-box",
                        // No border and no padding, so the border box is
                        // exactly these two numbers under Tailwind
                        // preflight's global `box-sizing: border-box`.
                        style: "{resize_box_style}",
                        onresize: move |evt| {
                            // `get_border_box_size` -> ResizeResult<PixelsSize>
                            // (dioxus-html-0.7.10 src/events/resize.rs:22-25).
                            // An Err writes the QUERY_FAILED sentinel rather
                            // than leaving the previous reading in place, so
                            // a failure is visible instead of passing quietly.
                            match evt.get_border_box_size() {
                                Ok(size) => {
                                    resize_width.set(size.width.round() as i64);
                                    resize_height.set(size.height.round() as i64);
                                }
                                Err(_) => {
                                    resize_width.set(QUERY_FAILED);
                                    resize_height.set(QUERY_FAILED);
                                }
                            }
                        },
                    }
                    button {
                        id: "demo-resize-toggle",
                        class: "rounded-md border px-3 py-1.5 text-sm",
                        onclick: move |_| resize_wide.set(!resize_wide()),
                        "Toggle width"
                    }
                    dl { class: "grid grid-cols-2 gap-x-4 text-sm",
                        dt { "observed border box width" }
                        dd { id: "resize-width", "{resize_width}" }
                        dt { "observed border box height" }
                        dd { id: "resize-height", "{resize_height}" }
                    }
                }
            }

            section {
                h2 { "onvisible (IntersectionObserver)" }
                // The real-browser witness for `onvisible`, for the same
                // reason as the section above: linkedom has no
                // IntersectionObserver, so the host-side unit tests feed the
                // serializer hand-built entries and can say nothing about
                // whether an observer is created or fires.
                //
                // IntersectionObserver also delivers an initial callback on
                // observe, so this element — pushed below the fold with the
                // same `mt-[120vh]` technique as #demo-scroll-target, which
                // makes "off-screen at load" independent of window size —
                // must report NOT intersecting before anything is scrolled,
                // and flip to intersecting once it is scrolled into view.
                // Both states are rendered because the flip is the proof: a
                // single state could be a constant.
                div {
                    id: "demo-visible-target",
                    class: "mt-[120vh] rounded-md border p-2 text-sm",
                    onvisible: move |evt| {
                        // `is_intersecting` / `get_intersection_ratio` ->
                        // VisibleResult<_> (dioxus-html-0.7.10
                        // src/events/visible.rs:31-42).
                        visible_intersecting.set(match evt.is_intersecting() {
                            Ok(true) => "visible-yes",
                            Ok(false) => "visible-no",
                            Err(_) => "visible-failed",
                        });
                        visible_ratio.set(match evt.get_intersection_ratio() {
                            Ok(ratio) => ratio,
                            Err(_) => QUERY_FAILED as f64,
                        });
                    },
                    "Visibility target"
                }
                dl { class: "grid grid-cols-2 gap-x-4 text-sm",
                    dt { "is intersecting" }
                    dd { id: "visible-intersecting", "{visible_intersecting}" }
                    dt { "intersection ratio" }
                    dd { id: "visible-ratio", "{visible_ratio}" }
                }
            }

            section {
                h2 { "Badge" }
                div { class: "flex gap-2",
                    Badge { variant: BadgeVariant::Default, "Default" }
                    Badge { variant: BadgeVariant::Secondary, "Secondary" }
                    Badge { variant: BadgeVariant::Destructive, "Destructive" }
                    Badge { variant: BadgeVariant::Outline, "Outline" }
                }
            }

            section {
                h2 { "Card" }
                Card { class: "w-96",
                    CardHeader {
                        CardTitle { "Card Title" }
                    }
                    CardContent {
                        p { "Some card content." }
                    }
                    CardFooter {
                        p { "Card footer" }
                    }
                }
            }

            section {
                h2 { "Avatar" }
                // Fallback-only path (initials): this demo is self-contained
                // and never fetches a network image (no AvatarImage).
                Avatar {
                    AvatarFallback { "PE" }
                }
            }

            section {
                h2 { "Spinner" }
                Spinner { size: SpinnerSize::Large }
            }

            section {
                h2 { "Empty" }
                Empty {
                    EmptyHeader {
                        EmptyTitle { "No results found" }
                        EmptyDescription { "Try adjusting your search." }
                    }
                    EmptyContent {
                        p { "Nothing else to show here." }
                    }
                }
            }
        }
    }
}

polyengine_dioxus::launch!(app);
