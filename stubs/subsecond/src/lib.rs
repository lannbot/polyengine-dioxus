//! An inert stand-in for dioxus's `subsecond` hot-patching crate.
//!
//! # Why this exists
//!
//! `dioxus-core` depends on `subsecond` unconditionally, and `subsecond`'s
//! `wasm32` target section depends on `js-sys`, `web-sys`,
//! `wasm-bindgen-futures` and `wasm-bindgen` — it downloads and instantiates a
//! patch module through the browser's `fetch` when a hot-patch arrives.
//!
//! `wasm-bindgen` emits a `#[no_mangle] pub extern "C" fn
//! __wbindgen_describe_*` per imported JS binding (wasm-bindgen-macro-support
//! 0.2.127 `codegen.rs:3194`). Those are exported symbols, so they are GC
//! roots: linking `js-sys` at all drags ~1900 describe shims plus the
//! `__wbindgen_placeholder__` / `__wbindgen_externref_xform__` imports into
//! the module. `wasm-tools component new` then refuses the module —
//! "failed to resolve import `__wbindgen_placeholder__::__wbindgen_describe`"
//! — because those imports have no WIT interface to bind to.
//!
//! A component running on polyengine has no `fetch`, no JS glue and no
//! wasm-bindgen CLI pass, so subsecond's wasm implementation could never do
//! anything here. Replacing it with this stub (via `[patch.crates-io]` in the
//! workspace root) is therefore a semantic no-op for this renderer, and it
//! removes the whole wasm-bindgen surface from the link.
//!
//! # What must stay true
//!
//! This crate only has to satisfy the API `dioxus-core` 0.7.10 actually uses:
//! `HotFn::current(..).call(..)`, `HotFn::ptr_address()`,
//! `get_jump_table()` and `register_handler()`. `get_jump_table` always
//! returns `None`, which is exactly the "no patch has been applied" state the
//! real crate reports in a normal (non-hot-reload) build, so every call site
//! takes its ordinary path.

use std::sync::Arc;

/// A table mapping pre-patch function addresses to post-patch ones. No patch
/// can ever be applied here, so this type is never constructed.
#[derive(Debug)]
pub struct JumpTable {
    _private: (),
}

/// Always `None`: no jump table is ever installed.
///
/// # Safety
///
/// Trivially safe here; `unsafe` matches the upstream signature.
pub unsafe fn get_jump_table() -> Option<&'static JumpTable> {
    None
}

/// Accepts and drops a hot-reload handler; nothing will ever invoke it.
pub fn register_handler(_handler: Arc<dyn Fn() + Send + Sync + 'static>) {}

/// A pointer to a (never) hot-patched function.
#[non_exhaustive]
#[derive(PartialEq, Eq, Hash, Clone, Copy, Debug)]
pub struct HotFnPtr(pub u64);

impl HotFnPtr {
    /// Create a new [`HotFnPtr`].
    ///
    /// # Safety
    ///
    /// The underlying `u64` must point to a valid function.
    pub unsafe fn new(index: u64) -> Self {
        Self(index)
    }
}

/// Call `f` directly. (Upstream would route through the jump table first.)
pub fn call<O>(mut f: impl FnMut() -> O) -> O {
    f()
}

/// A "hot-reloadable" function that is simply called in place.
pub struct HotFn<A, M, F>
where
    F: HotFunction<A, M>,
{
    inner: F,
    _marker: std::marker::PhantomData<(A, M)>,
}

impl<A, M, F: HotFunction<A, M>> HotFn<A, M, F> {
    /// Wrap `f`.
    pub const fn current(f: F) -> HotFn<A, M, F> {
        HotFn { inner: f, _marker: std::marker::PhantomData }
    }

    /// Call the wrapped function.
    pub fn call(&mut self, args: A) -> F::Return {
        self.inner.call_it(args)
    }

    /// The address of the function.
    ///
    /// Callers (dioxus-core `properties.rs`) use this only as a stable
    /// identity for memoization across patches. With no patching, the
    /// original address is stable forever, which is the strongest possible
    /// answer.
    pub fn ptr_address(&self) -> HotFnPtr {
        if size_of::<F>() == size_of::<fn() -> ()>() {
            let ptr: usize = unsafe { std::mem::transmute_copy(&self.inner) };
            return HotFnPtr(ptr as u64);
        }
        HotFnPtr(<F as HotFunction<A, M>>::call_it as *const () as u64)
    }
}

/// Types callable by [`HotFn`]: any `FnMut` of arity 0..=9, matching
/// upstream's `impl_hot_function!` list.
pub trait HotFunction<Args, Marker> {
    /// The return type of the function.
    type Return;
    /// The equivalent bare function-pointer type.
    type Real;

    /// Call with the argument tuple.
    fn call_it(&mut self, args: Args) -> Self::Return;

    /// Call through the jump table.
    ///
    /// # Safety
    ///
    /// Safe here (there is no jump table); `unsafe` matches upstream.
    unsafe fn call_as_ptr(&mut self, args: Args) -> Self::Return;
}

macro_rules! impl_hot_function {
    ($(($marker:ident, $($arg:ident),*)),* $(,)?) => {$(
        /// Marker type sealing the [`HotFunction`] impl for this arity.
        #[doc(hidden)]
        pub struct $marker;

        impl<T, $($arg,)* R> HotFunction<($($arg,)*), $marker> for T
        where
            T: FnMut($($arg),*) -> R,
        {
            type Return = R;
            type Real = fn($($arg),*) -> R;

            fn call_it(&mut self, args: ($($arg,)*)) -> Self::Return {
                #[allow(non_snake_case)]
                let ( $($arg,)* ) = args;
                self($($arg),*)
            }

            unsafe fn call_as_ptr(&mut self, args: ($($arg,)*)) -> Self::Return {
                self.call_it(args)
            }
        }
    )*};
}

impl_hot_function!(
    (Fn0Marker,),
    (Fn1Marker, A),
    (Fn2Marker, A, B),
    (Fn3Marker, A, B, C),
    (Fn4Marker, A, B, C, D),
    (Fn5Marker, A, B, C, D, E),
    (Fn6Marker, A, B, C, D, E, F),
    (Fn7Marker, A, B, C, D, E, F, G),
    (Fn8Marker, A, B, C, D, E, F, G, H),
    (Fn9Marker, A, B, C, D, E, F, G, H, I),
);
