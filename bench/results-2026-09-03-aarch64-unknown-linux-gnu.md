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
