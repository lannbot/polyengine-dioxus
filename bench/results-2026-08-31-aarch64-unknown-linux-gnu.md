# bench-rows results — 2026-08-31

- Deno: 2.9.5 (aarch64-unknown-linux-gnu)
- git rev: 88398dd
- Box note: numbers are box-relative — compare columns within this run, not across machines. See bench/README.md.

| op | ms (median of 5) |
| --- | --- |
| create-1k | 7.16 |
| create-10k | 77.36 |
| append-1k | 83.69 |
| update-every-10th | 1.96 |
| swap-rows | 1.19 |
| remove-row | 2.00 |
| clear | 2.98 |
