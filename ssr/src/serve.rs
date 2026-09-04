//! `wasi:http/service` wrapper: prerender straight into the response body.
//!
//! Two component-model facts shape this module.
//!
//! **The render must run after `handle` returns.** `response.new` takes the
//! body's *read* end and hands it to the host, which cannot read it until it
//! has the `Response` — so a write issued before returning parks forever.
//! (The same hazard `wit/world.wit` documents for `run`.) Hence
//! [`wasip3::spawn_local`], which wit-bindgen provides for exactly this:
//! continuing to execute after `task.return`, before the task exits.
//!
//! **The render itself may block.** `Renderer::render_to` is synchronous, so
//! the sink cannot `.await`; it calls `wit_bindgen::block_on`, which drives
//! the write on `waitable-set.wait`. That is legal here because wasmtime gates
//! blocking on `may_block = task.async_function || task.returned_or_cancelled()`
//! (`wasmtime/src/runtime/component/concurrent.rs`) and `wasi:http/handler.handle`
//! is an `async func` — both disjuncts hold. It is *not* legal from a
//! synchronous export, which is why this trick does not generalise.
//!
//! Blocking this way does not cost concurrency, which is worth recording
//! because it is not obvious: measured against `wasmtime serve` 47 at stock
//! settings (16 concurrent requests per instance), six rate-limited 341 KB
//! responses completed in the wall time of one, so a task parked in
//! `waitable-set.wait` does not hold off its instance-mates. No
//! `--max-instance-concurrent-reuse-count` tuning is needed. Sharing an
//! instance across requests is safe here for the separate reason that
//! [`respond`] keeps everything on the stack — no process globals, one
//! `VirtualDom` per request.

use std::io;

use dioxus_core::Element;
use wasip3::http::types::{ErrorCode, Fields, Response};
use wasip3::wit_bindgen::{StreamWriter, block_on};
use wasip3::{wit_future, wit_stream};

/// Re-exported so [`crate::launch_ssr!`] can name the generated bindings
/// without the app crate depending on `wasip3` itself.
pub use wasip3;

/// `std::io::Write` over a component-model `stream<u8>`.
struct StreamSink(StreamWriter<u8>);

impl io::Write for StreamSink {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        // `write_all` hands back whatever it could not deliver; a non-empty
        // remainder means the read end is gone, i.e. the client hung up.
        if block_on(self.0.write_all(buf.to_vec())).is_empty() {
            Ok(buf.len())
        } else {
            Err(io::ErrorKind::BrokenPipe.into())
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        // Every `write` above has already reached the host.
        Ok(())
    }
}

/// Answers a request by prerendering `root` into the response body.
///
/// The request is ignored: routing, props and static assets are out of scope
/// for this artifact.
pub async fn respond(root: fn() -> Element) -> Result<Response, ErrorCode> {
    let headers = Fields::new();
    headers
        .append("content-type", b"text/html; charset=utf-8")
        .expect("fresh fields are mutable and this header is not oversized");

    let (body_tx, body_rx) = wit_stream::new();
    let (trailers_tx, trailers_rx) = wit_future::new(|| Ok(None));
    let (response, _transmit) = Response::new(headers, Some(body_rx), trailers_rx);
    // No trailers: dropping the writer resolves the future to the default
    // above.
    drop(trailers_tx);

    wasip3::spawn_local(async move {
        // `StreamSink` is the only fallible part of the render, and its only
        // failure is the client hanging up — nothing to report and nobody left
        // to report it to.
        let _ = crate::render_to(root, io::BufWriter::new(StreamSink(body_tx)));
    });

    Ok(response)
}
