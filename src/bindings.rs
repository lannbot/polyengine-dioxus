//! Generated WIT bindings for the `polymorph:dioxus/app` world.
//!
//! The renderer implements the world's exports (`run`, `handle-event`)
//! internally; application crates invoke [`crate::launch!`] which expands to
//! the `Guest` impl wired to their root component plus the re-exported
//! `export!` macro. (Glue lands with the driver; this module only pins the
//! bindings generation.)

wit_bindgen::generate!({
    path: "wit",
    world: "app",
    pub_export_macro: true,
    default_bindings_module: "polyengine_dioxus::bindings",
});
