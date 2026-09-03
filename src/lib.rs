//! Dioxus renderer for components running on polyengine.
//!
//! - [`protocol`]: the batch encoder (op segment + string segment, interned
//!   and dynamic strings) matching the wire format documented in
//!   `wit/world.wit`.
//! - [`writer`]: the `dioxus_core::WriteMutations` sink that fills a batch.
//! - `bindings` / `driver` / `events` / `typed` (wasm32 only): the generated
//!   WIT bindings, the `run`/`run-typed`/`handle-event` implementation, the
//!   `HtmlEventConverter` over the WIT payload types, and the
//!   `WriteMutations` sink for the typed channel's `stream<operation>`.
//!   These are gated on `target_arch = "wasm32"` so `cargo test` can
//!   exercise the encoder and writer natively. `typed` names the generated
//!   bindings and so is not covered by `cargo test`; it is kept obviously
//!   parallel to [`writer`] and checked host-side for equivalence.
//!
//! An application crate wires itself up with [`launch!`].

pub mod protocol;
pub mod writer;

#[cfg(target_arch = "wasm32")]
pub mod bindings;
#[cfg(target_arch = "wasm32")]
pub mod driver;
#[cfg(target_arch = "wasm32")]
pub mod events;
#[cfg(target_arch = "wasm32")]
pub mod typed;
