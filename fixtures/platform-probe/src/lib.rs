//! Host test fixture for the world's platform interfaces (wit/world.wit):
//! one app that drives `eval`, `head` and `history`.
//!
//! Built with the renderer's `eval` feature (see Cargo.toml), so this
//! component imports `polymorph:dioxus/eval` and only instantiates against a
//! host that opted in (`MountOptions.eval`). `head` and `history` are
//! unconditional, so they are exercised in either mount.
//!
//! What the host test asserts, by class:
//!
//! `eval`:
//! - `globalThis.__evalProbe === "fired"` — set by a fire-and-forget eval
//!   nobody awaits.
//! - `.recv` becomes `{"echo":{"n":41},"n":42}` — a guest→script→guest
//!   round trip through `dioxus.recv`/`dioxus.send`.
//! - `.join` becomes `done-41` — the script's return value.
//! - clicking `.bad` sets `.join` to `err:communication` (script threw);
//!   clicking `.invalid` sets it to `err:invalid-js` (script did not
//!   compile).
//!
//! `head`:
//! - `document.title === "probe-title"`, and a `<meta name="probe">` with
//!   content `meta-value` and a `<style>` containing `/* probe-style */`
//!   land in `<head>`.
//! - the `<script>` setting `globalThis.__probeScript` is REFUSED by the
//!   default host unless the mount also granted eval (wit/world.wit,
//!   `interface head`), so the test checks both directions.
//!
//! `history`:
//! - `.route` reads `home` initially; clicking `.nav` pushes `/other` and it
//!   reads `other`; clicking `.back` returns it to `home`.
//! - a host-driven write on the `changes` stream flips `.route` without the
//!   guest asking.

use dioxus::document::{self, EvalError};
use dioxus::prelude::*;

#[derive(Routable, Clone, PartialEq)]
enum Route {
    #[route("/")]
    Home {},
    #[route("/other")]
    Other {},
}

#[component]
fn Home() -> Element {
    rsx! {
        span { class: "route", "home" }
        button {
            class: "nav",
            onclick: move |_| {
                navigator().push(Route::Other {});
            },
            "nav"
        }
    }
}

#[component]
fn Other() -> Element {
    rsx! {
        span { class: "route", "other" }
        button {
            class: "back",
            onclick: move |_| {
                navigator().go_back();
            },
            "back"
        }
    }
}

#[allow(non_snake_case)]
pub fn App() -> Element {
    let mut recv = use_signal(String::new);
    let mut join = use_signal(String::new);

    use_future(move || async move {
        // Fire-and-forget: never awaited, so it also exercises the
        // never-polled release path in the renderer's evaluator.
        document::eval("globalThis.__evalProbe = 'fired';");

        let mut e = document::eval(
            "const x = await dioxus.recv(); dioxus.send({ echo: x, n: x.n + 1 }); return 'done-' + x.n;",
        );
        e.send(serde_json::json!({"n": 41})).unwrap();
        let got: serde_json::Value = e.recv().await.unwrap();
        recv.set(got.to_string());
        let joined: String = e.join().await.unwrap();
        join.set(joined);
    });

    rsx! {
        document::Title { "probe-title" }
        document::Meta { name: "probe", content: "meta-value" }
        document::Style { {"/* probe-style */"} }
        // The default host refuses this one unless the mount granted eval.
        document::Script { {"globalThis.__probeScript = 1"} }
        section {
            span { class: "fired", "-" }
            span { class: "recv", "{recv}" }
            span { class: "join", "{join}" }
            button {
                class: "bad",
                onclick: move |_| async move {
                    match document::eval("throw new Error('boom');")
                        .join::<serde_json::Value>()
                        .await
                    {
                        Err(EvalError::Communication(_)) => join.set("err:communication".into()),
                        other => join.set(format!("unexpected:{other:?}")),
                    }
                },
                "bad"
            }
            button {
                class: "invalid",
                onclick: move |_| async move {
                    match document::eval("this is not js").join::<serde_json::Value>().await {
                        Err(EvalError::InvalidJs(_)) => join.set("err:invalid-js".into()),
                        other => join.set(format!("unexpected:{other:?}")),
                    }
                },
                "invalid"
            }
            Router::<Route> {}
        }
    }
}

polyengine_dioxus::launch!(App);
