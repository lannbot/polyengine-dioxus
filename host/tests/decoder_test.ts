import { assertEquals } from "jsr:@std/assert@1";
import { decodeBatch, FrameDecoder, type OpSink } from "../src/decoder.ts";

// Recording sink: turns OpSink calls into plain JSON-shaped op records
// matching the golden-vector expected.json format (see dispatch doc).
function recordingSink(ops: unknown[]): OpSink {
  return {
    cacheString(id, s) {
      ops.push({ op: "cache-string", id, s });
    },
    registerTemplate(tmpl, roots) {
      ops.push({ op: "register-template", tmpl, roots });
    },
    appendChildren(id, m) {
      ops.push({ op: "append-children", id, m });
    },
    assignId(path, id) {
      ops.push({ op: "assign-id", path: Array.from(path), id });
    },
    createPlaceholder(id) {
      ops.push({ op: "create-placeholder", id });
    },
    createTextNode(id, text) {
      ops.push({ op: "create-text-node", id, text });
    },
    loadTemplate(tmpl, root, id) {
      ops.push({ op: "load-template", tmpl, root, id });
    },
    replaceWith(id, m) {
      ops.push({ op: "replace-with", id, m });
    },
    replacePlaceholder(path, m) {
      ops.push({ op: "replace-placeholder", path: Array.from(path), m });
    },
    insertAfter(id, m) {
      ops.push({ op: "insert-after", id, m });
    },
    insertBefore(id, m) {
      ops.push({ op: "insert-before", id, m });
    },
    setAttributeText(id, name, ns, value) {
      ops.push({ op: "set-attribute", id, name, ns, value: { kind: "text", s: value } });
    },
    setAttributeFloat(id, name, ns, value) {
      ops.push({ op: "set-attribute", id, name, ns, value: { kind: "float", f: value } });
    },
    setAttributeInt(id, name, ns, value) {
      ops.push({ op: "set-attribute", id, name, ns, value: { kind: "int", i: value.toString() } });
    },
    setAttributeBool(id, name, ns, value) {
      ops.push({ op: "set-attribute", id, name, ns, value: { kind: "bool", b: value } });
    },
    setAttributeNone(id, name, ns) {
      ops.push({ op: "set-attribute", id, name, ns, value: { kind: "none" } });
    },
    setText(id, text) {
      ops.push({ op: "set-text", id, text });
    },
    newEventListener(id, name) {
      ops.push({ op: "new-event-listener", id, name });
    },
    removeEventListener(id, name) {
      ops.push({ op: "remove-event-listener", id, name });
    },
    remove(id) {
      ops.push({ op: "remove", id });
    },
    pushRoot(id) {
      ops.push({ op: "push-root", id });
    },
  };
}

// -- byte-encoding helpers for hand-built test frames -----------------------

class Writer {
  chunks: number[] = [];
  u8(v: number) {
    this.chunks.push(v & 0xff);
  }
  u16(v: number) {
    this.u8(v & 0xff);
    this.u8((v >>> 8) & 0xff);
  }
  u32(v: number) {
    this.u16(v & 0xffff);
    this.u16((v >>> 16) & 0xffff);
  }
  s64(v: bigint) {
    const buf = new ArrayBuffer(8);
    new DataView(buf).setBigInt64(0, v, true);
    this.chunks.push(...new Uint8Array(buf));
  }
  f64(v: number) {
    const buf = new ArrayBuffer(8);
    new DataView(buf).setFloat64(0, v, true);
    this.chunks.push(...new Uint8Array(buf));
  }
  strref(v: number | null) {
    this.u16(v === null ? 0xffff : v);
  }
  path(p: number[]) {
    this.u8(p.length);
    for (const x of p) this.u8(x);
  }
  bytes(): Uint8Array {
    return new Uint8Array(this.chunks);
  }
}

// dynstr writer: appends UTF-8 bytes to the shared string-segment builder
// and writes the UTF-16 code-unit length (+ 0xffff escape + u32) into the op
// writer, per wit's dynstr encoding.
class StringSeg {
  parts: string[] = [];
  push(w: Writer, s: string) {
    const len = s.length; // UTF-16 code units
    if (len < 0xffff) {
      w.u16(len);
    } else {
      w.u16(0xffff);
      w.u32(len);
    }
    this.parts.push(s);
  }
  segment(): string {
    return this.parts.join("");
  }
}

function buildFrame(opsBytes: Uint8Array, strings: string): Uint8Array {
  const stringBytes = new TextEncoder().encode(strings);
  const frameLen = 4 + stringBytes.byteLength + opsBytes.byteLength;
  const out = new Uint8Array(4 + frameLen);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, frameLen, true);
  dv.setUint32(4, stringBytes.byteLength, true);
  out.set(stringBytes, 8);
  out.set(opsBytes, 8 + stringBytes.byteLength);
  return out;
}

/** Hand-encode: cache-string(0,"x") ; create-text-node(1,"hi") ;
 * set-attribute(1, name=0, ns=none, float=1.5) ; push-root(1). */
function handEncodedOpsAndStrings(): { ops: Uint8Array; strings: string } {
  const w = new Writer();
  const ss = new StringSeg();

  w.u8(0x01); // cache-string
  w.u16(0);
  ss.push(w, "x");

  w.u8(0x06); // create-text-node
  w.u32(1);
  ss.push(w, "hi");

  w.u8(0x0c); // set-attribute
  w.u32(1);
  w.u16(0);
  w.strref(null);
  w.u8(0x01); // float
  w.f64(1.5);

  w.u8(0x11); // push-root
  w.u32(1);

  return { ops: w.bytes(), strings: ss.segment() };
}

Deno.test("decodeBatch: hand-encoded multi-op batch", () => {
  const { ops, strings } = handEncodedOpsAndStrings();
  const recorded: unknown[] = [];
  decodeBatch(ops, strings, recordingSink(recorded));
  assertEquals(recorded, [
    { op: "cache-string", id: 0, s: "x" },
    { op: "create-text-node", id: 1, text: "hi" },
    { op: "set-attribute", id: 1, name: 0, ns: null, value: { kind: "float", f: 1.5 } },
    { op: "push-root", id: 1 },
  ]);
});

Deno.test("FrameDecoder: split at every byte boundary matches unsplit decode", () => {
  const { ops: ops1, strings: strings1 } = handEncodedOpsAndStrings();
  const frame1 = buildFrame(ops1, strings1);

  const w2 = new Writer();
  const ss2 = new StringSeg();
  w2.u8(0x01);
  w2.u16(1);
  ss2.push(w2, "y");
  w2.u8(0x10); // remove
  w2.u32(1);
  const frame2 = buildFrame(w2.bytes(), ss2.segment());

  const combined = new Uint8Array(frame1.byteLength + frame2.byteLength);
  combined.set(frame1, 0);
  combined.set(frame2, frame1.byteLength);

  // unsplit baseline
  const baseline: unknown[] = [];
  {
    const dec = new FrameDecoder(recordingSink(baseline));
    const consumed = dec.feed(combined);
    assertEquals(consumed, combined.byteLength);
    assertEquals(dec.pending(), 0);
  }

  // split at every byte boundary
  for (let cut = 0; cut <= combined.byteLength; cut++) {
    const part1 = combined.subarray(0, cut);
    const part2 = combined.subarray(cut);
    const recorded: unknown[] = [];
    const dec = new FrameDecoder(recordingSink(recorded));

    const c1 = dec.feed(part1);
    if (c1 < part1.byteLength) {
      dec.stashRest(part1, c1);
    }
    const c2 = dec.feed(part2);
    if (c2 < part2.byteLength) {
      dec.stashRest(part2, c2);
    }

    assertEquals(recorded, baseline, `mismatch at cut=${cut}`);
    assertEquals(dec.pending(), 0, `pending leftover at cut=${cut}`);
  }
});

Deno.test("dynstr: 0xffff length escape, empty string, surrogate pair, leading BOM", () => {
  const w = new Writer();
  const ss = new StringSeg();

  // Long ASCII string forcing the 0xffff escape (>= 0xffff UTF-16 units).
  const long = "a".repeat(0xffff + 5);
  w.u8(0x06);
  w.u32(100);
  ss.push(w, long);

  // Empty string.
  w.u8(0x06);
  w.u32(101);
  ss.push(w, "");

  // Surrogate pair (U+1F600 GRINNING FACE = 2 UTF-16 code units).
  const emoji = "\u{1F600}";
  w.u8(0x06);
  w.u32(102);
  ss.push(w, emoji);

  // Leading U+FEFF must survive (ignoreBOM in FrameDecoder's TextDecoder).
  const bomStr = "\uFEFFhello";
  w.u8(0x06);
  w.u32(103);
  ss.push(w, bomStr);

  const frame = buildFrame(w.bytes(), ss.segment());
  const recorded: unknown[] = [];
  const dec = new FrameDecoder(recordingSink(recorded));
  const consumed = dec.feed(frame);
  assertEquals(consumed, frame.byteLength);

  assertEquals(recorded, [
    { op: "create-text-node", id: 100, text: long },
    { op: "create-text-node", id: 101, text: "" },
    { op: "create-text-node", id: 102, text: emoji },
    { op: "create-text-node", id: 103, text: bomStr },
  ]);
});

// -- golden vectors ----------------------------------------------------------

const VECTORS_DIR = new URL("../../vectors/", import.meta.url);

interface ExpectedVector {
  frames: Record<string, unknown>[][];
}

async function listVectorNames(): Promise<string[]> {
  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(VECTORS_DIR)) {
      if (entry.isFile && entry.name.endsWith(".bin")) {
        names.push(entry.name.slice(0, -".bin".length));
      }
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  return names.sort();
}

function normalizeAttrValue(v: unknown): unknown {
  const val = v as { kind: string; i?: unknown };
  if (val.kind === "int") {
    return { kind: "int", i: BigInt(val.i as string | number).toString() };
  }
  return val;
}

function normalizeOp(op: Record<string, unknown>): Record<string, unknown> {
  if (op.op === "set-attribute" && op.value) {
    return { ...op, value: normalizeAttrValue(op.value) };
  }
  return op;
}

const vectorNames = await listVectorNames();

if (vectorNames.length === 0) {
  Deno.test("golden vectors pending", { ignore: true }, () => {});
} else {
  for (const name of vectorNames) {
    Deno.test(`golden vector: ${name}`, async () => {
      const bin = await Deno.readFile(new URL(`${name}.bin`, VECTORS_DIR));
      const expectedText = await Deno.readTextFile(new URL(`${name}.expected.json`, VECTORS_DIR));
      const expected: ExpectedVector = JSON.parse(expectedText);

      const framesRecorded: unknown[][] = [];
      let off = 0;
      while (off < bin.byteLength) {
        // Each expected "frame" entry is one wire frame's ops; parse the
        // frame-len header ourselves so a single feed() call (which
        // consumes as many WHOLE frames as are available) doesn't merge
        // multiple wire frames into one recorded frame.
        const dv = new DataView(bin.buffer, bin.byteOffset + off, bin.byteLength - off);
        const frameLen = dv.getUint32(0, true);
        const total = 4 + frameLen;
        const frameBytes = bin.subarray(off, off + total);

        const recorded: unknown[] = [];
        const frameSink = recordingSink(recorded);
        const frameDec = new FrameDecoder(frameSink);
        const consumed = frameDec.feed(frameBytes);
        if (consumed !== frameBytes.byteLength) {
          throw new Error(
            `golden vector ${name}: expected to consume exactly one frame (${frameBytes.byteLength}B) at offset ${off}, consumed ${consumed}`,
          );
        }
        framesRecorded.push(recorded);
        off += total;
      }

      const actualFrames = framesRecorded.map((ops) =>
        ops.map((o) => normalizeOp(o as Record<string, unknown>))
      );
      const expectedFrames = expected.frames.map((ops) =>
        ops.map((o) => normalizeOp(o))
      );
      assertEquals(actualFrames, expectedFrames);
    });
  }
}
