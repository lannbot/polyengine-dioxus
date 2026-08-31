//! bench-rows: a js-framework-benchmark-shaped row-table app, built to
//! quantify (1) the stream-vs-call transport delta and (2) absolute
//! row-operation throughput on the pinned polyengine (see
//! `bench/README.md` for methodology and the current numbers).
//!
//! Control surface (ids `bench/bench.ts` clicks): `create-1k`, `create-10k`,
//! `clear`, `update-every-10th`, `swap-rows`, `append-1k`, plus a per-row
//! remove button (`id="remove-{row.id}"`) for the remove-row operation.
//!
//! Label generation follows the standard js-framework-benchmark word lists
//! (adjective + colour + noun) but draws from a **fixed-seed** PRNG rather
//! than `Math.random()`/`rand`-with-OS-entropy — dispatch: "deterministic
//! seed! reproducibility beats realism". The PRNG is seeded once per mount
//! and never reseeded (see `Rng`'s doc comment): repeated `create-1k`
//! clicks in the same session produce *different* labels (real diff work
//! for every rep, not a no-op), while the Nth label produced across any
//! fixed click sequence is identical across every process run — the
//! workload's *shape and sequence* are reproducible, not its literal
//! per-click byte content.
//!
//! A cargo feature `call-transport` switches `launch!` to
//! `Transport::Call`, mirroring `fixtures/surface-probe`'s feature pattern
//! (`fixtures/surface-probe/Cargo.toml`).

use dioxus::prelude::*;

const ADJECTIVES: &[&str] = &[
    "pretty", "large", "big", "small", "tall", "short", "long", "handsome", "plain", "quaint",
    "clean", "elegant", "easy", "angry", "crazy", "helpful", "mushy", "odd", "unsightly", "adorable",
    "important", "inexpensive", "cheap", "expensive", "fancy",
];
const COLOURS: &[&str] = &[
    "red", "yellow", "blue", "green", "pink", "brown", "purple", "brown", "white", "black", "orange",
];
const NOUNS: &[&str] = &[
    "table", "chair", "house", "bbq", "desk", "car", "pony", "cookie", "sandwich", "burger", "pizza",
    "mouse", "keyboard",
];

/// A small deterministic PRNG (splitmix64), *not* `rand`: this crate builds
/// as a wasm32 polyengine component and pulling in a real `rand` crate (plus
/// its OS-entropy backend) is unnecessary weight for a fixed-seed generator.
///
/// **Persistent across calls, never reseeded mid-session**: the app holds
/// one `Rng` (`use_signal`) for its whole lifetime, seeded once at mount.
/// Every `build_rows` call advances it — so two `create-1k` clicks in a
/// row produce *different* labels (a real diff for the keyed reconciler to
/// do), while remaining fully reproducible: a fresh mount always starts at
/// `LABEL_SEED`, so the label sequence for the Nth `build_rows` call in a
/// given click sequence is identical across every process run.
///
/// CONTRACT (bench measurement validity, not a wit/design-doc citation):
/// an earlier version of this file reseeded per call, making repeated
/// `create-1k`/`create-10k` clicks produce byte-identical label sets;
/// since ids are also fed by an incrementing counter that both the old and
/// new keying discipline share, the keys still differed between clicks —
/// but `bench/bench.ts`'s completion predicates at the time only checked
/// row *count*, which stayed unchanged across repeat `create-Nk` calls
/// once warmup had already reached that count, so those reps measured
/// nothing. Fixed on both sides: this persistent-RNG discipline (content
/// really changes) plus `bench/bench.ts` now asserting a sentinel value
/// changed, not just the count.
struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Self(seed)
    }

    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E3779B97F4A7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
        z ^ (z >> 31)
    }

    fn index(&mut self, len: usize) -> usize {
        (self.next_u64() % len as u64) as usize
    }
}

/// Fixed seed: the whole point is that `create-1k`/`create-10k` produce the
/// exact same label bytes on every invocation, on every machine.
const LABEL_SEED: u64 = 0x00C0_FFEE_1234_5678;

#[derive(Clone, PartialEq)]
struct Row {
    id: u32,
    label: String,
}

fn build_label(rng: &mut Rng) -> String {
    let a = ADJECTIVES[rng.index(ADJECTIVES.len())];
    let c = COLOURS[rng.index(COLOURS.len())];
    let n = NOUNS[rng.index(NOUNS.len())];
    format!("{a} {c} {n}")
}

fn build_rows(count: usize, rng: &mut Rng, next_id: &mut u32) -> Vec<Row> {
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        let id = *next_id;
        *next_id += 1;
        out.push(Row { id, label: build_label(rng) });
    }
    out
}

#[allow(non_snake_case)]
fn App() -> Element {
    let mut rows = use_signal(Vec::<Row>::new);
    let mut next_id = use_signal(|| 1u32);
    let mut label_rng = use_signal(|| Rng::new(LABEL_SEED));
    // Every-10th-row update run counter: appended once per
    // `update-every-10th` click so the poller in bench.ts can detect
    // completion by counting trailing " !!!" occurrences rather than
    // guessing at content.
    let mut update_runs = use_signal(|| 0u32);

    rsx! {
        div { class: "bench-rows",
            div { class: "controls",
                button {
                    id: "create-1k",
                    onclick: move |_| {
                        let mut id = next_id();
                        let data = build_rows(1_000, &mut label_rng.write(), &mut id);
                        next_id.set(id);
                        rows.set(data);
                    },
                    "Create 1,000 rows"
                }
                button {
                    id: "create-10k",
                    onclick: move |_| {
                        let mut id = next_id();
                        let data = build_rows(10_000, &mut label_rng.write(), &mut id);
                        next_id.set(id);
                        rows.set(data);
                    },
                    "Create 10,000 rows"
                }
                button {
                    id: "append-1k",
                    onclick: move |_| {
                        let mut id = next_id();
                        let mut data = build_rows(1_000, &mut label_rng.write(), &mut id);
                        next_id.set(id);
                        rows.write().append(&mut data);
                    },
                    "Append 1,000 rows"
                }
                button {
                    id: "update-every-10th",
                    onclick: move |_| {
                        rows.write().iter_mut().step_by(10).for_each(|r| {
                            r.label.push_str(" !!!");
                        });
                        update_runs += 1;
                    },
                    "Update every 10th row"
                }
                button {
                    id: "swap-rows",
                    onclick: move |_| {
                        let mut w = rows.write();
                        if w.len() > 998 {
                            w.swap(1, 998);
                        }
                    },
                    "Swap rows"
                }
                button {
                    id: "clear",
                    onclick: move |_| rows.set(Vec::new()),
                    "Clear"
                }
            }
            // A marker span so bench.ts can read row count / update-run
            // count without depending on tbody's own child count parsing
            // quirks in linkedom.
            span { id: "row-count", "{rows.read().len()}" }
            span { id: "update-run-count", "{update_runs}" }
            table {
                tbody { id: "rows",
                    for row in rows.read().iter().cloned() {
                        tr {
                            key: "{row.id}",
                            "data-id": "{row.id}",
                            td { "{row.id}" }
                            td { class: "label", "{row.label}" }
                            td {
                                button {
                                    id: "remove-{row.id}",
                                    class: "remove",
                                    onclick: move |_| {
                                        rows.write().retain(|r| r.id != row.id);
                                    },
                                    "x"
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

#[cfg(not(feature = "call-transport"))]
polyengine_dioxus::launch!(App);

#[cfg(feature = "call-transport")]
polyengine_dioxus::launch!(App, polyengine_dioxus::Transport::Call);
