//! Server-side prerendering for the same components the client renderer drives.
//!
//! This is a second rendering path, not a second renderer: it hands the app's
//! root component to `dioxus-ssr`, which walks the built `VirtualDom` and
//! writes HTML. The mutation protocol in `wit/world.wit` is not involved, so
//! nothing here has to agree byte-for-byte with what `host/src/applier.ts`
//! produces in a browser — `applier.ts` sets `value`/`checked`/`selected` as
//! JS *properties*, which have no serialized form at all. dioxus-web lives
//! with the same split; hydration binds by markers, not by diffing output.
//!
//! Two artifacts share [`render_to`]:
//!
//! - **SSG**: a `wasi:cli/command` binary that writes HTML to stdout. No
//!   HTTP, no async, no component-model streams — `wasmtime run` needs no
//!   flags to execute it, which makes it the cheap end-to-end gate.
//! - **serve**: a `wasi:http/service` component behind the `serve` feature,
//!   wired by [`launch_ssr!`]. See [`serve`] for why the render streams into
//!   the response body rather than buffering a `String`.

use std::fmt;
use std::io;

use dioxus_core::{Element, VirtualDom};
use dioxus_ssr::Renderer;

#[cfg(all(feature = "serve", target_arch = "wasm32"))]
pub mod serve;

/// Adapts a byte sink to the `std::fmt::Write` that `Renderer::render_to`
/// wants.
///
/// The whole reason this exists is that `fmt::Error` is a unit type: the
/// underlying `io::Error` would be destroyed at the boundary, so it is stashed
/// here and recovered by [`render_to`]. Everything else about buffering is
/// `std::io::BufWriter`'s problem, one layer down.
struct FmtBridge<W> {
    inner: W,
    err: Option<io::Error>,
}

impl<W: io::Write> fmt::Write for FmtBridge<W> {
    fn write_str(&mut self, s: &str) -> fmt::Result {
        self.inner.write_all(s.as_bytes()).map_err(|err| {
            self.err = Some(err);
            fmt::Error
        })
    }
}

/// Renders `root` to HTML, writing it into `out`.
///
/// `out` is written incrementally as the renderer walks the tree, and it is
/// flushed before this returns. Wrap it in a [`std::io::BufWriter`] when its
/// writes are expensive — for a component-model `stream<u8>` each one costs a
/// host context switch.
pub fn render_to<W: io::Write>(root: fn() -> Element, out: W) -> io::Result<()> {
    let mut dom = VirtualDom::new(root);
    dom.rebuild_in_place();

    let mut sink = FmtBridge {
        inner: out,
        err: None,
    };

    match Renderer::new().render_to(&mut sink, &dom) {
        // `BufWriter`'s own `Drop` flush swallows errors, so flush here where
        // the result can still be reported.
        Ok(()) => sink.inner.flush(),
        // `FmtBridge` is the only source of `fmt::Error` on this path: the
        // renderer's other writes are infallible `write!`s into it.
        Err(fmt::Error) => Err(sink
            .err
            .take()
            .unwrap_or_else(|| io::Error::other("render failed"))),
    }
}

/// Wires an app crate's root component up as a `wasi:http/service` component.
///
/// Expands to a unit type implementing the generated `Guest` trait plus the
/// `export!` invocation, so the app crate never names `wasip3`.
#[cfg(all(feature = "serve", target_arch = "wasm32"))]
#[macro_export]
macro_rules! launch_ssr {
    ($root:path) => {
        #[doc(hidden)]
        struct __PolyengineDioxusSsr;

        impl $crate::serve::wasip3::exports::http::handler::Guest for __PolyengineDioxusSsr {
            async fn handle(
                _request: $crate::serve::wasip3::http::types::Request,
            ) -> ::core::result::Result<
                $crate::serve::wasip3::http::types::Response,
                $crate::serve::wasip3::http::types::ErrorCode,
            > {
                $crate::serve::respond($root).await
            }
        }

        $crate::serve::wasip3::http::service::export!(__PolyengineDioxusSsr);
    };
}
