//! Dioxus renderer for components running on polyengine.
//!
//! - [`bindings`]: generated WIT bindings for `polymorph:dioxus/app`.
//! - [`protocol`]: the batch encoder (op segment + string segment, interned
//!   and dynamic strings) matching the wire format documented in
//!   `wit/world.wit`.

pub mod bindings;
pub mod protocol;
