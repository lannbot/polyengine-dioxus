// DOM applier for the polymorph:dioxus mutation schema (wit/world.wit's
// `interface mutations`, applied via operations.ts's `applyOperations`).
//
// DOM semantics (stack machine, node table, template cloning, path walking,
// setAttributeInner rules) are ported from dioxus-web's own interpreter
// (dioxus-core 0.7's web bindings — Apache-2.0/MIT dual licensed upstream:
// https://github.com/DioxusLabs/dioxus, `packages/web/src/js/core.ts` and
// `packages/interpreter/src/set_attribute.ts`, vendored here for reference
// as /tmp/opencode/dioxus-ref/{core,set_attribute}.ts at authoring time).
// The MUTATION SCHEMA is ours (wit/world.wit's `interface mutations`); only
// the DOM application rules are ported. Cited inline as `ref:core.ts:<line>`
// / `ref:set_attribute.ts:<line>`.

/** An interned string id (wit/world.wit `mutations.str-ref`, a u16),
 * defined by a prior `cache-string` operation. */
export type StrRef = number;

/** The recursive tree `operations.ts`'s `rehydrateTemplateArena` builds out
 * of a `register-template` operation's flat arena, for `OpSink.
 * registerTemplate` to consume. */
export type TemplateNodeDesc =
  | {
      kind: "element";
      tag: StrRef;
      ns: StrRef | null;
      attrs: { name: StrRef; ns: StrRef | null; value: string }[];
      children: TemplateNodeDesc[];
    }
  | { kind: "text"; value: string }
  | { kind: "dynamic" };

/** The sink `operations.ts`'s `applyOperations` drives — one method per
 * `mutations.operation` arm (wit/world.wit), `register-template`'s arena
 * already rehydrated into a `TemplateNodeDesc` tree. `DomApplier` is the
 * only implementor. */
export interface OpSink {
  cacheString(id: number, s: string): void;
  registerTemplate(tmpl: number, roots: TemplateNodeDesc[]): void;
  appendChildren(id: number, m: number): void;
  assignId(path: Uint8Array, id: number): void;
  createPlaceholder(id: number): void;
  createTextNode(id: number, text: string): void;
  loadTemplate(tmpl: number, root: number, id: number): void;
  replaceWith(id: number, m: number): void;
  replacePlaceholder(path: Uint8Array, m: number): void;
  insertAfter(id: number, m: number): void;
  insertBefore(id: number, m: number): void;
  setAttributeText(id: number, name: StrRef, ns: StrRef | null, value: string): void;
  setAttributeFloat(id: number, name: StrRef, ns: StrRef | null, value: number): void;
  setAttributeInt(id: number, name: StrRef, ns: StrRef | null, value: bigint): void;
  setAttributeBool(id: number, name: StrRef, ns: StrRef | null, value: boolean): void;
  setAttributeNone(id: number, name: StrRef, ns: StrRef | null): void;
  setText(id: number, text: string): void;
  newEventListener(id: number, name: StrRef, bubbles: boolean): void;
  removeEventListener(id: number, name: StrRef, bubbles: boolean): void;
  remove(id: number): void;
  pushRoot(id: number): void;
  hydrate(ids: number[]): void;
}

export interface ListenerDelegate {
  add(
    el: Element,
    elementId: number,
    nameId: number,
    name: string,
    bubbles: boolean,
  ): void;
  remove(
    el: Element,
    elementId: number,
    nameId: number,
    name: string,
    bubbles: boolean,
  ): void;
  /** Drop every registration for `elementId` — its element left the tree or
   * its id was reassigned. `el` is the OLD node. */
  purge(elementId: number, el: Node): void;
}

const NS_STYLE = "style";

// ref:set_attribute.ts:119 isBoolAttr — attribute names treated as boolean
// (present-if-truthy, removed-if-falsy) for the default attribute path.
const BOOL_ATTRS = new Set([
  "allowfullscreen",
  "allowpaymentrequest",
  "async",
  "autofocus",
  "autoplay",
  "checked",
  "controls",
  "default",
  "defer",
  "disabled",
  "formnovalidate",
  "hidden",
  "ismap",
  "itemscope",
  "loop",
  "multiple",
  "muted",
  "nomodule",
  "novalidate",
  "open",
  "playsinline",
  "readonly",
  "required",
  "reversed",
  "selected",
  "truespeed",
  "webkitdirectory",
]);

// ref:set_attribute.ts:115 truthy()
function truthy(val: string | boolean): boolean {
  return val === "true" || val === true;
}

// The exact comment markers `dioxus-ssr`'s `pre_render` writes for a dynamic
// text and a placeholder (dioxus-ssr-0.7.9 src/renderer.rs:189,215). Anchored
// so an unrelated comment cannot be misread as a marker.
const TEXT_MARKER = /^node-id(\d+)$/;
const PLACEHOLDER_MARKER = /^placeholder(\d+)$/;
const COMMENT_NODE = 8;

export class DomApplier implements OpSink {
  #doc: Document;
  #delegate: ListenerDelegate;
  #strings = new Map<StrRef, string>();
  // ref:core.ts:25-29 nodes/stack/templates
  #nodes: Node[] = [];
  #stack: Node[] = [];
  #templates = new Map<number, Node[]>();

  constructor(root: Element, delegate: ListenerDelegate) {
    this.#doc = root.ownerDocument as Document;
    this.#delegate = delegate;
    // id 0 is the mount root (wit: "id 0 is the mount root").
    this.#nodes = [root];
    this.#stack = [root];
  }

  // -- string table -----------------------------------------------------

  cacheString(id: number, s: string): void {
    this.#strings.set(id, s);
  }

  #str(id: StrRef): string {
    const s = this.#strings.get(id);
    if (s === undefined) {
      throw new Error(`DomApplier: unknown interned string id ${id}`);
    }
    return s;
  }

  #strOpt(id: StrRef | null): string | null {
    return id === null ? null : this.#str(id);
  }

  // -- node table helpers -------------------------------------------------

  #getNode(id: number): Node {
    const n = this.#nodes[id];
    if (n === undefined) {
      throw new Error(`DomApplier: unknown node id ${id}`);
    }
    return n;
  }

  /** Read-only lookup of the node currently bound to an ElementId, or
   * `undefined` when no node holds that id.
   *
   * This is the backing for the `dom` interface's element handles
   * (wit/world.wit `interface dom`): the guest's `MountedData` carries an
   * ElementId, and every host-side operation on it starts by resolving
   * that id here. A miss is legal and expected — ids are reused slab
   * indices, so a handle the app stashed can outlive its element — hence
   * `undefined` rather than the throwing `#getNode`. Deliberately narrow:
   * the node ARRAY stays private, so nothing outside can mutate the table
   * behind the applier's purge-on-reuse bookkeeping. */
  nodeFor(id: number): Node | undefined {
    return this.#nodes[id];
  }

  #setNode(id: number, node: Node): void {
    // Id reuse is the reliable unmount signal: dioxus frees an ElementId
    // before reassigning it, and never emits remove-event-listener ops for
    // an unmounted subtree. Purging the OLD node's registrations here is
    // what stops a reused id from inheriting the dead element's listener
    // names (and dispatching them at the new element).
    const old = this.#nodes[id];
    if (old !== undefined && old !== node) {
      this.#delegate.purge(id, old);
    }
    this.#nodes[id] = node;
  }

  // ref:core.ts:185-198 loadChild — walk a path from the current stack top
  // via firstChild/nextSibling, counting child indices at each level.
  #loadChild(path: Uint8Array): Node {
    let node: Node = this.#stack[this.#stack.length - 1];
    for (let i = 0; i < path.length; i++) {
      let end = path[i];
      node = node.firstChild as Node;
      for (; end > 0; end--) {
        node = node.nextSibling as Node;
      }
    }
    return node;
  }

  // -- template construction ----------------------------------------------

  registerTemplate(tmpl: number, roots: TemplateNodeDesc[]): void {
    const nodes = roots.map((r) => this.#buildTemplateNode(r));
    this.#templates.set(tmpl, nodes);
  }

  #buildTemplateNode(desc: TemplateNodeDesc): Node {
    switch (desc.kind) {
      case "element": {
        const tag = this.#str(desc.tag);
        const ns = this.#strOpt(desc.ns);
        const el = ns ? this.#doc.createElementNS(ns, tag) : this.#doc.createElement(tag);
        for (const attr of desc.attrs) {
          const name = this.#str(attr.name);
          const attrNs = this.#strOpt(attr.ns);
          this.#setAttributeInner(el, name, attr.value, attrNs);
        }
        for (const child of desc.children) {
          el.appendChild(this.#buildTemplateNode(child));
        }
        return el;
      }
      case "text":
        return this.#doc.createTextNode(desc.value);
      case "dynamic":
        // ref:core.ts placeholder nodes are comment nodes (createPlaceholder).
        return this.#doc.createComment("placeholder");
    }
  }

  // -- mutation ops --------------------------------------------------------

  appendChildren(id: number, m: number): void {
    // ref:core.ts:177-183 appendChildren
    const root = this.#getNode(id);
    const els = this.#stack.splice(this.#stack.length - m);
    for (const el of els) {
      root.appendChild(el);
    }
  }

  assignId(path: Uint8Array, id: number): void {
    const node = this.#loadChild(path);
    this.#setNode(id, node);
  }

  createPlaceholder(id: number): void {
    const node = this.#doc.createComment("placeholder");
    this.#setNode(id, node);
    this.#stack.push(node);
  }

  createTextNode(id: number, text: string): void {
    const node = this.#doc.createTextNode(text);
    this.#setNode(id, node);
    this.#stack.push(node);
  }

  loadTemplate(tmpl: number, root: number, id: number): void {
    const roots = this.#templates.get(tmpl);
    if (roots === undefined) {
      throw new Error(`DomApplier: unknown template id ${tmpl}`);
    }
    // ref:core.ts saveTemplate/loadTemplate — clone a detached template
    // root subtree, record it in the node table, and push it.
    const node = roots[root].cloneNode(true);
    this.#setNode(id, node);
    this.#stack.push(node);
  }

  replaceWith(id: number, m: number): void {
    const old = this.#getNode(id) as ChildNode;
    const els = this.#stack.splice(this.#stack.length - m);
    const parent = old.parentNode;
    if (parent) {
      for (const el of els) {
        parent.insertBefore(el, old);
      }
      parent.removeChild(old);
    }
  }

  replacePlaceholder(path: Uint8Array, m: number): void {
    // The m replacement nodes were pushed onto the stack after the template
    // root that `path` is relative to (dioxus emits their create ops
    // first); pop them off BEFORE walking `path` so loadChild sees the
    // template root, not one of the replacement nodes, as the stack top.
    const els = this.#stack.splice(this.#stack.length - m);
    const old = this.#loadChild(path) as ChildNode;
    const parent = old.parentNode;
    if (parent) {
      for (const el of els) {
        parent.insertBefore(el, old);
      }
      parent.removeChild(old);
    }
  }

  insertAfter(id: number, m: number): void {
    const node = this.#getNode(id) as ChildNode;
    const els = this.#stack.splice(this.#stack.length - m);
    const parent = node.parentNode;
    if (parent) {
      const next = node.nextSibling;
      for (const el of els) {
        parent.insertBefore(el, next);
      }
    }
  }

  insertBefore(id: number, m: number): void {
    const node = this.#getNode(id) as ChildNode;
    const els = this.#stack.splice(this.#stack.length - m);
    const parent = node.parentNode;
    if (parent) {
      for (const el of els) {
        parent.insertBefore(el, node);
      }
    }
  }

  #setAttributeInner(el: Element, field: string, value: string, ns: string | null): void {
    // ref:set_attribute.ts:4-102 setAttributeInner, ported verbatim rule by
    // rule; `node` there is typed HTMLElement, we take Element (works under
    // linkedom and covers SVG too since the reference itself falls through
    // to setAttributeNS for any non-null/non-style ns).
    if (ns === NS_STYLE) {
      // ref:set_attribute.ts:11-14
      (el as unknown as HTMLElement).style.setProperty(field, value);
      return;
    }
    if (ns) {
      // ref:set_attribute.ts:16-20
      el.setAttributeNS(ns, field, value);
      return;
    }
    switch (field) {
      case "value": {
        // ref:set_attribute.ts:24-36
        if (el.tagName === "OPTION") {
          this.#setAttributeDefault(el, field, value);
        } else {
          const anyEl = el as unknown as { value: string };
          if (anyEl.value !== value) {
            anyEl.value = value;
          }
        }
        break;
      }
      case "initial_value":
        // ref:set_attribute.ts:38-41
        (el as unknown as HTMLInputElement).defaultValue = value;
        break;
      case "checked":
        // ref:set_attribute.ts:43-46
        (el as unknown as HTMLInputElement).checked = truthy(value);
        break;
      case "initial_checked":
        // ref:set_attribute.ts:48-51
        (el as unknown as HTMLInputElement).defaultChecked = truthy(value);
        break;
      case "selected":
        // ref:set_attribute.ts:53-56
        (el as unknown as HTMLOptionElement).selected = truthy(value);
        break;
      case "initial_selected":
        // ref:set_attribute.ts:58-61
        (el as unknown as HTMLOptionElement).defaultSelected = truthy(value);
        break;
      case "dangerous_inner_html":
        // ref:set_attribute.ts:63-65
        el.innerHTML = value;
        break;
      case "style": {
        // ref:set_attribute.ts:67-84 — save existing inline styles, set the
        // raw style attribute string, then restore any styles it clobbered.
        const styleEl = el as unknown as HTMLElement;
        const existing: Record<string, string> = {};
        for (let i = 0; i < styleEl.style.length; i++) {
          const prop = styleEl.style[i as unknown as number] as unknown as string;
          existing[prop] = styleEl.style.getPropertyValue(prop);
        }
        el.setAttribute(field, value);
        for (const prop in existing) {
          if (!styleEl.style.getPropertyValue(prop)) {
            styleEl.style.setProperty(prop, existing[prop]);
          }
        }
        break;
      }
      case "multiple": {
        // ref:set_attribute.ts:86-97
        this.#setAttributeDefault(el, field, value);
        const selectEl = el as unknown as HTMLSelectElement;
        if (selectEl.options != null) {
          for (const option of Array.from(selectEl.options)) {
            option.selected = option.defaultSelected;
          }
        }
        break;
      }
      default:
        this.#setAttributeDefault(el, field, value);
    }
  }

  #setAttributeDefault(el: Element, field: string, value: string): void {
    // ref:set_attribute.ts:104-113
    if (!truthy(value) && BOOL_ATTRS.has(field)) {
      el.removeAttribute(field);
    } else {
      el.setAttribute(field, value);
    }
  }

  setAttributeText(id: number, name: StrRef, ns: StrRef | null, value: string): void {
    const el = this.#getNode(id) as Element;
    this.#setAttributeInner(el, this.#str(name), value, this.#strOpt(ns));
  }

  setAttributeFloat(id: number, name: StrRef, ns: StrRef | null, value: number): void {
    const el = this.#getNode(id) as Element;
    this.#setAttributeInner(el, this.#str(name), String(value), this.#strOpt(ns));
  }

  setAttributeInt(id: number, name: StrRef, ns: StrRef | null, value: bigint): void {
    const el = this.#getNode(id) as Element;
    // CONTRACT: the wit doc doesn't spell out int->string formatting beyond
    // "apply as string per the same rules"; we use String(bigint) (decimal,
    // no exponent, matches the golden-vector int encoding convention).
    this.#setAttributeInner(el, this.#str(name), String(value), this.#strOpt(ns));
  }

  setAttributeBool(id: number, name: StrRef, ns: StrRef | null, value: boolean): void {
    const el = this.#getNode(id) as Element;
    this.#setAttributeInner(el, this.#str(name), value ? "true" : "false", this.#strOpt(ns));
  }

  setAttributeNone(id: number, name: StrRef, ns: StrRef | null): void {
    const el = this.#getNode(id) as Element;
    const nsStr = this.#strOpt(ns);
    const field = this.#str(name);
    // wit: attrval none = "remove the attribute". Ported verbatim from the
    // `remove_attribute` sledgehammer op body (authority:
    // dioxus v0.7.10 packages/interpreter/src/unified_bindings.rs, the
    // `fn remove_attribute(id, field, ns)` case in `mod js`). That body
    // special-cases property-backed fields under the no-namespace arm before
    // falling back to plain `removeAttribute` — removeAttribute alone does
    // NOT reset a live input's `.value`/`.checked`/`.selected`/innerHTML
    // properties, so an explicit `None` must go through the same property
    // resets `setAttributeInner`'s truthy path uses, or a `value: None` after
    // a user has typed into the input silently fails to clear it.
    if (!nsStr) {
      switch (field) {
        case "value":
          (el as unknown as HTMLInputElement).value = "";
          el.removeAttribute("value");
          return;
        case "checked":
          (el as unknown as HTMLInputElement).checked = false;
          return;
        case "selected":
          (el as unknown as HTMLOptionElement).selected = false;
          return;
        case "dangerous_inner_html":
          el.innerHTML = "";
          return;
        default:
          el.removeAttribute(field);
          return;
      }
    }
    if (nsStr === NS_STYLE) {
      (el as unknown as HTMLElement).style.removeProperty(field);
      return;
    }
    el.removeAttributeNS(nsStr, field);
  }

  setText(id: number, text: string): void {
    const node = this.#getNode(id) as Text;
    node.textContent = text;
  }

  newEventListener(id: number, name: StrRef, bubbles: boolean): void {
    const el = this.#getNode(id) as Element;
    const nameStr = this.#str(name);
    this.#delegate.add(el, id, name, nameStr, bubbles);
  }

  removeEventListener(id: number, name: StrRef, bubbles: boolean): void {
    const el = this.#getNode(id) as Element;
    const nameStr = this.#str(name);
    this.#delegate.remove(el, id, name, nameStr, bubbles);
  }

  remove(id: number): void {
    const node = this.#getNode(id) as ChildNode;
    // The guest never synthesizes listener-remove ops for an unmounted
    // subtree (mirroring the reference, where removeAllNonBubblingListeners
    // is a hydration/GC path only). Staleness is instead bounded from both
    // ends: an explicit `remove` is the early signal for THIS id, and
    // `#setNode`'s purge-on-reuse catches every descendant id. Descendant
    // registrations therefore linger in the dispatcher's maps only until
    // dioxus reuses their ids, and can never mis-dispatch — a reused id is
    // purged before the new node is recorded, and until then no live DOM
    // node carries that `data-dioxus-id` for target resolution to find.
    this.#delegate.purge(id, node);
    node.parentNode?.removeChild(node);
  }

  pushRoot(id: number): void {
    // ref:core.ts:173-175 pushRoot
    this.#stack.push(this.#getNode(id));
  }

  // -- hydration ------------------------------------------------------------
  //
  // ref:core.ts:204-291 hydrate_node/hydrate, ported with three deliberate
  // divergences (see wit/world.wit's `hydrate` type doc, which is normative
  // for the first two):
  //  1. the element marker's `,click:1,...` suffix is IGNORED here — no
  //     listener is attached and no `data-dioxus-id` is set; listener
  //     registrations arrive as ordinary `new-event-listener` ops later in
  //     the same batch (the only form carrying the interned name id
  //     `ListenerDelegate` needs), so `EventDispatcher.add` sets
  //     `data-dioxus-id` when that op arrives, same as on a fresh mount.
  //  2. every index is validated (wit/world.wit's hydrate doc: "the host
  //     reports it rather than binding a wrong node") instead of upstream's
  //     unchecked `ids[parseInt(...)]`.
  //  3. upstream's TreeWalker loop is contorted because it mutates the DOM
  //     (removing marker comments, inserting text nodes) WHILE walking.
  //     Since each marker carries its own index, visit order cannot affect
  //     correctness here, so we collect every comment node first (a single
  //     non-mutating walk) and process the collected list after — much
  //     simpler than threading `continueToNextNode`/`nextSibling` bookkeeping
  //     through a concurrent mutation.
  hydrate(ids: number[]): void {
    const root = this.#nodes[0] as Element;
    // Which of ids[0..ids.length) has been matched by a marker so far, so
    // "unmatched" and "duplicate" can both be detected after the walk.
    const matched = new Uint8Array(ids.length);

    const checkIndex = (n: number, source: string): void => {
      if (!Number.isInteger(n) || n < 0 || n >= ids.length) {
        throw new Error(
          `DomApplier.hydrate: marker index ${n} (${source}) is out of range for ${ids.length} id(s)`,
        );
      }
      if (matched[n] !== 0) {
        throw new Error(`DomApplier.hydrate: marker index ${n} (${source}) is duplicated`);
      }
      matched[n] = 1;
    };

    // -- element markers: data-node-hydration="n[,event:bubbles]..." -------
    // ref:core.ts:225-232 hydrate's `under instanceof HTMLElement` branch,
    // minus the querySelectorAll/self split (querySelectorAll doesn't match
    // the root itself, so upstream checks it separately; a single selector
    // rooted one level up isn't available to us either, so keep that split).
    const elementMarkers: Element[] = [];
    if (root.hasAttribute("data-node-hydration")) elementMarkers.push(root);
    for (const el of Array.from(root.querySelectorAll("[data-node-hydration]"))) {
      elementMarkers.push(el);
    }
    for (const el of elementMarkers) {
      const marker = el.getAttribute("data-node-hydration")!;
      // ref:core.ts:206-207 — only the leading index; the rest (listener
      // suffix) is divergence (1) above, deliberately unread.
      const n = parseInt(marker.split(",")[0], 10);
      checkIndex(n, `element marker "${marker}"`);
      this.#setNode(ids[n], el);
    }

    // -- comment markers: <!--node-idN-->text<!--#--> / <!--placeholderN--> -
    // 0x80 is NodeFilter.SHOW_COMMENT's numeric value. `NodeFilter` itself
    // is a DOM global linkedom does not define (createTreeWalker works
    // against comments there, only the NodeFilter object is missing) — the
    // mask is spec-stable (DOM Standard §NodeFilter), so passing it
    // literally works identically under linkedom and a real browser.
    const SHOW_COMMENT = 0x80;
    const walker = this.#doc.createTreeWalker(root, SHOW_COMMENT);
    const comments: Comment[] = [];
    let cur = walker.nextNode();
    while (cur) {
      comments.push(cur as unknown as Comment);
      cur = walker.nextNode();
    }

    for (const comment of comments) {
      const text = comment.textContent ?? "";
      // Anchored, unlike upstream's `text.split("placeholder")` /
      // `text.split("node-id")`: those match the marker word ANYWHERE in a
      // comment, so an unrelated comment in the served markup would be read
      // as a marker. Since we then validate indices, that misread would
      // surface as a spurious duplicate/out-of-range error rather than
      // upstream's silent misbinding — a strictly worse failure, so match
      // the exact forms `pre_render` writes instead
      // (dioxus-ssr-0.7.9 src/renderer.rs:189,215).
      const placeholder = PLACEHOLDER_MARKER.exec(text);
      if (placeholder) {
        const n = parseInt(placeholder[1], 10);
        checkIndex(n, `placeholder marker "${text}"`);
        this.#setNode(ids[n], comment);
        continue;
      }
      const textMarker = TEXT_MARKER.exec(text);
      if (textMarker) {
        const n = parseInt(textMarker[1], 10);
        checkIndex(n, `text marker "${text}"`);
        // ref:core.ts:281-291 — an empty dynamic text serializes as two
        // adjacent comments with no text node between them; create one for
        // the id to bind to. Otherwise the next sibling is the real text.
        //
        // The closing `<!--#-->` is located and checked BEFORE anything is
        // bound or removed: `pre_render` always closes a dynamic text, so
        // its absence (including a marker that is the last child of its
        // parent) means the markup is not what this component rendered.
        // Binding first would leave a wrong entry in the node table on the
        // way to the error, and removing whatever happened to follow would
        // corrupt the document.
        const isClosing = (node: Node | null): node is Comment =>
          node !== null && node.nodeType === COMMENT_NODE && node.textContent === "#";
        const next = comment.nextSibling;
        let textNode: Node;
        let closing: Comment;
        if (isClosing(next)) {
          closing = next;
          textNode = this.#doc.createTextNode("");
          comment.parentNode!.insertBefore(textNode, closing);
        } else if (next !== null && next.nodeType !== COMMENT_NODE && isClosing(next.nextSibling)) {
          textNode = next;
          closing = next.nextSibling as Comment;
        } else {
          throw new Error(
            `DomApplier.hydrate: text marker "${text}" is not closed by <!--#-->`,
          );
        }
        this.#setNode(ids[n], textNode);
        // Consume both markers (ref:core.ts's `currentNode.remove()` /
        // `commentAfterText.remove()`); the closing one carries no index.
        closing.parentNode?.removeChild(closing);
        comment.parentNode?.removeChild(comment);
      }
    }

    for (let n = 0; n < ids.length; n++) {
      if (matched[n] === 0) {
        throw new Error(`DomApplier.hydrate: marker index ${n} was never matched by any marker`);
      }
    }
  }
}
