//! Dioxus renderer for components running on polyengine.
//!
//! - [`interner`]: the `&'static str` name table behind the protocol's
//!   `cache-string` / `str-ref` interning.
//! - `bindings` / `driver` / `events` / `writer` (wasm32 only): the generated
//!   WIT bindings, the `run`/`handle-event` implementation, the
//!   `HtmlEventConverter` over the WIT payload types, and the
//!   `dioxus_core::WriteMutations` sink that fills a batch of
//!   `mutations::operation` values. These are gated on
//!   `target_arch = "wasm32"` because they name the generated bindings;
//!   [`interner`] does not, so `cargo test` can exercise it natively.
//!
//! An application crate wires itself up with [`launch!`].

pub mod interner;

#[cfg(target_arch = "wasm32")]
pub mod bindings;
#[cfg(target_arch = "wasm32")]
pub mod driver;
#[cfg(target_arch = "wasm32")]
pub mod events;
#[cfg(target_arch = "wasm32")]
pub mod writer;
