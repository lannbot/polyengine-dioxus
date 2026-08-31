//! The `polymorph:dioxus/app` world implementation: mount the app, pump the
//! Dioxus scheduler, and dispatch DOM events back into it.
//!
//! # Why the VirtualDom lives in a thread-local
//!
//! The scheduler task `run` spawns and every `handle-event` export task live
//! in the same (single-threaded) component instance, and both need the
//! VirtualDom: the scheduler to wait for and render scheduler work,
//! `handle-event` to dispatch and then flush the render the handler just
//! caused. `wit/world.wit` requires that flush to happen before
//! `handle-event`'s completion is observable host-side, so `handle-event`
//! cannot simply mark scopes dirty and hope the scheduler task is polled
//! first — it renders and flushes itself.
//!
//! That means neither task may hold a borrow of the VirtualDom across an
//! await. The scheduler's wait is therefore written as a `poll_fn` that
//! constructs a fresh `wait_for_work()` future on every poll and drops the
//! borrow before returning `Pending`. dioxus documents `wait_for_work` as
//! cancel-safe ("you're fine to discard the future in a select block",
//! dioxus-core-0.7.10/src/virtual_dom.rs:433), which is exactly the property
//! this needs: each poll re-drains the scheduler queue and re-registers the
//! waker on the mpsc receiver.
//!
//! # Why `run` returns immediately and spawns the scheduler
//!
//! `run` is `async func() -> stream<u8>`: the host awaits its promise to
//! obtain the read end, then parks a `readDirect` session on it. Under the
//! component-model async ABI, an async export's Rust body *returning* is
//! task.return followed by task exit — so the scheduler cannot live in
//! `run`'s own body. Instead `run` creates the stream, stashes the writer
//! half in `RENDERER`, `spawn_local`s the mount-and-serve task, and returns
//! the reader. (Precedent for returning a stream while a spawned task pumps
//! it: `.deps/polyengine/examples/guests/stream-echo/src/lib.rs`.)
//!
//! Ordering is safe by rendezvous: the spawned task's first `write` parks
//! until the host actually reads, so nothing is lost if it runs before the
//! host has its session parked. The converse would deadlock, which is why
//! `run`'s own body must not write anything before returning the reader —
//! that write would park while the host is still awaiting `run`'s promise
//! for the reader it needs in order to read.
//!
//! All driver state (`RENDERER`/`RUNTIME`/`INTERNER`/`VDOM`) is installed
//! before `run` returns, so a `handle-event` arriving immediately after the
//! return finds consistent state. It cannot find a listener yet (no batch
//! has been applied), but it will not observe an uninitialized cell.
//!
//! # How failure surfaces
//!
//! (Historical: an earlier revision passed the read end to a host import and
//! `run`'s promise never settled, so a mount-time failure had nowhere to go
//! but that held-open promise.) Now `run`'s promise settles as soon as the
//! reader is handed back, and a trap in the spawned scheduler task surfaces
//! as a rejection of the host's parked direct-read session
//! (`PeerTrappedError`) — the channel the host actually watches. A trap
//! during `run`'s own body rejects the host's `await exports.run()`.

use std::cell::RefCell;
use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;
use std::task::Context;

use dioxus_core::{ElementId, Element, Event, Runtime, VirtualDom};
use dioxus_core_types::event_bubbles;
use dioxus_html::PlatformEventData;
use wit_bindgen::rt::async_support::{spawn_local, StreamReader, StreamWriter};

use crate::bindings::polymorph::dioxus::events::Payload;
use crate::bindings::{wit_stream, DomEvent};
use crate::events::{WitEventConverter, WitEventData};
use crate::protocol::Interner;
use crate::writer::MutationWriter;

/// The read end of the mutation channel: what `run` hands back to the host.
/// Named here so [`crate::launch!`] can spell the export's return type
/// without the app crate naming wit-bindgen's runtime module.
pub type MutationStream = StreamReader<u8>;

/// Everything the flush path needs, shared by the `run` loop and by
/// `handle-event`.
struct Renderer {
    writer: MutationWriter,
    /// Taken for the duration of a write so a second flusher can detect an
    /// in-flight write instead of panicking on a re-entrant `RefCell`
    /// borrow.
    stream: Option<StreamWriter<u8>>,
    /// Frame bytes staged while another task owns `stream`. The in-flight
    /// flusher drains this before giving the writer back, which keeps frames
    /// in batch order.
    pending: Vec<u8>,
    /// Reused frame scratch buffer (`Batch::take_frame` appends).
    scratch: Vec<u8>,
    /// Set once the host has dropped the read end of the stream transport
    /// (see the reader-gone branch in [`flush`]). Once dead, `flush` drops
    /// staged/incoming batches instead of accumulating them in `pending`:
    /// this is only reachable at host teardown, when there is no longer a
    /// reader to receive anything, so bounded memory beats a slow leak from
    /// unboundedly growing `pending` across further flushes.
    dead: bool,
}

thread_local! {
    static VDOM: RefCell<Option<VirtualDom>> = const { RefCell::new(None) };
    static RENDERER: RefCell<Option<Renderer>> = const { RefCell::new(None) };
    /// Kept separately from `VDOM` so event dispatch never has to borrow the
    /// VirtualDom itself (`Runtime::handle_event` only needs the runtime).
    static RUNTIME: RefCell<Option<Rc<Runtime>>> = const { RefCell::new(None) };
    /// Reverse `u16 -> &'static str` lookup for `handle-event` names. Shares
    /// storage with the writer's forward map.
    static INTERNER: RefCell<Option<Rc<RefCell<Interner>>>> = const { RefCell::new(None) };
}

/// Stage the current batch (if non-empty) and push it to the host.
///
/// Appends one frame and writes it. `StreamWriter::write_all` returns the
/// values it could *not* write, which happens only once the read end is
/// gone; there is no short-write case to retry because `write_all` already
/// loops. When the host's direct-read session is parked the whole write
/// completes inline, so this await normally does not yield.
async fn flush() {
    enum Action {
        Nothing,
        Stream(StreamWriter<u8>, Vec<u8>),
        /// Another task owns the stream writer; our frame was staged and will
        /// be drained by that task in order.
        Staged,
    }

    let action = RENDERER.with_borrow_mut(|r| {
        let r = r.as_mut().expect("driver: renderer not initialized");
        if r.writer.batch.is_empty() {
            return Action::Nothing;
        }
        if r.dead {
            // The reader is gone; drop this batch instead of staging it into
            // `pending` (which would otherwise grow unboundedly across every
            // future flush once the host has torn down its read end).
            let mut discard = Vec::new();
            r.writer.batch.take_frame(&mut discard);
            return Action::Nothing;
        }
        r.scratch.clear();
        r.writer.batch.take_frame(&mut r.scratch);
        match r.stream.take() {
            Some(w) => Action::Stream(w, std::mem::take(&mut r.scratch)),
            None => {
                r.pending.extend_from_slice(&r.scratch);
                Action::Staged
            }
        }
    });

    match action {
        Action::Nothing | Action::Staged => {}
        Action::Stream(mut w, mut bytes) => {
            loop {
                // `write_all` loops internally over partial writes and gives
                // back whatever it could not deliver; a non-empty remainder
                // means the read end is gone, not a short write to retry.
                let leftover = w.write_all(bytes).await;
                if !leftover.is_empty() {
                    // The host dropped the read end: the mutation channel is
                    // gone and there is nothing useful left to do with this
                    // writer.
                    // Mark the renderer dead and drop whatever was staged so
                    // far — only reachable at host teardown, and bounded
                    // memory beats a slow leak from `pending` growing on
                    // every subsequent flush with no reader left to drain it.
                    RENDERER.with_borrow_mut(|r| {
                        let r = r.as_mut().unwrap();
                        r.dead = true;
                        r.pending.clear();
                    });
                    return;
                }
                // Anything another task staged while we were awaiting goes out
                // now, before the writer becomes available again — otherwise
                // frames would leave the guest out of batch order.
                let staged = RENDERER.with_borrow_mut(|r| {
                    let r = r.as_mut().unwrap();
                    // `leftover` is the drained buffer; hand its capacity back
                    // to the scratch slot so steady-state flushing does not
                    // reallocate.
                    r.scratch = leftover;
                    std::mem::take(&mut r.pending)
                });
                if staged.is_empty() {
                    RENDERER.with_borrow_mut(|r| r.as_mut().unwrap().stream = Some(w));
                    return;
                }
                bytes = staged;
            }
        }
    }
}

/// Await the next scheduler wakeup without holding a borrow of the VirtualDom
/// across the await point. See the module doc for why this is sound.
fn wait_for_work() -> impl Future<Output = ()> {
    std::future::poll_fn(|cx: &mut Context<'_>| {
        VDOM.with_borrow_mut(|dom| {
            let dom = dom.as_mut().expect("driver: vdom not initialized");
            let fut = dom.wait_for_work();
            let mut fut = std::pin::pin!(fut);
            Pin::new(&mut fut).poll(cx)
        })
    })
}

/// Implementation of the world's `run` export.
///
/// Installs the event converter, builds the VirtualDom, creates the mutation
/// stream, spawns the mount-and-serve task (`rebuild` → one batch, then the
/// scheduler forever), and returns the stream's read end to the host. See
/// the module doc for why the scheduler must be a spawned task and why
/// nothing is written before the return.
pub async fn run(root: fn() -> Element) -> MutationStream {
    // dioxus-html's converter slot is global and write-once per process; a
    // component instance is a fresh process image, so this runs exactly once.
    dioxus_html::set_event_converter(Box::new(WitEventConverter));

    let dom = VirtualDom::new(root);
    let interner = Rc::new(RefCell::new(Interner::new()));
    RUNTIME.set(Some(dom.runtime()));
    INTERNER.set(Some(interner.clone()));
    VDOM.set(Some(dom));

    let (writer, reader) = wit_stream::new();

    // Installed before returning, so a `handle-event` racing the host's very
    // first read finds initialized state rather than tripping an `expect`.
    RENDERER.set(Some(Renderer {
        writer: MutationWriter::new(interner),
        stream: Some(writer),
        pending: Vec::new(),
        scratch: Vec::new(),
        dead: false,
    }));

    spawn_local(async move {
        render(|dom, w| dom.rebuild(w));
        flush().await;

        // The persistent scheduler loop's park (`wait_for_work`: a plain Rust
        // future woken cross-task, no WIT waitable) is legal because the host
        // retains a parked direct-read session on our ops stream — amendment
        // A15 host retention, so a quiescent instance is the documented
        // embedder-may-act state.
        loop {
            wait_for_work().await;
            render(|dom, w| dom.render_immediate(w));
            flush().await;
        }
    });

    reader
}

/// Run one render step with both thread-locals borrowed, and nothing awaited
/// in between.
fn render(step: impl FnOnce(&mut VirtualDom, &mut MutationWriter)) {
    VDOM.with_borrow_mut(|dom| {
        RENDERER.with_borrow_mut(|r| {
            let dom = dom.as_mut().expect("driver: vdom not initialized");
            let r = r.as_mut().expect("driver: renderer not initialized");
            step(dom, &mut r.writer);
        })
    })
}

/// Implementation of the world's `handle-event` export.
///
/// Dispatch is synchronous (Dioxus's synthetic bubbling included). Afterwards
/// we render and flush whatever the handlers dirtied, then — still before
/// returning, i.e. still inside the host's DOM listener frame — call
/// `ev.prevent-default()` if a handler asked for it.
pub async fn handle_event(target: u32, name: u16, payload: Payload, ev: &DomEvent) {
    // The host cannot have a listener registration before `run` mounted the
    // app, but a defensive early return beats a trap if it ever races.
    let Some(interner) = INTERNER.with_borrow(|i| i.clone()) else { return };
    let Some(runtime) = RUNTIME.with_borrow(|r| r.clone()) else { return };

    let Some(name) = interner.borrow().resolve(name) else {
        // An id we never interned. The host should not be able to produce
        // one (it only ever echoes back ids we sent), so this is a bug
        // signal in debug and a dropped event in release.
        debug_assert!(false, "handle-event: unknown interned event name id {name}");
        return;
    };

    // `Event`'s metadata is shared by `Rc` through `into_any`, so the clone we
    // keep observes `prevent_default()` calls made on the copy the handlers
    // saw.
    let event = Event::new(
        Rc::new(PlatformEventData::new(Box::new(WitEventData(payload)))),
        event_bubbles(name),
    );
    runtime.handle_event(name, event.clone().into_any(), ElementId(target as usize));

    // Dioxus requires prevent_default to be observed before the handler's
    // first await; the borrow of `ev` never crosses one either (this call is
    // synchronous and the flush below is what may yield).
    if !event.default_action_enabled() {
        ev.prevent_default();
    }

    render(|dom, w| dom.render_immediate(w));
    flush().await;
}

/// Wire an app crate's root component into the `polymorph:dioxus/app` world.
///
/// ```ignore
/// polyengine_dioxus::launch!(App);
/// ```
///
/// Expands to a unit type implementing the generated `Guest` trait plus the
/// generated `export!` invocation, so the app crate never names the bindings.
#[macro_export]
macro_rules! launch {
    ($root:path) => {
        #[doc(hidden)]
        struct __PolyengineDioxusApp;

        impl $crate::bindings::Guest for __PolyengineDioxusApp {
            async fn run() -> $crate::driver::MutationStream {
                $crate::driver::run($root).await
            }

            async fn handle_event(
                target: u32,
                name: u16,
                payload: $crate::bindings::Payload,
                ev: &$crate::bindings::DomEvent,
            ) {
                $crate::driver::handle_event(target, name, payload, ev).await
            }
        }

        $crate::bindings::export!(__PolyengineDioxusApp with_types_in $crate::bindings);
    };
}
