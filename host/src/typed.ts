// Typed-channel applier for the polymorph:dioxus explicit WIT mutation
// schema (`interface mutations` / `stream<operation>`, wit/world.wit).
//
// This is the typed counterpart of decoder.ts's `decodeBatch`: instead of
// decoding a byte format, it walks already-lifted `operation` values (as
// polyengine's embedder lifts them per .deps/polyengine/contracts/
// embedder-api.md "Value mapping") and drives the same `OpSink`.

import type { OpSink, StrRef, TemplateNodeDesc } from "./decoder.ts";

// -- lifted-value shapes ----------------------------------------------------
//
// contract:"Value mapping" — variant -> { kind, value? }, record -> plain
// object with camelCased fields, option<T> as a record field -> absent when
// none / bare T when some, list<u8> -> Uint8Array, list<u32> -> number[],
// s64 -> bigint, f64/u32/u16 -> number, bool -> boolean, string -> string.

interface TemplateAttrLifted {
  name: StrRef;
  ns?: StrRef;
  value: string;
}

interface TemplateElementLifted {
  tag: StrRef;
  ns?: StrRef;
  attrs: TemplateAttrLifted[];
  children: number[];
}

type TemplateNodeLifted =
  | { kind: "element"; value: TemplateElementLifted }
  | { kind: "text"; value: string }
  | { kind: "dynamic" };

interface RegisterTemplateLifted {
  id: number;
  nodes: TemplateNodeLifted[];
  roots: number[];
}

interface StackOpLifted {
  id: number;
  m: number;
}
interface PathOpLifted {
  path: Uint8Array;
  m: number;
}
interface AssignIdLifted {
  path: Uint8Array;
  id: number;
}
interface CreateTextNodeLifted {
  id: number;
  text: string;
}
interface LoadTemplateLifted {
  id: number;
  tmpl: number;
  root: number;
}
interface SetTextLifted {
  id: number;
  text: string;
}

type AttrValueLifted =
  | { kind: "text"; value: string }
  | { kind: "float"; value: number }
  | { kind: "int"; value: bigint }
  | { kind: "boolean"; value: boolean }
  | { kind: "none" };

interface SetAttributeLifted {
  id: number;
  name: StrRef;
  ns?: StrRef;
  value: AttrValueLifted;
}

interface EventListenerLifted {
  id: number;
  name: StrRef;
  bubbles: boolean;
}

interface CacheStringLifted {
  id: number;
  str: string;
}

/** One lifted `operation` variant value. */
export type OperationLifted =
  | { kind: "cache-string"; value: CacheStringLifted }
  | { kind: "register-template"; value: RegisterTemplateLifted }
  | { kind: "append-children"; value: StackOpLifted }
  | { kind: "assign-id"; value: AssignIdLifted }
  | { kind: "create-placeholder"; value: number }
  | { kind: "create-text-node"; value: CreateTextNodeLifted }
  | { kind: "load-template"; value: LoadTemplateLifted }
  | { kind: "replace-with"; value: StackOpLifted }
  | { kind: "replace-placeholder"; value: PathOpLifted }
  | { kind: "insert-after"; value: StackOpLifted }
  | { kind: "insert-before"; value: StackOpLifted }
  | { kind: "set-attribute"; value: SetAttributeLifted }
  | { kind: "set-text"; value: SetTextLifted }
  | { kind: "new-event-listener"; value: EventListenerLifted }
  | { kind: "remove-event-listener"; value: EventListenerLifted }
  | { kind: "remove"; value: number }
  | { kind: "push-root"; value: number };

/**
 * Rehydrate a `register-template` arena (`nodes` flat pre-order list,
 * `roots`/`template-element.children` are `u32` indices into it — WIT
 * forbids the natural recursive shape, see wit/world.wit's `mutations`
 * interface doc) into the recursive `TemplateNodeDesc` tree `OpSink.
 * registerTemplate` wants.
 *
 * The arena admits index graphs the byte grammar cannot express. Two are
 * rejected outright, with a thrown Error rather than a hang or a silently
 * wrong tree: an out-of-range index, and a cycle (a node that (transitively)
 * indexes itself as a child — `state[idx] === 1` below, "on the current
 * build path"). A THIRD shape is accepted rather than rejected: a DAG, where
 * one node index is reachable as a child from two different parents. That
 * is not a cycle (the build terminates), and the `built` memo below makes
 * it safe — `build(idx)` is memoized once `state[idx] === 2`, so a
 * DAG-shared node is built once and the resulting `TemplateNodeDesc` object
 * is aliased into both parents' `children` arrays, rather than double-built
 * or refused. `DomApplier.registerTemplate` only reads the desc tree to
 * construct fresh DOM nodes per visit (never mutates or identity-compares
 * the desc objects), so an aliased subtree is indistinguishable from two
 * independently-built ones to every consumer.
 */
function rehydrateTemplateArena(nodes: TemplateNodeLifted[], roots: number[]): TemplateNodeDesc[] {
  // 0 = unvisited, 1 = on the current path (cycle detection), 2 = done.
  const state = new Uint8Array(nodes.length);
  const built: (TemplateNodeDesc | undefined)[] = new Array(nodes.length);

  function build(idx: number): TemplateNodeDesc {
    if (idx < 0 || idx >= nodes.length) {
      throw new Error(`applyTyped: register-template arena index ${idx} out of range (${nodes.length} nodes)`);
    }
    if (state[idx] === 1) {
      throw new Error(`applyTyped: register-template arena has a cycle at index ${idx}`);
    }
    if (state[idx] === 2) {
      return built[idx]!;
    }
    state[idx] = 1;
    const n = nodes[idx];
    let desc: TemplateNodeDesc;
    switch (n.kind) {
      case "element": {
        const el = n.value;
        desc = {
          kind: "element",
          tag: el.tag,
          ns: el.ns ?? null,
          attrs: el.attrs.map((a) => ({ name: a.name, ns: a.ns ?? null, value: a.value })),
          children: el.children.map(build),
        };
        break;
      }
      case "text":
        desc = { kind: "text", value: n.value };
        break;
      case "dynamic":
        desc = { kind: "dynamic" };
        break;
    }
    state[idx] = 2;
    built[idx] = desc;
    return desc;
  }

  return roots.map(build);
}

/** Apply a batch of lifted `operation` values to `sink` — the typed
 * counterpart of `decodeBatch`. */
export function applyTyped(ops: OperationLifted[], sink: OpSink): void {
  for (const op of ops) {
    switch (op.kind) {
      case "cache-string":
        sink.cacheString(op.value.id, op.value.str);
        break;
      case "register-template": {
        const { id, nodes, roots } = op.value;
        sink.registerTemplate(id, rehydrateTemplateArena(nodes, roots));
        break;
      }
      case "append-children":
        sink.appendChildren(op.value.id, op.value.m);
        break;
      case "assign-id":
        sink.assignId(op.value.path, op.value.id);
        break;
      case "create-placeholder":
        sink.createPlaceholder(op.value);
        break;
      case "create-text-node":
        sink.createTextNode(op.value.id, op.value.text);
        break;
      case "load-template":
        sink.loadTemplate(op.value.tmpl, op.value.root, op.value.id);
        break;
      case "replace-with":
        sink.replaceWith(op.value.id, op.value.m);
        break;
      case "replace-placeholder":
        sink.replacePlaceholder(op.value.path, op.value.m);
        break;
      case "insert-after":
        sink.insertAfter(op.value.id, op.value.m);
        break;
      case "insert-before":
        sink.insertBefore(op.value.id, op.value.m);
        break;
      case "set-attribute": {
        const { id, name, ns, value } = op.value;
        const nsResolved = ns ?? null;
        switch (value.kind) {
          case "text":
            sink.setAttributeText(id, name, nsResolved, value.value);
            break;
          case "float":
            sink.setAttributeFloat(id, name, nsResolved, value.value);
            break;
          case "int":
            sink.setAttributeInt(id, name, nsResolved, value.value);
            break;
          case "boolean":
            sink.setAttributeBool(id, name, nsResolved, value.value);
            break;
          case "none":
            sink.setAttributeNone(id, name, nsResolved);
            break;
        }
        break;
      }
      case "set-text":
        sink.setText(op.value.id, op.value.text);
        break;
      case "new-event-listener":
        sink.newEventListener(op.value.id, op.value.name, op.value.bubbles);
        break;
      case "remove-event-listener":
        sink.removeEventListener(op.value.id, op.value.name, op.value.bubbles);
        break;
      case "remove":
        sink.remove(op.value);
        break;
      case "push-root":
        sink.pushRoot(op.value);
        break;
      default: {
        const _exhaustive: never = op;
        throw new Error(`applyTyped: unknown operation "${(_exhaustive as { kind: string }).kind}"`);
      }
    }
  }
}
