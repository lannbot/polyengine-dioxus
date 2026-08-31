// DOM applier for the polymorph:dioxus mutation wire format.
//
// DOM semantics (stack machine, node table, template cloning, path walking,
// setAttributeInner rules) are ported from dioxus-web's own interpreter
// (dioxus-core 0.7's web bindings — Apache-2.0/MIT dual licensed upstream:
// https://github.com/DioxusLabs/dioxus, `packages/web/src/js/core.ts` and
// `packages/interpreter/src/set_attribute.ts`, vendored here for reference
// as /tmp/opencode/dioxus-ref/{core,set_attribute}.ts at authoring time).
// The BYTE FORMAT is ours (see decoder.ts / wit/world.wit); only the DOM
// application rules are ported. Cited inline as `ref:core.ts:<line>` /
// `ref:set_attribute.ts:<line>`.

import type { OpSink, StrRef, TemplateNodeDesc } from "./decoder.ts";

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

  #setNode(id: number, node: Node): void {
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
    // v1: removal does not synthesize listener-remove callbacks, mirroring
    // the reference (removeAllNonBubblingListeners is only called from
    // hydration/GC paths there, not from a generic `remove` op).
    node.parentNode?.removeChild(node);
  }

  pushRoot(id: number): void {
    // ref:core.ts:173-175 pushRoot
    this.#stack.push(this.#getNode(id));
  }
}
