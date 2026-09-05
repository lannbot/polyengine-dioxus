// Host side of `polymorph:dioxus/head` (wit/world.wit, `interface head`) —
// the document's `<head>` and title, backing dioxus's `document::Title`,
// `Meta`, `Link`, `Style` and `Script`. Split out as a factory (matching
// `createDomImports`/`createEvalImports`) so it can be unit-tested against
// a bare linkedom `Document` (host/tests/head_test.ts).
//
// Interceptor wiring follows host/src/intercept.ts's "gate bracket is
// outside the interceptor" rule: `wrap` runs over the unbracketed impl
// table, and the gate's beginApply/endApply bracket goes around the
// (possibly-wrapped) result, so an interceptor that itself writes DOM is
// still inside the reentrancy bracket.

import type { DispatchGate } from "./dispatch.ts";
import { type Interceptors, wrap } from "./intercept.ts";

/** WIT `head.create-element`'s `attributes: list<tuple<string, string>>`
 * lifts as `[string, string][]` (contract:"Value mapping", `list<tuple>`
 * despecialization row). */
type Attributes = [string, string][];

export interface HeadImports {
  setTitle(title: string): boolean;
  createElement(tag: string, attributes: Attributes, contents: string | undefined): boolean;
  // deno-lint-ignore no-explicit-any
  [key: string]: (...args: any[]) => any;
}

/**
 * Build the host side of `polymorph:dioxus/head` over `doc` and a dispatch
 * gate.
 *
 * `opts.allowScript` gates the one case wit/world.wit calls out explicitly:
 * "The default host refuses `script` unless the mount also granted `eval`
 * — a script tag is eval by another name." The caller (host.ts) computes
 * this as `!!opts.eval`, so it is one MountOptions knob, not two.
 */
export function createHeadImports(
  doc: Document,
  gate: DispatchGate,
  opts: { allowScript: boolean },
  interceptors?: Interceptors<HeadImports>,
) {
  const impls: HeadImports = {
    setTitle(title: string): boolean {
      doc.title = title;
      return true;
    },

    createElement(tag: string, attributes: Attributes, contents: string | undefined): boolean {
      // wit doc, normative: a script tag is eval by another name.
      if (tag === "script" && !opts.allowScript) return false;
      if (doc.head === null) return false;
      const el = doc.createElement(tag);
      for (const [name, value] of attributes) {
        el.setAttribute(name, value);
      }
      if (contents !== undefined) el.textContent = contents;
      doc.head.appendChild(el);
      return true;
    },
  };

  const wrapped = wrap(impls, interceptors);

  // Both ops are DOM writes: a head write (contrasted with e.g. an
  // ordinary DOM append) fires nothing in linkedom, but a real browser
  // can fire load/error events for `<link>`/`<script>` insertion — cheap
  // and consistent to bracket both the same way `dom`'s mutating ops are
  // (host.ts's `command`).
  return {
    setTitle(title: string): boolean {
      gate.beginApply();
      try {
        return wrapped.setTitle(title);
      } finally {
        gate.endApply();
      }
    },
    createElement(tag: string, attributes: Attributes, contents: string | undefined): boolean {
      gate.beginApply();
      try {
        return wrapped.createElement(tag, attributes, contents);
      } finally {
        gate.endApply();
      }
    },
  };
}
