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
//!      example's point of view and get stripped/severed at build time.
//!   3. **Dialog, Portal, and Tooltip are never used below.** All three call
//!      `js_sys::eval` at runtime (scroll lock / focus trap / positioning),
//!      which traps once `wbg-sever` has severed this component's JS
//!      imports — this renderer has no JS boundary left at instantiation
//!      time. Everything shown here (Button, Checkbox, Accordion, Badge,
//!      Card, Avatar, Spinner, Empty) is plain DOM + Rust-side state, no JS
//!      calls.
//!
//! Structural ids referenced by the e2e harness (see the dispatch): the root
//! `#showcase`, `#demo-button` / `#click-count`, `#checkbox-state`, and
//! `#demo-accordion`.

use dioxus::prelude::*;
use dioxus_components::{
    Accordion, AccordionContent, AccordionItem, AccordionTrigger, AccordionType, Avatar,
    AvatarFallback, Badge, BadgeVariant, Button, ButtonVariant, Card, CardContent, CardFooter,
    CardHeader, CardTitle, CheckboxIndicator, CheckboxProvider, CheckboxTrigger, CheckedState,
    Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle, Spinner, SpinnerSize,
};

fn app() -> Element {
    let mut count = use_signal(|| 0i32);
    let mut checkbox_state = use_signal(|| CheckedState::Unchecked);

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
