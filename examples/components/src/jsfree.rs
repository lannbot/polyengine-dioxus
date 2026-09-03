//! JS-free adaptations of `dioxus_components` 0.1.2's Dialog and Tooltip,
//! written for this renderer. The upstream components are unusable here:
//! the guest is built for wasm32-wasip2, where wasm-bindgen compiles to
//! stubs that abort rather than emitting imports, so every
//! `js_sys` / `web_sys` call in them traps at runtime. Rather than drop the
//! behaviours, the two below re-derive them from plain Dioxus event
//! handlers plus CSS.
//!
//! This pattern is the standing answer for this renderer, not a stopgap: a
//! primary consumer (polyvisor) cannot permit arbitrary JS evaluation, so
//! neither a JS boundary nor `document::eval` will be added. A JS-driven
//! behaviour you need has to be re-derived, as here — see
//! `examples/primitives/src/lib.rs` for which upstream primitives that
//! leaves degraded.
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
//!      interception) — **working**, by a different construction. The
//!      renderer now synthesizes the `mounted` event and backs
//!      `MountedData::set_focus` with the `dom.set-focus` import
//!      (wit/world.wit's `dom` interface; guest side src/events.rs:613-632),
//!      so `onmounted` yields a handle that can move focus. Two pieces:
//!        - *Initial focus*: the close button's `onmounted` calls
//!          `set_focus(true)` on its own handle. (This replaces an
//!          `autofocus` attribute that never fired — the HTML spec ignores
//!          autofocus candidates once a document has finished loading, so
//!          it was dead weight on a dialog inserted by a later render.)
//!        - *Tab cycling*: two `tabindex="0"` focus guards bracket the
//!          panel's content, `sr-only` so they are invisible but still in
//!          the tab order (`display:none` / `visibility:hidden` would take
//!          them out of it, which is why the clipping technique is the one
//!          that works). Tabbing off either end lands on a guard, whose
//!          `onfocusin` bounces focus back to a real control. `focusin` is
//!          the name to hang this on: it is what the renderer delivers for
//!          the DOM's own bubbling focus event
//!          (`event_bubbles("focusin") == true`, so the host delegates it
//!          at the mount root and resolves the guard by walking up from
//!          `event.target`).
//!        - *Fidelity boundary worth naming*: a `querySelectorAll`-based trap
//!          wraps to the genuinely first/last focusable in the dialog. This one
//!          can only wrap to controls the component itself owns, because
//!          `children` is an opaque `Element` and there is no way to enumerate
//!          the focusables inside it. The close button is the panel's last
//!          control, so the leading guard's wrap (Shift-Tab off the top → last
//!          control) is exact; the trailing guard's wrap (Tab off the bottom →
//!          first control) also lands on the close button, where a DOM-querying
//!          trap would have landed on the first focusable inside `children`.
//!          Focus never escapes either way — the cycle is just shorter than
//!          upstream's when `children` contains its own controls.
//!   3. **Focus restoration on close** — **genuinely lost**, and it is the
//!      one focus behaviour still missing. Restoring focus to whatever
//!      opened the dialog means knowing what that was, i.e. reading
//!      `document.activeElement` at open time; the `dom` interface has no
//!      query operation and `MountedData` has no "am I focused". Nothing
//!      here fakes it. Fixing it needs either a `dom` operation that
//!      returns the focused element's ElementId (which the guest could
//!      stash and `set-focus` back to), or a host-side save/restore pair.
//!   4. Escape-to-close (a `document`-level `keydown` listener) — faithful.
//!      A plain `onkeydown` on the panel, which now sees the key from the
//!      first press onward because point 2 puts focus inside the dialog on
//!      open and keeps it there. The panel carries `tabindex="-1"` so it
//!      can hold focus and receive key events.
//!   5. Backdrop click-to-close — faithful; upstream already used a plain
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
use std::rc::Rc;

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
    // Handle to the close button, captured by its `onmounted`. Held in a
    // signal because it is written by one handler and read by three others.
    let mut close_handle: Signal<Option<Rc<MountedData>>> = use_signal(|| None);
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
                // Leading focus guard. Reached by Shift-Tab off the first
                // control in the panel, or by Tab from anything before the
                // dialog in document order; either way, bounce focus to the
                // panel's last control. `sr-only` clips it to a 1px box
                // rather than hiding it, which is what keeps it in the tab
                // order at all.
                span {
                    class: "sr-only",
                    tabindex: "0",
                    onfocusin: move |_| focus_close(close_handle),
                }
                h3 { class: "mb-2 text-lg font-semibold", "{title}" }
                div { class: "mb-4 text-sm", {children} }
                button {
                    id: "{close_id}",
                    class: "rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white",
                    // Initial focus, and the anchor both guards bounce to.
                    // `mounted` is synthesized by the host after the batch
                    // that created this node has been applied, so the node
                    // is in the document by the time this runs.
                    onmounted: move |evt| {
                        close_handle.set(Some(evt.data()));
                        focus_close(close_handle);
                    },
                    onclick: move |evt| {
                        evt.stop_propagation();
                        open.set(false);
                    },
                    "Close"
                }
                // Trailing focus guard: Tab off the last control lands here
                // and is sent back to the close button. See the module doc
                // for why the wrap target is the close button rather than
                // the genuinely-first focusable in the panel.
                span {
                    class: "sr-only",
                    tabindex: "0",
                    onfocusin: move |_| focus_close(close_handle),
                }
            }
        }
    }
}

/// Move focus to the close button, if its `onmounted` has run.
///
/// `MountedData::set_focus` is async in dioxus-html's trait, so it has to be
/// driven by a task even though this renderer's implementation resolves
/// immediately (`dom.set-focus` is a synchronous import — src/events.rs:618).
/// The result is dropped rather than propagated: the only failure mode is
/// "no live node for that ElementId", which happens when a stashed handle
/// outlives its element — a dialog that is closing is exactly that case, and
/// there is nothing useful for a component to do about it. (Nowhere to log
/// it either: this component has no JS boundary and the example pulls in no
/// tracing subscriber.)
fn focus_close(handle: Signal<Option<Rc<MountedData>>>) {
    let Some(data) = handle.peek().clone() else { return };
    spawn(async move {
        let _ = data.set_focus(true).await;
    });
}
