//! `document::eval` over the world's `eval` interface: the opt-in JS bridge.
//!
//! Compiled only under the crate's `eval` feature; without it nothing here
//! exists, no `polymorph:dioxus/eval` import is emitted, and dioxus falls
//! back to `NoOpDocument` (`EvalError::Unsupported`). See the `eval`
//! interface doc in `wit/world.wit` for why the capability is opt-in on both
//! sides.
//!
//! # The owner-lifetime problem
//!
//! `dioxus_document::Eval` is `Copy` and holds only a
//! `GenerationalBox<Box<dyn Evaluator>>` (dioxus-document-0.7.10
//! src/eval.rs:10-12), so the evaluator stays alive exactly as long as the
//! `generational_box::Owner` its box was inserted into. dioxus-web hands
//! that owner to JavaScript and lets the browser's GC of the channel object
//! release it (dioxus-web-0.7.10 src/document.rs:196-200); we have no GC
//! hook, and simply leaking one owner per eval is unbounded growth in a UI
//! loop — dioxus-primitives evals on every close animation.
//!
//! So the owner lives in a slot the evaluator itself holds
//! (`Rc<RefCell<Option<Owner>>>`, a deliberate reference cycle) and is taken
//! out — freeing the evaluator, whose `Rc<Evaluation>` drop releases the
//! host resource — at whichever of these comes first:
//!
//! - the script's result arrives and nothing has ever polled the evaluator:
//!   the fire-and-forget case (`document::eval("document.title = ...")`),
//!   which is the common one and the only one that would otherwise
//!   accumulate;
//! - `poll_join` returns `Ready`. The drop is scheduled through
//!   `spawn_local` rather than done inline, because `Eval::join` calls
//!   `poll_join` while holding a `try_write` guard on the very box the owner
//!   would free (src/eval.rs:22-27).
//!
//! An evaluation that is `recv`'d but never joined therefore keeps its owner
//! for the life of the instance: any poll marks the evaluator as observed,
//! since an eval a component is still talking to must not be freed out from
//! under it. That is one bounded leak per such eval, against silently
//! answering `Finished` to a `join` that was about to happen.
//!
//! Once the owner is gone the box is dead and dioxus's own `try_write`/
//! `try_read` failure path answers `EvalError::Finished` — which is also
//! what a second `join` gets, matching the WIT's `finished` case.

use std::cell::RefCell;
use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;
use std::task::{Context, Poll, Waker};

use dioxus_document::{Document, Eval, EvalError, Evaluator};
use generational_box::{AnyStorage, GenerationalBox, Owner, UnsyncStorage};
use wit_bindgen::rt::async_support::spawn_local;

use crate::bindings::polymorph::dioxus::eval;

/// The polyengine document provider, installed as `Rc<dyn Document>` root
/// context by [`crate::driver::run`] (dioxus-document's `document()` looks it
/// up with `try_consume_context`, dioxus-document-0.7.10 src/lib.rs:14).
pub struct WitDocument;

impl Document for WitDocument {
    fn eval(&self, js: String) -> Eval {
        Eval::new(WitEvaluator::create(js))
    }
}

/// Where the completed `join` result lands, and how the awaiting task (if
/// any) learns about it.
#[derive(Default)]
struct JoinState {
    result: Option<Result<serde_json::Value, EvalError>>,
    waker: Option<Waker>,
    /// Whether anything has ever polled the evaluator. Gates the
    /// fire-and-forget release — see the module doc.
    polled: bool,
}

/// The owner slot; `None` once released.
type OwnerSlot = Rc<RefCell<Option<Owner<UnsyncStorage>>>>;

type NextRecv = Pin<Box<dyn Future<Output = Result<serde_json::Value, EvalError>>>>;

struct WitEvaluator {
    handle: Rc<eval::Evaluation>,
    state: Rc<RefCell<JoinState>>,
    owner: OwnerSlot,
    /// Lazily constructed `recv` future, dropped on completion — dioxus-web's
    /// `next_future` pattern (dioxus-web-0.7.10 src/document.rs:277-294).
    next_recv: Option<NextRecv>,
}

impl WitEvaluator {
    fn create(js: String) -> GenerationalBox<Box<dyn Evaluator>> {
        // Construction starts the script: its synchronous prefix runs here,
        // on this stack (wit/world.wit, `resource evaluation`).
        let handle = Rc::new(eval::Evaluation::new(&js));
        let state = Rc::new(RefCell::new(JoinState::default()));
        let owner_storage = UnsyncStorage::owner();
        let owner: OwnerSlot = Rc::new(RefCell::new(None));

        let boxed = owner_storage.insert(Box::new(Self {
            handle: handle.clone(),
            state: state.clone(),
            owner: owner.clone(),
            next_recv: None,
        }) as Box<dyn Evaluator>);
        // Filled before the join task can run, so its release path never
        // finds an empty slot.
        *owner.borrow_mut() = Some(owner_storage);

        spawn_local(async move {
            let result = match handle.join().await {
                Ok(json) => serde_json::from_str(&json).map_err(EvalError::Serialization),
                Err(e) => Err(eval_error(e)),
            };
            let (waker, unobserved) = {
                let mut state = state.borrow_mut();
                state.result = Some(result);
                (state.waker.take(), !state.polled)
            };
            match waker {
                Some(waker) => waker.wake(),
                // Nobody is awaiting and nobody ever polled: fire-and-forget.
                // Release now rather than hold the host resource for the life
                // of the instance.
                None if unobserved => drop(owner.borrow_mut().take()),
                None => {}
            }
        });

        boxed
    }
}

impl Evaluator for WitEvaluator {
    fn poll_join(&mut self, cx: &mut Context<'_>) -> Poll<Result<serde_json::Value, EvalError>> {
        let mut state = self.state.borrow_mut();
        state.polled = true;
        match state.result.take() {
            Some(result) => {
                drop(state);
                // Not inline: we are inside `Eval::join`'s `try_write` guard
                // on the box this owner holds (dioxus-document-0.7.10
                // src/eval.rs:22-27).
                let owner = self.owner.clone();
                spawn_local(async move { drop(owner.borrow_mut().take()) });
                Poll::Ready(result)
            }
            None => {
                state.waker = Some(cx.waker().clone());
                Poll::Pending
            }
        }
    }

    fn poll_recv(&mut self, cx: &mut Context<'_>) -> Poll<Result<serde_json::Value, EvalError>> {
        self.state.borrow_mut().polled = true;
        if self.next_recv.is_none() {
            let handle = self.handle.clone();
            self.next_recv = Some(Box::pin(async move {
                match handle.recv().await {
                    Ok(json) => serde_json::from_str(&json).map_err(EvalError::Serialization),
                    Err(e) => Err(eval_error(e)),
                }
            }));
        }
        let result = self.next_recv.as_mut().unwrap().as_mut().poll(cx);
        if result.is_ready() {
            self.next_recv = None;
        }
        result
    }

    fn send(&self, data: serde_json::Value) -> Result<(), EvalError> {
        // Values cross as JSON text both ways (wit/world.wit, `interface
        // eval`), so there is no serialization step left to fail.
        self.handle.send(&data.to_string());
        Ok(())
    }
}

/// The WIT `error` cases onto dioxus's `EvalError`, one for one.
fn eval_error(error: eval::Error) -> EvalError {
    match error {
        eval::Error::InvalidJs(message) => EvalError::InvalidJs(message),
        eval::Error::Communication(message) => EvalError::Communication(message),
        eval::Error::Finished => EvalError::Finished,
    }
}
