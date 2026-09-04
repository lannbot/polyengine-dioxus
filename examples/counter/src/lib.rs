//! Counter example: a small app that exercises every mutation shape the
//! renderer has to get right.
//!
//! - +/- buttons: `onclick`, signal-driven text diffs (`set-text`).
//! - text input echoed to a paragraph: `oninput`, form payloads.
//! - add/remove list items: keyed diffing, so load-template / insert / remove
//!   and placeholder replacement all appear.
//! - a class that toggles: `set-attribute` on an existing element.
//! - a form whose `onsubmit` calls `prevent_default`: proves the guest→host
//!   `dom-event.prevent-default()` path in `wit/world.wit`.

use dioxus::prelude::*;

#[allow(non_snake_case)]
pub fn App() -> Element {
    let mut count = use_signal(|| 0i32);
    let mut draft = use_signal(String::new);
    let mut items = use_signal(|| vec!["alpha".to_string(), "beta".to_string()]);
    let mut submitted = use_signal(|| 0usize);
    let mut next_id = use_signal(|| 0usize);

    rsx! {
        div { class: "app",
            section { class: "counter",
                button { id: "dec", onclick: move |_| count -= 1, "-" }
                span { id: "count", "{count}" }
                button { id: "inc", onclick: move |_| count += 1, "+" }
                // A conditional class: re-renders as a set-attribute op on an
                // element that already exists, not a subtree replacement.
                p {
                    id: "parity",
                    class: if count() % 2 == 0 { "even" } else { "odd" },
                    "count is {count}"
                }
            }

            section { class: "echo",
                input {
                    id: "draft",
                    value: "{draft}",
                    oninput: move |e| draft.set(e.value()),
                }
                p { id: "echo", "{draft}" }
            }

            section { class: "list",
                button {
                    id: "add",
                    onclick: move |_| {
                        let n = next_id();
                        next_id += 1;
                        items.write().push(format!("item-{n}"));
                    },
                    "add"
                }
                button {
                    id: "remove",
                    onclick: move |_| {
                        items.write().pop();
                    },
                    "remove"
                }
                ul { id: "items",
                    // Keyed: exercises the keyed-diff path (moves and removals
                    // rather than wholesale re-creation).
                    for item in items().into_iter() {
                        li { key: "{item}", "{item}" }
                    }
                }
            }

            form {
                id: "form",
                onsubmit: move |e| {
                    // Without this the host would let the browser navigate.
                    // The renderer forwards it as `dom-event.prevent-default()`
                    // before `handle-event` returns.
                    e.prevent_default();
                    submitted += 1;
                },
                input { name: "who", id: "who" }
                button { id: "submit", r#type: "submit", "submit" }
                p { id: "submitted", "submitted {submitted} time(s)" }
            }
        }
    }
}

#[cfg(feature = "client")]
polyengine_dioxus::launch!(App);

#[cfg(feature = "ssr")]
polyengine_dioxus_ssr::launch_ssr!(App);
