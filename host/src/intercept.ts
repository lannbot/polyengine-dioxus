// Interceptors: the embedder's hook into every host-implemented import.
//
// Each import fragment (`createDomImports`, `createEvalImports`,
// `createHeadImports`, `createHistoryImports`) builds the DEFAULT behavior.
// `MountOptions.intercept` lets the embedder wrap any operation of any of
// them with a function of the shape `(next, ...args) => result`: call `next`
// to get the default (with the same or rewritten arguments), skip it to
// replace the behavior, or answer the operation's denial value to refuse.
// polyvisor uses this to make policy per call — allowlisting eval scripts
// by hash, prefixing titles, refusing `external` navigation — without a
// second WIT surface for policy: the WIT stays one fixed protocol per
// capability, and policy lives here, in trusted embedder code.
//
// Rules, enforced or documented:
//
// - TYPED PER OPERATION. The interceptor map mirrors each fragment's import
//   table type, so a sync WIT function cannot be given an interceptor that
//   returns a Promise (the runtime would treat that as a JSPI park request
//   for a sync import and refuse it), and argument/return shapes are
//   checked at compile time.
// - DENIAL HAS ONE SPELLING PER RETURN TYPE, from the WIT: a `bool` command
//   answers `false`, an `option` query answers `undefined`, `eval` answers
//   the `denied` error case (`evalDenied()` below). The guest maps each
//   onto the graceful dioxus path (a `false` head write is silently not
//   there; `denied` eval is `EvalError::Unsupported`). Denial degrades,
//   never traps.
// - THE GATE BRACKET IS OUTSIDE THE INTERCEPTOR. Each fragment takes its
//   interceptors as a constructor argument and applies `wrap` to its
//   UNBRACKETED implementations, then puts the `DispatchGate`
//   `beginApply/endApply` bracket (dom's mutating ops, eval's synchronous
//   prefix, head's writes) around the wrapped result — so an interceptor
//   that mutates the DOM is still inside the reentrancy bracket and never
//   enters the guest. `host.ts` never wraps a finished table itself.
// - THROWING FROM AN INTERCEPTOR IS A HOST BUG. An unbranded throw from a
//   host import is a trap (contracts/embedder-api.md "Error model"), and an
//   interceptor is host code. "Throw means deny" is NOT implied; an
//   embedder wanting fail-closed wraps its predicate itself.
// - INTERCEPTORS DO NOT GRANT. `intercept.eval` on a mount without
//   `eval: true` is a configuration error `mountApp` throws on, not a way
//   in: the import's absence is the security boundary, interception is
//   policy within a granted capability.

/** An interceptor for one import: receives the default implementation as
 * `next` plus the call's arguments, returns what the import returns. */
// deno-lint-ignore no-explicit-any
export type Interceptor<F extends (...args: any[]) => any> = (
  next: F,
  ...args: Parameters<F>
) => ReturnType<F>;

/** The interceptor map for one fragment: any subset of its operations. */
// deno-lint-ignore no-explicit-any
export type Interceptors<T extends Record<string, (...args: any[]) => any>> = {
  [K in keyof T]?: Interceptor<T[K]>;
};

/**
 * Apply `interceptors` over `table`, returning a table of the same type in
 * which each intercepted operation calls its interceptor with the original
 * as `next`. Operations without an interceptor pass through untouched
 * (same function identity). `table`'s functions must not depend on `this`.
 */
// deno-lint-ignore no-explicit-any
export function wrap<T extends Record<string, (...args: any[]) => any>>(
  table: T,
  interceptors: Interceptors<T> | undefined,
): T {
  if (!interceptors) return table;
  const out: Record<string, unknown> = { ...table };
  for (const key of Object.keys(interceptors) as Array<keyof T & string>) {
    const interceptor = interceptors[key];
    if (!interceptor) continue;
    if (!(key in table)) {
      throw new Error(`intercept: no such operation '${key}'`);
    }
    const next = table[key];
    out[key] = (...args: Parameters<T[typeof key]>) => interceptor(next, ...args);
  }
  return out as T;
}
