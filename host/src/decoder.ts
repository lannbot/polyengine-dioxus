// Decoder for the polymorph:dioxus mutation wire format.
//
// The wire format is normative in wit/world.wit (interface `surface`, doc
// comments on the opcode table, framing, and primitive operand encodings).
// This file implements the "op segment" decoder (decodeBatch) plus the
// stream-transport framing layer (FrameDecoder). See wit/world.wit for the
// authoritative byte layout; cited inline as `wit:<section>`.

export type StrRef = number; // u16 interned id

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
  newEventListener(id: number, name: StrRef): void;
  removeEventListener(id: number, name: StrRef): void;
  remove(id: number): void;
  pushRoot(id: number): void;
}

// Opcodes — wit/world.wit "# Opcodes" table.
const OP_CACHE_STRING = 0x01;
const OP_REGISTER_TEMPLATE = 0x02;
const OP_APPEND_CHILDREN = 0x03;
const OP_ASSIGN_ID = 0x04;
const OP_CREATE_PLACEHOLDER = 0x05;
const OP_CREATE_TEXT_NODE = 0x06;
const OP_LOAD_TEMPLATE = 0x07;
const OP_REPLACE_WITH = 0x08;
const OP_REPLACE_PLACEHOLDER = 0x09;
const OP_INSERT_AFTER = 0x0a;
const OP_INSERT_BEFORE = 0x0b;
const OP_SET_ATTRIBUTE = 0x0c;
const OP_SET_TEXT = 0x0d;
const OP_NEW_EVENT_LISTENER = 0x0e;
const OP_REMOVE_EVENT_LISTENER = 0x0f;
const OP_REMOVE = 0x10;
const OP_PUSH_ROOT = 0x11;

// attrval kinds — wit/world.wit set-attribute op.
const ATTR_TEXT = 0x00;
const ATTR_FLOAT = 0x01;
const ATTR_INT = 0x02;
const ATTR_BOOL = 0x03;
const ATTR_NONE = 0x04;

// register-template node kinds — wit/world.wit register-template op.
const NODE_ELEMENT = 0x00;
const NODE_TEXT = 0x01;
const NODE_DYNAMIC = 0x02;

const NONE_STRREF = 0xffff;

/**
 * Cursor over one batch's op segment + string segment. Strings are sliced
 * sequentially by UTF-16 code-unit length off of `strings` (never a
 * per-string TextDecoder call — wit "string segment" doc says the whole
 * segment is decoded in one pass by the caller/FrameDecoder).
 */
class Cursor {
  view: DataView;
  bytes: Uint8Array;
  off = 0;
  strings: string;
  strOff = 0;

  constructor(ops: Uint8Array, strings: string) {
    this.bytes = ops;
    this.view = new DataView(ops.buffer, ops.byteOffset, ops.byteLength);
    this.strings = strings;
  }

  u8(): number {
    const v = this.view.getUint8(this.off);
    this.off += 1;
    return v;
  }
  u16(): number {
    const v = this.view.getUint16(this.off, true);
    this.off += 2;
    return v;
  }
  u32(): number {
    const v = this.view.getUint32(this.off, true);
    this.off += 4;
    return v;
  }
  s64(): bigint {
    const v = this.view.getBigInt64(this.off, true);
    this.off += 8;
    return v;
  }
  f64(): number {
    const v = this.view.getFloat64(this.off, true);
    this.off += 8;
    return v;
  }

  /** strref: u16, 0xffff = none (wit "Primitive operand encodings"). */
  strref(): StrRef | null {
    const v = this.u16();
    return v === NONE_STRREF ? null : v;
  }

  /** path: u8 length, then that many u8 child indices. */
  path(): Uint8Array {
    const len = this.u8();
    const p = this.bytes.subarray(this.off, this.off + len);
    this.off += len;
    return p;
  }

  /**
   * dynstr: u16 UTF-16 code-unit length, then (iff 0xffff) u32 actual
   * length. Content is the next `length` code units of the decoded string
   * segment, consumed sequentially (wit "Primitive operand encodings").
   */
  dynstr(): string {
    let len = this.u16();
    if (len === 0xffff) {
      len = this.u32();
    }
    const s = this.strings.substring(this.strOff, this.strOff + len);
    this.strOff += len;
    return s;
  }
}

function decodeTemplateNode(c: Cursor): TemplateNodeDesc {
  const kind = c.u8();
  switch (kind) {
    case NODE_ELEMENT: {
      const tag = c.u16();
      const ns = c.strref();
      const nattrs = c.u16();
      const attrs: { name: StrRef; ns: StrRef | null; value: string }[] = [];
      for (let i = 0; i < nattrs; i++) {
        const name = c.u16();
        const attrNs = c.strref();
        const value = c.dynstr();
        attrs.push({ name, ns: attrNs, value });
      }
      const nchildren = c.u16();
      const children: TemplateNodeDesc[] = [];
      for (let i = 0; i < nchildren; i++) {
        children.push(decodeTemplateNode(c));
      }
      return { kind: "element", tag, ns, attrs, children };
    }
    case NODE_TEXT: {
      const value = c.dynstr();
      return { kind: "text", value };
    }
    case NODE_DYNAMIC:
      return { kind: "dynamic" };
    default:
      throw new Error(`decodeBatch: unknown template node kind ${kind}`);
  }
}

/** Decode ONE batch: `ops` op-segment bytes + already-decoded string segment. */
export function decodeBatch(ops: Uint8Array, strings: string, sink: OpSink): void {
  const c = new Cursor(ops, strings);
  const len = ops.byteLength;
  while (c.off < len) {
    const opcode = c.u8();
    switch (opcode) {
      case OP_CACHE_STRING: {
        const id = c.u16();
        const s = c.dynstr();
        sink.cacheString(id, s);
        break;
      }
      case OP_REGISTER_TEMPLATE: {
        const tmpl = c.u16();
        const nroots = c.u16();
        const roots: TemplateNodeDesc[] = [];
        for (let i = 0; i < nroots; i++) {
          roots.push(decodeTemplateNode(c));
        }
        sink.registerTemplate(tmpl, roots);
        break;
      }
      case OP_APPEND_CHILDREN: {
        const id = c.u32();
        const m = c.u32();
        sink.appendChildren(id, m);
        break;
      }
      case OP_ASSIGN_ID: {
        const path = c.path();
        const id = c.u32();
        sink.assignId(path, id);
        break;
      }
      case OP_CREATE_PLACEHOLDER: {
        const id = c.u32();
        sink.createPlaceholder(id);
        break;
      }
      case OP_CREATE_TEXT_NODE: {
        const id = c.u32();
        const text = c.dynstr();
        sink.createTextNode(id, text);
        break;
      }
      case OP_LOAD_TEMPLATE: {
        const tmpl = c.u16();
        const root = c.u16();
        const id = c.u32();
        sink.loadTemplate(tmpl, root, id);
        break;
      }
      case OP_REPLACE_WITH: {
        const id = c.u32();
        const m = c.u32();
        sink.replaceWith(id, m);
        break;
      }
      case OP_REPLACE_PLACEHOLDER: {
        const path = c.path();
        const m = c.u32();
        sink.replacePlaceholder(path, m);
        break;
      }
      case OP_INSERT_AFTER: {
        const id = c.u32();
        const m = c.u32();
        sink.insertAfter(id, m);
        break;
      }
      case OP_INSERT_BEFORE: {
        const id = c.u32();
        const m = c.u32();
        sink.insertBefore(id, m);
        break;
      }
      case OP_SET_ATTRIBUTE: {
        const id = c.u32();
        const name = c.u16();
        const ns = c.strref();
        const attrKind = c.u8();
        switch (attrKind) {
          case ATTR_TEXT:
            sink.setAttributeText(id, name, ns, c.dynstr());
            break;
          case ATTR_FLOAT:
            sink.setAttributeFloat(id, name, ns, c.f64());
            break;
          case ATTR_INT:
            sink.setAttributeInt(id, name, ns, c.s64());
            break;
          case ATTR_BOOL:
            sink.setAttributeBool(id, name, ns, c.u8() !== 0);
            break;
          case ATTR_NONE:
            sink.setAttributeNone(id, name, ns);
            break;
          default:
            throw new Error(`decodeBatch: unknown attrval kind ${attrKind}`);
        }
        break;
      }
      case OP_SET_TEXT: {
        const id = c.u32();
        const text = c.dynstr();
        sink.setText(id, text);
        break;
      }
      case OP_NEW_EVENT_LISTENER: {
        const id = c.u32();
        const name = c.u16();
        sink.newEventListener(id, name);
        break;
      }
      case OP_REMOVE_EVENT_LISTENER: {
        const id = c.u32();
        const name = c.u16();
        sink.removeEventListener(id, name);
        break;
      }
      case OP_REMOVE: {
        const id = c.u32();
        sink.remove(id);
        break;
      }
      case OP_PUSH_ROOT: {
        const id = c.u32();
        sink.pushRoot(id);
        break;
      }
      default:
        throw new Error(`decodeBatch: unknown opcode 0x${opcode.toString(16)}`);
    }
  }
}

const FRAME_DECODER = new TextDecoder("utf-8", { ignoreBOM: true });

/**
 * Stream-transport framing layer — wit/world.wit "# Framing (stream
 * transport only)":
 *
 *   frame := frame-len:u32 strings-len:u32 strings:u8{strings-len} ops:u8{rest}
 *   frame-len = byte length of everything after the frame-len field
 *             = 4 + strings-len + len(ops)
 */
export class FrameDecoder {
  #sink: OpSink;
  #staged: Uint8Array | null = null;

  constructor(sink: OpSink) {
    this.#sink = sink;
  }

  pending(): number {
    return this.#staged ? this.#staged.byteLength : 0;
  }

  /**
   * Consume as many whole frames as available from `bytes` (optionally
   * prefixed by previously staged bytes). Returns the number of bytes of
   * `bytes` itself that are accounted for and need NOT be passed to
   * stashRest:
   *
   * - If no frame could be completed even with `bytes` appended to the
   *   staged carry (invariant: staged never holds a complete frame, so
   *   this only happens when zero frames complete), this method already
   *   copies staged+bytes into its own internal state and returns
   *   `bytes.byteLength` (i.e. "fully absorbed" — satisfies the
   *   direct-read "never acknowledge zero bytes" requirement without the
   *   caller having to do anything).
   * - Otherwise (progress was made: at least one frame completed), any
   *   undecoded tail is purely a suffix of `bytes` (the staged carry, if
   *   any, is fully consumed as a prefix). This method does NOT copy that
   *   tail itself; it returns the count of `bytes` consumed by whole
   *   frames, and the caller must call `stashRest(bytes, thatCount)` to
   *   preserve the remainder before the view becomes invalid.
   */
  feed(bytes: Uint8Array): number {
    let buf: Uint8Array;
    let stagedLen = 0;
    if (this.#staged) {
      stagedLen = this.#staged.byteLength;
      buf = new Uint8Array(stagedLen + bytes.byteLength);
      buf.set(this.#staged, 0);
      buf.set(bytes, stagedLen);
      this.#staged = null;
    } else {
      buf = bytes;
    }

    let off = 0;
    while (true) {
      if (buf.byteLength - off < 8) break; // need frame-len + strings-len
      const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      const frameLen = view.getUint32(off, true);
      const total = 4 + frameLen; // frame-len field itself + its payload
      if (buf.byteLength - off < total) break; // partial frame

      const stringsLen = view.getUint32(off + 4, true);
      const stringsStart = off + 8;
      const stringsEnd = stringsStart + stringsLen;
      const opsEnd = off + total;

      const stringsBytes = buf.subarray(stringsStart, stringsEnd);
      const strings = FRAME_DECODER.decode(stringsBytes);
      const ops = buf.subarray(stringsEnd, opsEnd);
      decodeBatch(ops, strings, this.#sink);

      off += total;
    }

    if (off === 0 && stagedLen > 0) {
      // No progress at all: retain the full merged carry ourselves (buf is
      // already a fresh copy when staged existed) and report `bytes` as
      // fully absorbed so the caller need not (but safely may) stashRest.
      this.#staged = buf;
      return bytes.byteLength;
    }
    if (off === 0) {
      // No staged carry, no progress: same as above but nothing to merge.
      // Do NOT self-copy here — let the caller stashRest the tail (keeps
      // the "caller stashes `bytes`' own tail" invariant uniform).
      return 0;
    }

    // Progress was made past any staged carry (invariant: stagedLen never
    // holds a complete frame, so off > 0 implies off > stagedLen here).
    const consumedFromBytes = off - stagedLen;
    this.#staged = null;
    return consumedFromBytes;
  }

  /**
   * Copy `bytes.subarray(offset)` into internal staging, prepended to the
   * next feed(). Used by the caller for whatever tail feed() did not
   * report as consumed (direct-read callback contract: must not
   * acknowledge zero bytes while a partial frame remains parked).
   */
  stashRest(bytes: Uint8Array, offset: number): void {
    const tail = bytes.subarray(offset);
    if (tail.byteLength === 0) return;
    if (this.#staged) {
      const merged = new Uint8Array(this.#staged.byteLength + tail.byteLength);
      merged.set(this.#staged, 0);
      merged.set(tail, this.#staged.byteLength);
      this.#staged = merged;
    } else {
      this.#staged = new Uint8Array(tail); // copy, per contract
    }
  }
}
