# bench-rows results — 2026-09-04

- Deno: 2.9.5 (aarch64-unknown-linux-gnu)
- git rev: 813b31c-dirty
- Box note: numbers are box-relative — compare columns within this run, not across machines. See bench/README.md.

| op | ms (median of 5) |
| --- | --- |
| create-1k | 22.15 |
| create-10k | 192.22 |
| append-1k | 92.77 |
| update-every-10th | 5.39 |
| swap-rows | 3.47 |
| remove-row | 4.04 |
| clear | 7.44 |
