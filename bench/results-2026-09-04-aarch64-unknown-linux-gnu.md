# bench-rows results — 2026-09-04

- Deno: 2.9.5 (aarch64-unknown-linux-gnu)
- git rev: 9f26b55-dirty
- Box note: numbers are box-relative — compare columns within this run, not across machines. See bench/README.md.

| op | bytes (ms, median of 5) | typed (ms, median of 5) | typed / bytes |
| --- | --- | --- | --- |
| create-1k | 9.51 | 15.97 | 1.68x |
| create-10k | 76.21 | 151.89 | 1.99x |
| append-1k | 85.77 | 90.89 | 1.06x |
| update-every-10th | 3.77 | 4.84 | 1.28x |
| swap-rows | 4.54 | 4.99 | 1.10x |
| remove-row | 3.05 | 5.56 | 1.82x |
| clear | 4.23 | 5.01 | 1.18x |
