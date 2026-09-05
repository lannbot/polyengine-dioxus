// Host side of `polymorph:dioxus/history` (wit/world.wit, `interface
// history`) — navigation history backing dioxus-router's `History` trait.
// Routes are abstract strings; how they meet the real browser location is
// the `HistoryProvider` implementation (`memoryHistory` / `fragmentHistory`
// below), chosen by `MountOptions.history` (host.ts).
//
// Only the guest-facing import table is interceptable
// (`MountOptions.intercept.history`) — the `HistoryProvider` itself is
// trusted host wiring, same split as `createDomImports`'s applier vs. its
// import table.

import { closedChannel, OutChannel } from "./channel.ts";
import { type Interceptors, wrap } from "./intercept.ts";

/** What a host needs to answer `polymorph:dioxus/history` for one mount.
 * `current`/`prefix`/`canBack`/`canForward` are queried on every call
 * (dioxus-router re-renders off them); `onChange` is called at most once,
 * per wit/world.wit's `changes` doc ("at most one call per instance"). */
export interface HistoryProvider {
  current(): string;
  prefix(): string | undefined;
  canBack(): boolean;
  canForward(): boolean;
  back(): void;
  forward(): void;
  push(route: string): void;
  replace(route: string): void;
  external(url: string): boolean;
  /** Called at most once; the host notifies external (non-guest-initiated)
   * moves through `emit`. */
  onChange(emit: (route: string) => void): void;
}

/**
 * An in-memory history stack: a `back()`/`forward()` an embedder or test
 * can drive directly (`Mounted.history`, host.ts), with no browser
 * involved. `push`/`replace` don't emit (the guest asked, so the guest
 * already knows); `back`/`forward` DO emit, since from the guest's side
 * these are exactly the "host moved without the guest asking" case
 * `changes` exists for — the wit's example itself is "the back button".
 * `external` always refuses: there is no page to navigate away to.
 */
export function memoryHistory(initial = "/"): HistoryProvider {
  const stack: string[] = [initial];
  let index = 0;
  let emit: ((route: string) => void) | undefined;

  return {
    current: () => stack[index],
    prefix: () => undefined,
    canBack: () => index > 0,
    canForward: () => index < stack.length - 1,
    back() {
      if (index === 0) return;
      index--;
      emit?.(stack[index]);
    },
    forward() {
      if (index === stack.length - 1) return;
      index++;
      emit?.(stack[index]);
    },
    push(route: string) {
      stack.length = index + 1; // drop any forward history
      stack.push(route);
      index++;
    },
    replace(route: string) {
      stack[index] = route;
    },
    external: () => false,
    onChange(cb) {
      emit = cb;
    },
  };
}

/** The document's URL fragment as the route encoding — the shape for a
 * host that does not own the path (polyvisor's apps). `route` is
 * `location.hash.slice(1) || "/"`. `canBack`/`canForward` are not knowable
 * from the browser (there is no API to ask "is there a back entry"), so
 * both answer `true` unconditionally — dioxus-web's `WebHistory` does the
 * same (its `can_go_back`/`can_go_forward` are hardcoded `true`; see
 * dioxus-history/src/history.rs upstream for the same shrug). */
export function fragmentHistory(win: Window): HistoryProvider {
  const route = () => win.location.hash.slice(1) || "/";

  return {
    current: route,
    prefix: () => undefined,
    canBack: () => true,
    canForward: () => true,
    back() {
      win.history.back();
    },
    forward() {
      win.history.forward();
    },
    push(route: string) {
      win.history.pushState(null, "", "#" + route);
    },
    replace(route: string) {
      win.history.replaceState(null, "", "#" + route);
    },
    external(url: string): boolean {
      win.location.assign(url);
      return true;
    },
    onChange(emit) {
      win.addEventListener("popstate", () => emit(route()));
    },
  };
}

export interface HistoryImports {
  currentRoute(): string;
  currentPrefix(): string | undefined;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  push(route: string): boolean;
  replace(route: string): boolean;
  external(url: string): boolean;
  changes(): AsyncIterable<string>;
  // deno-lint-ignore no-explicit-any
  [key: string]: (...args: any[]) => any;
}

/**
 * Build the host side of `polymorph:dioxus/history` over a `HistoryProvider`.
 *
 * No gate bracket: unlike `dom`/`head`, none of these ops fire a delegated
 * DOM event synchronously — `popstate` (the one event a provider might
 * raise) is a WINDOW event, not one the applier delegates, so there is no
 * reentrancy hazard to bracket against (wit/world.wit `history` doc; see
 * intercept.ts's header for the bracket rule this is exempt from and why).
 */
export function createHistoryImports(
  provider: HistoryProvider,
  interceptors?: Interceptors<HistoryImports>,
) {
  let changesCalled = false;

  const impls: HistoryImports = {
    currentRoute: () => provider.current(),
    currentPrefix: () => provider.prefix(),
    canGoBack: () => provider.canBack(),
    canGoForward: () => provider.canForward(),
    goBack: () => provider.back(),
    goForward: () => provider.forward(),
    push(route: string): boolean {
      provider.push(route);
      return true;
    },
    replace(route: string): boolean {
      provider.replace(route);
      return true;
    },
    external: (url: string) => provider.external(url),
    changes(): AsyncIterable<string> {
      // wit: "at most one call per instance; a second returns a stream
      // that closes immediately."
      if (changesCalled) return closedChannel<string>();
      changesCalled = true;
      const out = new OutChannel<string>();
      provider.onChange((route) => out.push(route));
      return out;
    },
  };

  return wrap(impls, interceptors);
}
