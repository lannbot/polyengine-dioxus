//! The `dioxus_history::History` provider over the world's `history`
//! interface: what `dioxus-router` navigates through.
//!
//! Every method is a direct call to the corresponding import — routes are
//! abstract `/path?query#fragment` strings on both sides and the host owns
//! the encoding (`wit/world.wit`, `interface history`). The commands return
//! `bool` where the WIT does; dioxus's trait returns `()` for all but
//! `external`, so a refusal is silently ignored, which is the intended
//! reading of the interface's "`false` = refused" convention.

use std::sync::Arc;

use dioxus_history::History;
use wit_bindgen::rt::async_support::spawn_local;

use crate::bindings::polymorph::dioxus::history;

/// The polyengine history provider, installed as `Rc<dyn History>` root
/// context by [`crate::driver::run`] (dioxus-history's `history()` looks it
/// up with `try_consume_context`, dioxus-history-0.7.10 src/lib.rs:8-16;
/// without it the router falls back to `MemoryHistory` and logs an error).
pub struct WitHistory;

impl History for WitHistory {
    fn current_route(&self) -> String {
        history::current_route()
    }

    fn current_prefix(&self) -> Option<String> {
        history::current_prefix()
    }

    fn can_go_back(&self) -> bool {
        history::can_go_back()
    }

    fn can_go_forward(&self) -> bool {
        history::can_go_forward()
    }

    fn go_back(&self) {
        history::go_back();
    }

    fn go_forward(&self) {
        history::go_forward();
    }

    fn push(&self, route: String) {
        history::push(&route);
    }

    fn replace(&self, route: String) {
        history::replace(&route);
    }

    fn external(&self, url: String) -> bool {
        history::external(&url)
    }

    /// Host-driven navigations (the back button, a visor-driven move) arrive
    /// on the `changes` stream; each one is a re-render trigger, exactly as
    /// dioxus-web's `popstate` listener is (dioxus-web-0.7.10
    /// src/history.rs:169-188).
    ///
    /// The router calls this once, so the single-call limit the WIT places on
    /// `changes` is respected by construction (a second call would get a
    /// stream that closes immediately, which is harmless here anyway).
    fn updater(&self, callback: Arc<dyn Fn() + Send + Sync>) {
        let mut changes = history::changes();
        spawn_local(async move {
            // The route value is deliberately unused: the host has already
            // moved to it by the time the stream yields, so the router's
            // re-read of `current_route()` is the authoritative answer
            // (wit/world.wit, `interface history`, `changes`).
            while changes.next().await.is_some() {
                callback();
            }
        });
    }
}
