//! Gate 1: HTML correctness, natively. No wasm, no wasmtime, no ports.
//!
//! `Vec<u8>` is an `io::Write`, so these drive the exact same code path the
//! `serve` artifact does — only the sink differs.

use std::io::{self, BufWriter, Write};

use dioxus::prelude::*;
use polyengine_dioxus_ssr::render_to;

#[allow(non_snake_case)]
fn Page() -> Element {
    let count = use_signal(|| 3i32);
    rsx! {
        div { class: "app",
            h1 { "hello" }
            p { class: if count() % 2 == 0 { "even" } else { "odd" }, "count is {count}" }
            ul {
                for n in 0..3 {
                    li { key: "{n}", "item-{n}" }
                }
            }
            input { value: "draft", disabled: false }
        }
    }
}

// Markers included: `render_to` always pre-renders (see its doc). They are
// the client's only handle on which node is which, so they belong in the
// expectation rather than being filtered out of it — a change to the marker
// numbering is a change to the hydration contract and should fail here.
const EXPECTED: &str = concat!(
    r#"<div class="app" data-node-hydration="0">"#,
    "<h1>hello</h1>",
    r#"<p class="odd" data-node-hydration="1"><!--node-id2-->count is 3<!--#--></p>"#,
    "<ul>",
    r#"<li data-node-hydration="3"><!--node-id4-->item-0<!--#--></li>"#,
    r#"<li data-node-hydration="5"><!--node-id6-->item-1<!--#--></li>"#,
    r#"<li data-node-hydration="7"><!--node-id8-->item-2<!--#--></li>"#,
    "</ul>",
    r#"<input value="draft" data-node-hydration="9"/>"#,
    "</div>",
);

fn render(root: fn() -> Element) -> String {
    let mut out = Vec::new();
    render_to(root, &mut out).expect("render");
    String::from_utf8(out).expect("utf-8")
}

#[test]
fn renders_a_component_tree_to_html() {
    assert_eq!(render(Page), EXPECTED);
}

/// A sink that accepts one byte per call, under a buffer far smaller than the
/// document: the `serve` path's writes are chunked by `BufWriter` and split by
/// stream backpressure, so byte-level fragmentation must not change the output.
#[test]
fn output_is_independent_of_chunking() {
    #[derive(Debug)]
    struct Dribble(Vec<u8>);
    impl Write for Dribble {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            match buf.first() {
                Some(&b) => {
                    self.0.push(b);
                    Ok(1)
                }
                None => Ok(0),
            }
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    let mut sink = BufWriter::with_capacity(8, Dribble(Vec::new()));
    render_to(Page, &mut sink).expect("render");
    let out = sink.into_inner().expect("flushed").0;

    assert_eq!(String::from_utf8(out).expect("utf-8"), EXPECTED);
}

/// `fmt::Error` carries nothing, so a sink failure would vanish at the
/// boundary if `render_to` did not stash the real error. On the `serve` path
/// this is how a client hanging up mid-render is distinguished from success.
#[test]
fn sink_failure_surfaces_as_the_original_io_error() {
    struct Broken;
    impl Write for Broken {
        fn write(&mut self, _: &[u8]) -> io::Result<usize> {
            Err(io::ErrorKind::BrokenPipe.into())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    let err = render_to(Page, Broken).expect_err("sink always fails");
    assert_eq!(err.kind(), io::ErrorKind::BrokenPipe);
}
