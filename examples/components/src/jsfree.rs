//! JS-free adaptations of `dioxus_components` 0.1.2's Dialog and Tooltip,
//! written for this renderer. The upstream components are unusable here:
//! `wbg-sever` strips this component's wasm-bindgen imports, so every
//! `js_sys` / `web_sys` call in them traps at runtime. Rather than drop the
//! behaviours, the two below re-derive them from plain Dioxus event
//! handlers plus CSS.
//!
//! What upstream does with JS, and what happens to it here:
//!
//! **Tooltip** (`src/components/tooltip/tooltip.rs`)
//!   1. `web_sys::console::log_1` debug tracing (6+ call sites) — no
//!      behaviour; dropped outright.
//!   2. `web_sys::window().set_timeout_with_callback_and_timeout_and_arguments_0`
//!      / `clear_timeout_with_handle` for the open/close delays — replaced
//!      by CSS `transition-delay` (Tailwind `delay-*`). This is not merely a
//!      workaround: the guest has no timer capability at all (the WIT world
//!      imports only `events`, no clock), so a Rust-side delay is
//!      impossible, and a compositor-driven delay is the better
//!      implementation regardless.
//!   3. Open/close state itself — replaced by the `group-hover:` /
//!      `group-focus-within:` variants, so the component holds no state and
//!      registers no event listeners.
//!
//! **Dialog** (`src/components/dialog/mod.rs`)
//!   1. Body scroll lock (`document.body.style.overflow = "hidden"`) —
//!      **genuinely lost**. `document.body` is outside the guest's mount
//!      subtree, so no non-imperative construct can reach it. Mitigated with
//!      `overscroll-contain` on the full-viewport backdrop, which stops
//!      scroll chaining to the page (the common case) but does not stop a
//!      wheel/touch scroll that starts outside the backdrop.
//!   2. Focus trap (`querySelectorAll` for focusables + `.focus()` + Tab
//!      interception) — **partly lost**. Imperative focus is unavailable:
//!      this renderer reports `MountedData` as `NotSupported`, so there is
//!      no handle to call `.set_focus()` on. `autofocus` on the close button
//!      is the only non-imperative alternative and it does **not** work
//!      here: the HTML spec ignores autofocus candidates once a document
//!      has finished loading, so a dialog inserted by a later render never
//!      takes focus. (Verified in Chromium against a plain
//!      `document.body.appendChild(<button autofocus>)` control, which is
//!      equally ignored — this is the browser, not the renderer.) The
//!      attribute stays because nothing better exists. Consequences: focus
//!      remains on whatever opened the dialog, Escape only fires once the
//!      user has tabbed into the dialog, and Tab cycling within the dialog
//!      is not attempted either, so Tab can walk back out into the page
//!      behind it.
//!   3. Escape-to-close (a `document`-level `keydown` listener) — a plain
//!      `onkeydown` on the panel, faithful *while focus is inside the
//!      dialog*. The panel carries `tabindex="-1"` so it can hold focus and
//!      receive key events. Upstream's listener is on `document` and so
//!      fires regardless of focus; a guest component cannot register
//!      outside its own subtree, and point 2 means focus does not start
//!      inside the dialog.
//!   4. Backdrop click-to-close — faithful; upstream already used a plain
//!      Dioxus `onclick` here. The panel calls `evt.stop_propagation()` so a
//!      click inside it does not bubble to the backdrop's handler. That call
//!      is load-bearing: the host dispatches an event to the nearest
//!      registered ancestor and dioxus-core then bubbles it through the
//!      virtual tree (src/driver.rs:293-297), so the backdrop handler would
//!      otherwise fire for panel clicks.
//!
//! **Portal** (`src/components/portal/mod.rs`) has no adaptation here, by
//! design. Its single JS use is a `js_sys::Function` in `onmounted` that
//! `appendChild`s the node into another container — inherently imperative
//! DOM work. But its only purpose is escaping ancestor stacking/overflow
//! contexts for overlays, and it already pairs that with
//! `position: fixed; inset: 0; z-index: 9999`, which achieves the visual
//! result on its own. `Dialog` below just positions itself `fixed`; a
//! vendored Portal would be a component with nothing left to do.
//!
//! Styling is Tailwind utility classes only — `just components-css` scans
//! this crate's sources (`@source` in the justfile's `components-css`
//! recipe), so the classes used here land in `harness/components.css`
//! automatically and no separate stylesheet is needed.

use dioxus::prelude::*;

/// Hover/focus tooltip with no state and no event listeners: the `group`
/// wrapper plus `group-hover:` / `group-focus-within:` variants do the
/// whole job, and `delay-300` supplies the open delay upstream got from
/// `setTimeout`.
///
/// `bubble_id` exists so the e2e harness can address the bubble element;
/// the wrapper is not addressable and does not need to be.
///
/// Accessibility: the bubble is `role="tooltip"`. `aria-describedby` on the
/// trigger would need id plumbing through `children`, which is not
/// available — it is left off rather than faked. `children` must contain a
/// natively focusable element (a `button`, a link, or anything with
/// `tabindex`) for the keyboard path to work, since `group-focus-within`
/// only fires if something inside the group can take focus.
#[component]
pub fn Tooltip(text: String, bubble_id: String, children: Element) -> Element {
    rsx! {
        span { class: "group relative inline-block",
            {children}
            div {
                id: "{bubble_id}",
                role: "tooltip",
                // `invisible` (not just `opacity-0`) is what actually hides
                // it: an `opacity-0` element still has a layout box and
                // still counts as visible to assistive tech and to
                // hit-testing. `transition-all` is required rather than
                // Tailwind's default `transition` set because `visibility`
                // is not in that set, and `visibility` is the property the
                // `delay-300` has to apply to for the open delay to be
                // real. `pointer-events-none` keeps the bubble from
                // swallowing pointer events aimed past it.
                class: "pointer-events-none invisible absolute bottom-full left-1/2 z-50 mb-2 \
                        -translate-x-1/2 whitespace-nowrap rounded-md bg-neutral-900 px-2 py-1 \
                        text-xs text-white opacity-0 shadow-md transition-all delay-300 \
                        duration-150 group-hover:visible group-hover:opacity-100 \
                        group-focus-within:visible group-focus-within:opacity-100",
                "{text}"
            }
        }
    }
}

/// Modal dialog. Renders nothing when `open` is false.
///
/// `panel_id` / `close_id` are addressing hooks for the e2e harness; they
/// are separate props rather than one derived from the other so the markup
/// contract is readable at the call site.
#[component]
pub fn Dialog(
    open: Signal<bool>,
    title: String,
    panel_id: String,
    close_id: String,
    children: Element,
) -> Element {
    if !open() {
        return rsx! {};
    }
    rsx! {
        div {
            // Fixed + inset-0 + a high z-index is the whole of what
            // upstream's Portal bought (see module doc). `overscroll-contain`
            // is the partial stand-in for the body scroll lock.
            class: "fixed inset-0 z-[9999] flex items-center justify-center overscroll-contain \
                    bg-black/50 p-4",
            onclick: move |_| open.set(false),
            div {
                id: "{panel_id}",
                role: "dialog",
                aria_modal: "true",
                // Needed so the panel can hold focus and therefore receive
                // the keydown below; it is deliberately not tab-reachable.
                tabindex: "-1",
                class: "w-full max-w-md rounded-lg bg-white p-6 shadow-xl outline-none",
                onclick: move |evt| evt.stop_propagation(),
                onkeydown: move |evt| {
                    if evt.key() == Key::Escape {
                        open.set(false);
                    }
                },
                h3 { class: "mb-2 text-lg font-semibold", "{title}" }
                div { class: "mb-4 text-sm", {children} }
                button {
                    id: "{close_id}",
                    // Does not actually take effect (see the module doc:
                    // autofocus candidates are ignored after document load,
                    // and `MountedData` is NotSupported so there is no
                    // imperative `set_focus()` either). Kept because it is
                    // the only non-imperative expression of the intent, and
                    // it is what would start working if the renderer ever
                    // exposed mounted handles.
                    autofocus: true,
                    class: "rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white",
                    onclick: move |evt| {
                        evt.stop_propagation();
                        open.set(false);
                    },
                    "Close"
                }
            }
        }
    }
}
