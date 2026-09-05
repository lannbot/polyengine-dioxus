//! Host test fixture for the world's `eval` interface (wit/world.wit): an app
//! that drives every path `document::eval` has.
//!
//! Built with the renderer's `eval` feature (see Cargo.toml), so this
//! component imports `polymorph:dioxus/eval` and only instantiates against a
//! host that opted in (`MountOptions.eval`).
//!
//! What the host test asserts, by class:
//! - `globalThis.__evalProbe === "fired"` — set by a fire-and-forget eval
//!   nobody awaits.
//! - `.recv` becomes `{"echo":{"n":41},"n":42}` — a guest→script→guest
//!   round trip through `dioxus.recv`/`dioxus.send`.
//! - `.join` becomes `done-41` — the script's return value.
//! - clicking `.bad` sets `.join` to `err:communication` (script threw);
//!   clicking `.invalid` sets it to `err:invalid-js` (script did not
//!   compile).

use dioxus::document::{self, EvalError};
use dioxus::prelude::*;

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
        }
    }
}

polyengine_dioxus::launch!(App);
