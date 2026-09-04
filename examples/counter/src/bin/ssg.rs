//! Prerenders the counter app to stdout.
//!
//! Built for `wasm32-wasip2` this is a `wasi:cli/command` component that
//! `wasmtime run` executes with no flags — the cheapest end-to-end proof that
//! the renderer works inside a component. Built natively it prints the same
//! bytes, so one golden file covers both.

use std::io::{BufWriter, stdout};

fn main() {
    polyengine_dioxus_ssr::render_to(counter_example::App, BufWriter::new(stdout().lock()))
        .expect("prerender to stdout");
}
