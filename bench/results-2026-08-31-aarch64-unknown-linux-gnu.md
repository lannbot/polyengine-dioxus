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
