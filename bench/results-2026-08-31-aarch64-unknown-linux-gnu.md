# bench-rows results — 2026-08-31

- Deno: 2.9.5 (aarch64-unknown-linux-gnu)
- git rev: ccc3c50
- Box note: numbers are box-relative — compare columns within this run, not across machines. See bench/README.md.

| op | ms (median of 5) |
| --- | --- |
| create-1k | 7.10 |
| create-10k | 79.41 |
| append-1k | 79.05 |
| update-every-10th | 5.37 |
| swap-rows | 4.99 |
| remove-row | 2.09 |
| clear | 3.07 |
