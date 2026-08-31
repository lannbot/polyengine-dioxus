# bench/rows — js-framework-benchmark-shaped row operations

Quantifies two things on the pinned polyengine (`justfile`'s
`POLYENGINE_REV`), Deno + linkedom (host-side DOM), a real Dioxus
component (`examples/bench-rows`):

1. **Transport A/B**: stream+readDirect (zero-copy) vs
   `flush(list<u8>, string)` (call, one bulk copy) — same app, same
   workload, only the transport differs (`polyengine_dioxus::launch!`'s
   `Transport` argument; see `examples/bench-rows/Cargo.toml`'s
   `call-transport` feature).
2. **Absolute throughput profile**: js-framework-benchmark-style row
   operations (create/append/update/swap/remove/clear), so there's a
   baseline to track regressions against and to eventually compare with
   dioxus-web's published characteristics.

```sh
bench/run.sh
# or:
deno task bench
```

Builds both transport variants of `examples/bench-rows` into
`bench/build/` (replicating `justfile`'s `example` recipe's two commands
— `cargo build --release --target wasm32-unknown-unknown` then
`wasm-tools component new` — once per transport, matching the
`fixtures` recipe's stream/call pairing), then runs `bench/bench.ts`.

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
  operations, not a real browser's. That means the **absolute**
  millisecond numbers below are not directly comparable to a real
  browser's js-framework-benchmark numbers. What IS comparable across
  the stream/call columns: both transport variants share the exact same
  linkedom applier, the exact same guest component logic, and the exact
  same operation — the only difference is how mutation bytes cross the
  host/guest boundary. The stream-vs-call **delta isolates transport
  cost** even though neither column's absolute value should be read as
  "real browser cost".
- **Byte/batch instrumentation was attempted and dropped.** The
  dispatch asked for total bytes and batches per operation via a
  wrapping `OpSink`/decorated `FrameDecoder`. `host/src/host.ts`'s
  `mountApp` builds its own `imports` object internally (the `open`/
  `flush` closures over `frameDecoder`/`applier` are not
  constructor-injectable, and wrapping `Mounted.frameDecoder` after the
  fact is too late — by the time `mountApp` returns, every byte for the
  *first* batch may already have been fed into it). Instrumenting this
  properly needs a `mountApp` (or `FrameDecoder`) constructor hook,
  which is a `host/src` change — outside this track's territory (this
  track's dispatch: "decorate at mount call site if the API allows; if
  it doesn't, note it and skip"; "do not hack host/src for this"). This
  is a gap for whoever owns `host/src` to close if the byte/batch
  columns are wanted later. This bench therefore reports **wall-clock ms
  only**.

## A driver bug the bench caught, now fixed (not a polyengine issue)

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

**Root cause and fix, at the driver level** (`src/driver.rs`'s `run()` —
see its module doc for the full account; cited here rather than
duplicated): under the STREAM transport, `run()` parks in a persistent
scheduler loop (`wait_for_work().await`) between renders. That park is
legal because the host is holding a parked `readDirect` session on the
instance's ops stream — amendment A15 host retention — so a quiescent
instance is a documented, embedder-recognized state. Under the CALL
transport, nothing is retained host-side once a `flush` call returns:
the same park is then indistinguishable from an actual deadlock, and
polyengine's quiescence detector was (correctly, given what it could
see) trapping it. The fix: `run()` now **returns** right after the
initial mount when `transport == Transport::Call`, instead of entering
that loop. `handle-event` already renders and flushes itself on every
event, so interactivity is unaffected — the only capability lost is
background async work waking the instance *between* user events, which
the call transport (a single synchronous import per batch) was never
built to support anyway. This is now documented as a deliberate
degradation of the bench/debug transport in both `src/driver.rs` and
`wit/world.wit`.

With that fix, this bench's earlier "N/A — deadlock" cells populate with
real numbers (see "Latest local numbers" below), and no retry in
`bench/ops.ts`'s bounded-retry loop has been observed to be needed.

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
depending on incidental host-side scheduling timing, not with a
harness logic error — and is retained here (and in this file's git
history, alongside the original investigation) as a potential
upstream-report lead for polyengine's own quiescence-detection timing,
should anyone want to chase the *detector's* sensitivity further. This
is an observation, not a claim that polyengine itself has a bug: the
trap was a correct verdict given what the host could see before the
driver fix.

## Interpretation guardrails

- **Numbers are box-relative.** Compare columns *within* one run of
  this bench, or the same column across commits on one box. Do not
  compare absolute millisecond values across machines.
- **The stream-vs-call delta is a decision INPUT, not a decision.**
  `wit/world.wit` says the call transport may be retired once measured;
  this track reports the delta and nothing more — the retirement call
  belongs elsewhere.
- **If stream and call are within noise, that itself is the finding** —
  report it plainly rather than reaching for an explanation. Reread
  "within noise" as: a 5-run median delta smaller than the run-to-run
  spread you'd see from rerunning the same transport twice.
- A **>2x unexplained delta on any operation is a bug lead**, not a
  result to report at face value — chase it (mis-set feature flag,
  warmup not actually excluded, a setup step leaking into the timed
  window) before writing it down as a transport characteristic. (This is
  exactly what surfaced the count-only-predicate bug above: `create-10k`
  reporting 0.05ms and `append-1k` reporting 17ms in the same table, a
  300x gap in the wrong direction for the amount of work each op does,
  was the tell.)

## Latest local numbers

<!-- LATEST-LOCAL-NUMBERS:START -->

# bench-rows results — 2026-08-31

- Deno: 2.9.5 (aarch64-unknown-linux-gnu)
- git rev: 036dbfe
- Box note: numbers are box-relative — compare columns within this run, not across machines. See bench/README.md.

| op | stream (ms, median of 5) | call (ms, median of 5) | call vs stream |
| --- | --- | --- | --- |
| create-1k | 7.59 | 5.99 | -21.1% |
| create-10k | 77.30 | 87.59 | +13.3% |
| append-1k | 77.85 | 79.93 | +2.7% |
| update-every-10th | 3.73 | 3.69 | -1.1% |
| swap-rows | 1.28 | 3.71 | +190.6% |
| remove-row | 1.12 | 3.61 | +221.3% |
| clear | 2.98 | 3.09 | +3.7% |

<!-- LATEST-LOCAL-NUMBERS:END -->

### Read on the current table (5 independent full runs)

- **create-10k, append-1k, clear, update-every-10th**: deltas flip sign
  or swing wildly across runs — within noise per the guardrail above. No
  meaningful transport difference on bulk ops: the boundary cost is
  amortized to invisibility either way.
- **create-1k**: call read faster in all 5 runs but by unstable margins
  (-16% to -65%), driven by stream's own run-to-run variance. Suggestive,
  not conclusive.
- **swap-rows / remove-row** (the >2x rows): consistently call-slower in
  every run — call sits in a tight ~3.5-4.3 ms band while stream swings
  ~1-3.6 ms. Direction is real; the MAGNITUDE is unexplained and flagged
  per the guardrail. A per-call canonical lift/lower cost cannot explain
  it (polyengine's sync-import boundary costs are microseconds — see
  .deps/polyengine/bench/boundary/README.md), and a flat ~4 ms floor on
  ops whose real work is tiny is exactly the scale of nested-setTimeout
  clamping in this harness's completion polling. Working hypothesis:
  poll-quantization interacting with which task/turn the call lane's DOM
  changes land in, not transport data-path cost. Chase before treating
  it as a transport characteristic (a completion path with event-driven
  signaling — e.g. a MutationObserver — would discriminate).
