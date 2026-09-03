# bench/rows — js-framework-benchmark-shaped row operations

Tracks absolute row-operation throughput on the pinned polyengine
(`justfile`'s `POLYENGINE_REV`), Deno + linkedom (host-side DOM), a real
Dioxus component (`examples/bench-rows`), over the stream transport (the
only transport — see "Transport A/B (historical)" below for why the call
transport was retired). Since the typed-channel spike it runs **two
columns**: the stream transport's two mutation *channels*, the byte
protocol on `run` and the explicit WIT schema on `run-typed` (see
"Channel A/B" below). The operations are
js-framework-benchmark-style row operations (create/append/update/swap/
remove/clear), so there's a baseline to track regressions against and to
eventually compare with dioxus-web's published characteristics.

```sh
bench/run.sh
# or:
deno task bench
```

Builds `examples/bench-rows` into `bench/build/` (replicating `justfile`'s
`example` recipe's build command — `cargo build --release
--target wasm32-wasip2`, which emits a component directly), then
runs `bench/bench.ts`.

Output: a markdown table to stdout, written to
`bench/results-<date>-<host>.md`, and spliced into this file's
"Latest local numbers" section below.

## Operations measured

| control id | operation |
| --- | --- |
| `create-1k` | replace the table with 1,000 fresh rows |
| `create-10k` | replace the table with 10,000 fresh rows |
| `append-1k` | append 1,000 fresh rows onto an existing 1,000-row table |
| `update-every-10th` | mutate the label of every 10th row in a 1,000-row table |
| `swap-rows` | swap DOM positions of row index 1 and row index 998 in a 1,000-row table |
| `remove-row` | remove a single row (click its own `remove-<id>` button) from a 1,000-row table |
| `clear` | empty a 1,000-row table |

Row labels are `adjective colour noun` (the standard
js-framework-benchmark word lists), drawn from a **fixed-seed**
splitmix64 PRNG (`examples/bench-rows/src/lib.rs`'s `Rng`/`LABEL_SEED`)
— dispatch: "deterministic seed! reproducibility beats realism". The
PRNG is seeded once per mount and **never reseeded**: every
`create-1k`/`create-10k`/`append-1k` click advances it, so labels differ
from click to click within one mount (real diff work every rep, never a
no-op), while the label sequence for the Nth `build_rows` call in any
fixed click sequence is identical across every process run — reproducible
*shape and sequence*, not literal per-click byte content. Row ids (a
plain monotonic counter, also never reset within a mount) differ run to
run for the same reason.

## Methodology

- **Fresh mount per operation, per-rep state discipline.** Every timed
  rep does the operation's real work — no rep's completion condition may
  already be satisfied before it runs (see "Hard postcondition
  assertions" below). Concretely, per operation:
  - `create-1k` / `create-10k`: **clear the table (untimed) before every
    rep**, so each timed click is a genuine 0 → N build, never an
    N → N replace-in-place that a count-only check could mistake for
    already done.
  - `append-1k`: fresh 1,000-row table (untimed clear + `create-1k`)
    before every rep, so every timed append goes 1,000 → 2,000.
  - `update-every-10th` / `swap-rows` / `remove-row`: fresh **1,000-row**
    baseline before every rep (documented choice — dispatch: "pick one,
    document"; 1,000 matches js-framework-benchmark's own convention for
    these operations and keeps runtime bounded; 10,000 would be an
    equally valid choice for a future revision).
  - `clear`: fresh **10,000-row** baseline (untimed `create-10k`) before
    every rep, timing the clear itself — dispatch: "set up 10k rows
    untimed, time the clear."
- **Hard postcondition assertions, not just row-count polling.** Every
  completion predicate checks a *sentinel value changing from its pre-op
  snapshot* — e.g. `create-1k`'s predicate requires the first row's
  label to differ from what it was before the click, `swap-rows`'
  requires DOM position 1's `data-id` to change, `remove-row`'s requires
  the first row's `data-id` to change — not just a row count reaching
  some target. A count-only check is exactly the bug an earlier version
  of this harness had: a second `create-10k` on an already-10k table
  changes every row's identity but not the count, so a naive
  `rowCount() === 10000` predicate was already true before the click
  ran, and all 5 "timed" reps measured nothing (dioxus's keyed diff of
  a table replaced by another same-size table still does real
  remove+insert work per row — the count staying flat is not evidence of
  a no-op, but the old harness read it that way). Every predicate here
  additionally throws a `FATAL bench bug` error, before dispatching, if
  it is already satisfied at that point — a rep whose postcondition was
  true before the operation ran is a defect in this harness, not a data
  point, and is surfaced loudly rather than silently recorded as ~0ms.
- **Warmup, then N=5 timed runs, report the median.** The very first
  `create-1k`/`create-10k` on a fresh instance pays a one-time cost the
  renderer does not repeat: dioxus registers each distinct `Template` on
  first encounter and refers to it by a guest-assigned id thereafter
  (`src/writer.rs`'s module doc). One untimed warmup absorbs that
  before any of the five measured runs. Medians (not means) are reported
  because linkedom + Deno's V8 occasionally produce a single wildly slow
  run (background GC, JIT tier-up) that would distort a mean over only 5
  samples; the median is robust to that single outlier without needing a
  larger, slower sample.
- **Sanity floor.** Any op touching >=1,000 rows with a median under
  0.5ms fails the bench loudly rather than being reported — that
  threshold is what caught the original count-only-predicate bug (its
  `create-10k` number was 0.05ms, three orders of magnitude too fast for
  10,000 real DOM insertions through linkedom).
- **Completion is polled via DOM markers**, matching
  `host/tests/counter_test.ts`'s macrotask-poll pattern (a post-event
  render can land via either the `run` task's own wakeup or
  `handle-event`'s own render-and-flush; a single microtask drain is not
  reliably enough). `#row-count` and `#update-run-count` spans in
  `examples/bench-rows` exist purely so the bench can detect operation
  completion without depending on `tbody` child-count parsing quirks.
- **What linkedom measures and doesn't.** linkedom is a *host-side* DOM
  implementation — no layout, no paint, no real browser event loop; DOM
  mutation costs measured here (element creation, attribute/text
  writes, tree insertion/removal) are linkedom's own costs for those
  operations, not a real browser's. That means the absolute millisecond
  numbers below are not directly comparable to a real browser's
  js-framework-benchmark numbers; they're useful for tracking regressions
  on this box, run to run.
- **Byte/batch instrumentation was attempted and dropped.** An earlier
  revision of this track asked for total bytes and batches per operation
  via a wrapping `OpSink`/decorated `FrameDecoder`. `host/src/host.ts`'s
  `mountApp` builds its own `imports` object internally (the `open`
  closure over `frameDecoder`/`applier` is not constructor-injectable,
  and wrapping `Mounted.frameDecoder` after the fact is too late — by the
  time `mountApp` returns, every byte for the *first* batch may already
  have been fed into it). Instrumenting this properly needs a `mountApp`
  (or `FrameDecoder`) constructor hook, which is a `host/src` change —
  outside this track's territory. This is a gap for whoever owns
  `host/src` to close if the byte/batch columns are wanted later. This
  bench therefore reports **wall-clock ms only**. (The Channel A/B below
  needed op *counts* and got them by patching each mounted applier's
  `OpSink` methods in a throwaway script — enough for a one-off number,
  still not a standing column.)

## Channel A/B: byte protocol vs explicit WIT schema

The mutation channel's wire format is a hand-rolled byte encoding
documented normatively in `wit/world.wit`'s `run` doc comment: opcodes,
operand widths and framing all live in prose, and the encoder
(`src/protocol.rs`) and decoder (`host/src/decoder.ts`) are two
independent hand-written implementations of it that can only be kept in
agreement by golden vectors and review. The obvious maintainability
alternative is to spell the vocabulary as WIT — records plus one
`operation` variant — and ship `stream<operation>` instead of
`stream<u8>`, letting bindgen own both sides.

`wit/world.wit`'s `interface mutations` and the `run-typed` export are
that alternative, built so the two can be measured against each other.
Both channels are compiled into the same component (two exports);
`mountApp`'s `channel` option picks one, and both feed the identical
`DomApplier`, so the DOM work is common and the delta is purely
encode/transport/decode. `host/tests/typed_test.ts` asserts the two
produce identical DOM for the same interaction sequence — without that,
the numbers below would mean nothing.

### What the schema costs before you measure anything

**WIT forbids recursive type definitions.** `register-template`'s node
grammar is a tree, and

```wit
record template-element { children: list<template-node> }
variant template-node  { element(template-element), ... }
```

is rejected outright: "type `template-node` depends on itself". The
typed schema therefore carries the template as an *arena* — a flat
`nodes` list plus `u32` indices in `roots` and `children` — which is a
strictly weaker encoding than the byte format's self-delimiting
recursive grammar: it admits out-of-range and cyclic index graphs that
the byte grammar cannot express, so `applyTyped` needs explicit
validation the byte decoder never needed (`host/src/typed.ts`'s
`rehydrateTemplateArena`). That is a real dent in the maintainability
case, independent of speed.

The typed channel also gives up `readDirect`: polyengine's zero-copy
direct-read session is `stream<u8>` only (embedder-api amendment A21),
so the host reads with ordinary `read()` and pays a copy per batch. It
does **not** reintroduce the A15 host-retention hazard that killed the
call transport (see the historical section below): A15 licenses
quiescence on a retained end, a parked operation, *or* an unfinished
pump, and the host holds the lifted readable end for the instance's
lifetime, so the guest scheduler's persistent park is exactly as legal
here as on the byte channel. No deadlock trap fired in any run.

Third, `use mutations.{operation}` in the world makes the interface an
import of every component built against it — including components that
only ever call `run`. The host supplies nothing (the interface has no
items), but the byte channel's own component type changed to add a
typed channel it does not use.

### Measured

Read the *ratio* column of the "Latest local numbers" table below, not
the absolute values. Op counts here are **instrumented**, not estimated:
a counting `OpSink` wrapped around each mounted applier during a one-off
run recorded the `OpSink` calls in each timed window. Both channels
produced identical counts for all seven operations, which is an
independent check on the equivalence test.

| op | ops in the timed window | typed − bytes (median of 3 runs) | per op |
| --- | --- | --- | --- |
| create-10k | 90 006 | +437 ms | 4.9 µs |
| create-1k | 9 006 | +49 ms | 5.5 µs |
| append-1k | 9 002 | +47 ms | 5.2 µs |
| clear | 10 002 | +41 ms | 4.1 µs |
| update-every-10th | 101 | ~+1 ms | at the noise floor |
| swap-rows | 4 | — | at the noise floor |
| remove-row | 2 | — | at the noise floor |

**The typed channel costs 4–5.5 µs per operation, and that single figure
reproduces the whole table.** The strongest evidence for the linearity
does not depend on the op counts at all: `create-1k` and `create-10k`
differ by 10x in rows and 8.9x in added milliseconds, and `append-1k`
— a different operation, same order of magnitude of ops — lands on
essentially the same delta as `create-1k`.

The per-op cost is *not* flat to two digits, and the 1.3x spread is
predicted by the section's own mechanism rather than being noise:
`clear` is almost entirely `remove`, whose variant arm carries a bare
`u32`, while `create-*` is a mix dominated by multi-field records with
strings. A bigger type tree costs more to walk.

The ratio column therefore measures how op-heavy each operation is,
nothing more. The three small ops sitting at ~1.0x is **not** evidence
the channels are comparable — with 2 to 101 operations in the window,
a per-op cost of any size is invisible there.

### On the noise floor, and this file's own guardrail

The "Interpretation guardrails" section below says a >2x run-to-run
delta on any operation is a bug lead, not a result. Comparing the
retained pre-spike run (`results-2026-08-31-*.md`) with the runs here,
the **bytes** column moved by 2.15x on `create-1k` and 2.47x on
`remove-row`. Discharging that rather than ignoring it:

- The byte channel's code is unchanged by this spike. `Interner` was
  refactored (`intern_raw` extracted) with `intern` kept as a wrapper,
  and `mountApp` was restructured around a `channel` option with the
  byte branch moved verbatim under an `else`. The golden byte vectors
  (`cargo test --test vectors`) still match.
- The box was shared and busy across these runs; the byte column swung
  by up to 1.7x *between two runs minutes apart with no code change at
  all* (`create-1k`: 15.3 vs 8.8 ms).

So: box noise, not a regression — but it also means **only the
op-heavy rows carry signal**, and no ratio here should be read past its
first digit. The three small ops are reported for completeness, not as
measurements of anything.

### Where the ~5 µs goes — and how much of it is inherent

Attributing the typed path with the polyengine runtime instrumented
(one-off local experiment; see the disclosure below):

| stage | share |
| --- | --- |
| canonical-ABI per-element `load()` (`.deps/polyengine/runtime/src/cabi/load.ts`) | ~64% |
| embedder `toHost` value adaptation (`runtime/src/embedder/values.ts`) | ~20% |
| the rendezvous, guest-side lowering, promise plumbing | ~10% |
| `applyTyped`'s own dispatch | ~1–4% |

Guest-side encoding is inside that third row and was not separated out.
It is not free: `src/typed.rs` allocates a `String` per dynamic operand
and a `Vec` per attribute/children/path list, where `src/protocol.rs`
appends into two reused buffers. A standalone measurement of *building*
the batch (no transport) actually favoured the typed writer slightly
(~36 vs ~56 ns/op) — pushing structs is cheaper than byte-serialising
them — so the allocation cost shows up in the lowering and the host
lift, not in construction.

~85% is two generic interpreted walks of the type tree per element,
neither of which is inherent to the schema:

- `alignment`/`elemSize`/`maxCaseAlignment`/`despecialize` are
  recomputed from scratch for every element and every field. For a
  17-case variant of records that is a full type-tree walk per
  operation, and `despecialize` *allocates* on every call for
  `option`/`tuple`/`enum`/`result`.
- `toHost` calls `camelCase(label)` — a `split`/`map`/`join` — per field
  per element, and finds the variant case by linear scan over 17 cases.
  (Its `checkNoCollisions` is memoised per type and is *not* a per-
  element cost.)

Memoizing just the layout functions by type identity — a ~70-line
change to four functions in `runtime/src/cabi/{layout,types}.ts`, no
schema change and no compiled bindings — was measured as a sensitivity
run:

| op | typed (stock) | typed (memoized) | ratio, stock → memoized |
| --- | --- | --- | --- |
| create-10k | 588 ms | 267 ms | 5.07x → 1.74x |
| create-1k | 62.3 ms | 23.8 ms | 4.08x → 2.71x |
| append-1k | 132 ms | 102 ms | 1.55x → 1.12x |
| clear | 49.3 ms | 7.6 ms | 12.18x → 2.08x |

Given the noise floor above, trust the direction and the order of
magnitude of that column, not its third digit.

A separate pure-JS experiment bounds the floor: materialising the
`{kind, value}` object graph the typed schema forces into existence,
with no runtime and no ABI lift at all, and walking it with the same
applier, costs ~190 ns/op against ~45 ns/op for decoding the byte frame.
That ~4x on the host decode step is the part no runtime work can remove
— a typed channel must allocate two or three JS objects per operation,
where the byte decoder passes operands straight to the sink as
arguments and allocates nothing.

**Disclosure.** Three of the measurements above — the runtime-stage
attribution, the layout-memoization sensitivity run, and the pure-JS
floor — came from one-off local experiments that are not in this tree:
a scratch component exercising both encodings against a counting sink,
and a temporary patch to the gitignored `.deps/polyengine` checkout
(reverted; that checkout is pristine). They are described precisely
enough to redo — the memoization is a `WeakMap` cache keyed by type
identity on `alignment`, `elemSize`, `maxCaseAlignment` and
`despecialize` — but they are not re-derivable by running anything
committed here. The two-column table below, and the instrumented op
counts, are.

### Read

The delta is not small today: ~5x on op-heavy operations (12x on
`clear`, which is nearly pure per-op cost with no DOM work to dilute
it). It is the polyengine runtime's uncached lift, not the component
model or the schema, that makes it that large. Most of it is
recoverable — the layout memoization alone takes create-10k from 5.07x
to 1.74x, and a per-type compiled lift would go further. But the floor
is not 1.0x, and `create-10k` at 90 000 operations per render is
exactly where a per-op cost is least forgivable.

The maintainability argument is also weaker than it looks: the arena
workaround for WIT's recursion ban moves the template grammar's
correctness burden from a hand-written decoder into hand-written index
validation, so the schema does not actually retire the
"two implementations must agree" problem for the one op where that
problem is hardest.

## Transport A/B (historical)

`polymorph:dioxus` used to offer two mutation transports: this bench's
original purpose was to A/B them before picking one. **The call
transport has since been removed** (owner decision, recorded in
`wit/world.wit`'s `surface` interface doc): bulk-op deltas were within
noise, the stream transport was never meaningfully slower on any
operation, and the call transport has structurally degraded async
semantics — its `run()` task has no host-retained handle to park a
scheduler loop against (component-model-async amendment A15 host
retention), unlike the stream transport's parked `readDirect` session,
so background async work could never wake a call-transport instance
between events. The stream transport is now the only transport; this
section preserves the final measurement and the reasoning that closed
the question, for the record.

### A driver bug the A/B caught, fixed before retirement

An earlier revision of this bench found the CALL transport's `run` task
reliably hitting

```
Trap: wasm trap: deadlock detected: event loop cannot make further progress
(export 'run': no thread is ready and no host call is outstanding)
```

after two or more sequential clicks in one mount — this bench was the
first thing to drive repeated interactions through the CALL transport
(prior tests/fixtures only ever dispatched one event per mount) and
caught a real bug doing so.

**Root cause and fix, at the driver level** (`src/driver.rs`, prior to
the call transport's removal): under the STREAM transport, `run()`
parked in a persistent scheduler loop (`wait_for_work().await`) between
renders. That park is legal because the host is holding a parked
`readDirect` session on the instance's ops stream — amendment A15 host
retention — so a quiescent instance is a documented, embedder-recognized
state. Under the CALL transport, nothing was retained host-side once a
`flush` call returned: the same park was then indistinguishable from an
actual deadlock, and polyengine's quiescence detector was (correctly,
given what it could see) trapping it. The fix at the time: `run()`
returned right after the initial mount when using the call transport,
instead of entering that loop. `handle-event` already rendered and
flushed itself on every event, so interactivity was unaffected — the
only capability lost was background async work waking the instance
*between* user events, which the call transport (a single synchronous
import per batch) was never built to support anyway. That degradation —
not any bench artifact — is what this track's A/B measurement above
ultimately confirmed was not worth keeping around, and the transport was
removed.

With that fix in place, this bench's earlier "N/A — deadlock" cells
populated with real numbers (see the final measured table below), and no
retry in `bench/ops.ts`'s bounded-retry loop was observed to be needed
before retirement (the retry loop itself is kept as a defensive net —
see its doc comment in `bench/ops.ts`).

**Footnote, not a bug claim**: while chasing the deadlock before the fix
landed, the trap's firing point was observed to be sensitive to
unrelated JS microtask-depth changes in the bench harness — wrapping a
dispatch+poll pair in an `async function` that `await`s its result (one
extra microtask-resumption hop) made the trap fire sooner and more
reliably than tail-returning the same poll promise from a plain
function; adding one more macrotask turn after a predicate first passed
made it fire earlier still (during mount, before any click). That's
consistent with the A15 explanation above — the detector was firing at
different points along the same underlying quiescence condition
depending on incidental host-side scheduling timing, not a harness logic
error — and is retained here (and in this file's git history, alongside
the original investigation) as a potential upstream-report lead for
polyengine's own quiescence-detection timing, should anyone want to
chase the *detector's* sensitivity further. This is an observation, not
a claim that polyengine itself has a bug: the trap was a correct verdict
given what the host could see before the driver fix.

### Final measured table (before retirement)

| op | stream (ms, median of 5) | call (ms, median of 5) | call vs stream |
| --- | --- | --- | --- |
| create-1k | 7.59 | 5.99 | -21.1% |
| create-10k | 77.30 | 87.59 | +13.3% |
| append-1k | 77.85 | 79.93 | +2.7% |
| update-every-10th | 3.73 | 3.69 | -1.1% |
| swap-rows | 1.28 | 3.71 | +190.6% |
| remove-row | 1.12 | 3.61 | +221.3% |
| clear | 2.98 | 3.09 | +3.7% |

(git rev 036dbfe, Deno 2.9.5, aarch64-unknown-linux-gnu — box-relative,
see the numbers-are-box-relative guardrail below.)

### Read on the final table (5 independent full runs)

- **create-10k, append-1k, clear, update-every-10th**: deltas flipped
  sign or swung wildly across runs — within noise per the guardrail
  below. No meaningful transport difference on bulk ops: the boundary
  cost was amortized to invisibility either way. This is the main
  finding that justified retiring the call transport: it bought nothing
  measurable on the operations that matter most (bulk creates/updates),
  while costing the async-wakeup capability documented above.
- **create-1k**: call read faster in all 5 runs but by unstable margins
  (-16% to -65%), driven by stream's own run-to-run variance. Suggestive,
  not conclusive, and not large enough on its own to keep a transport
  with degraded async semantics.
- **swap-rows / remove-row** (the >2x rows): consistently call-slower in
  every run — call sat in a tight ~3.5-4.3 ms band while stream swung
  ~1-3.6 ms. Direction was real; the MAGNITUDE was never fully explained
  (flagged per the guardrail below at the time). A per-call canonical
  lift/lower cost cannot explain it (polyengine's sync-import boundary
  costs are microseconds — see
  `.deps/polyengine/bench/boundary/README.md`), and a flat ~4 ms floor on
  ops whose real work is tiny looked like the scale of
  nested-setTimeout clamping in this harness's completion polling.
  Working hypothesis at the time: poll-quantization interacting with
  which task/turn the call lane's DOM changes land in, not transport
  data-path cost. This is now moot for the retirement decision (the
  small-op floor never favored the call transport either), but is
  retained here as an unresolved lead in case it turns out to matter for
  something else — an event-driven completion signal (e.g. a
  MutationObserver) would discriminate it, if anyone picks this back up.

## Interpretation guardrails

- **Numbers are box-relative.** Compare the same operation across
  commits on one box. Do not compare absolute millisecond values across
  machines.
- A **>2x unexplained delta run-to-run on any operation is a bug lead**,
  not a result to report at face value — chase it (a setup step leaking
  into the timed window, warmup not actually excluded) before writing it
  down as a real regression. (This is exactly what surfaced the
  count-only-predicate bug during the historical transport A/B above:
  `create-10k` reporting 0.05ms and `append-1k` reporting 17ms in the
  same table, a 300x gap in the wrong direction for the amount of work
  each op does, was the tell.)

## Latest local numbers

<!-- LATEST-LOCAL-NUMBERS:START -->

# bench-rows results — 2026-09-03

- Deno: 2.9.5 (aarch64-unknown-linux-gnu)
- git rev: 9dc9810-dirty
- Box note: numbers are box-relative — compare columns within this run, not across machines. See bench/README.md.

| op | bytes (ms, median of 5) | typed (ms, median of 5) | typed / bytes |
| --- | --- | --- | --- |
| create-1k | 14.53 | 72.53 | 4.99x |
| create-10k | 91.03 | 528.18 | 5.80x |
| append-1k | 83.45 | 133.05 | 1.59x |
| update-every-10th | 4.73 | 5.81 | 1.23x |
| swap-rows | 2.92 | 5.34 | 1.83x |
| remove-row | 4.83 | 5.01 | 1.04x |
| clear | 3.69 | 44.31 | 12.02x |

<!-- LATEST-LOCAL-NUMBERS:END -->
</content>
