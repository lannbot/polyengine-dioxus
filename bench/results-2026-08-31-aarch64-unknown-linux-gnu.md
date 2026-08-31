# bench-rows results — 2026-08-31

- Deno: 2.9.5 (aarch64-unknown-linux-gnu)
- git rev: 3ed4390
- Box note: numbers are box-relative — compare columns within this run, not across machines. See bench/README.md.

| op | ms (median of 5) |
| --- | --- |
| create-1k | 7.70 |
| create-10k | 78.99 |
| append-1k | 77.94 |
| update-every-10th | 1.97 |
| swap-rows | 1.23 |
| remove-row | 2.30 |
| clear | 3.03 |
