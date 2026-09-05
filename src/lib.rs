//! Dioxus renderer for components running on polyengine.
//!
//! - [`interner`]: the `&'static str` name table behind the protocol's
//!   `cache-string` / `str-ref` interning.
//! - [`hydrate`]: the ElementId walk backing the protocol's `hydrate`
//!   operation, in `dioxus-ssr` `pre-render`'s marker order.
//! - `bindings` / `driver` / `events` / `writer` (wasm32 only): the generated
//!   WIT bindings, the `run`/`handle-event` implementation, the
//!   `HtmlEventConverter` over the WIT payload types, and the
//!   `dioxus_core::WriteMutations` sink that fills a batch of
//!   `mutations::operation` values. These are gated on
//!   `target_arch = "wasm32"` because they name the generated bindings;
//!   [`interner`] and [`hydrate`] do not, so `cargo test` can exercise them
//!   natively — and for [`hydrate`] that is the only place it can be
//!   exercised, since checking its order means running `dioxus-ssr` beside
//!   it.
//!
//! An application crate wires itself up with [`launch!`].
//!
//! `document` and `history` (wasm32 only) are the `dioxus_document::Document`
//! and `dioxus_history::History` providers over the world's `head` and
//! `history` interfaces, both unconditional. Under the optional `eval`
//! feature `document` additionally backs `document::eval` over the world's
//! opt-in `eval` interface.

pub mod hydrate;
pub mod interner;

#[cfg(target_arch = "wasm32")]
pub mod bindings;
#[cfg(target_arch = "wasm32")]
pub mod document;
#[cfg(target_arch = "wasm32")]
pub mod driver;
#[cfg(target_arch = "wasm32")]
pub mod events;
#[cfg(target_arch = "wasm32")]
pub mod history;
#[cfg(target_arch = "wasm32")]
pub mod writer;
