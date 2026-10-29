---
id: work.cxl
summary: CXL filesystem studies and current validation limits.
updated: 2026-10-29
aliases:
- CXL
- DAXFS
- famfs
scope:
- corpus/research/system/memory
- corpus/projects/kernel-dev
handoff: Select a research question and its smallest falsification experiment. DAXFS inspection failures and guest CXL enumeration remain open; famfs is untested.
---

# work.cxl

## filesystem-studies

- Basis: explicit
- Status: active
- As of: 2026-10-29
- Evidence: [source](<../../corpus/research/system/memory/techniques/cxl-environments.md#request>)

The selected filesystem studies are DAXFS and Micron famfs.

## daxfs-validation-boundary

- Basis: observed
- Status: active
- As of: 2026-10-29
- Evidence: [source](<../../corpus/projects/kernel-dev/records/2026-10-29-daxfs-functional-validation.md#results>)
- Evidence: [source](<../../corpus/projects/kernel-dev/records/2026-10-29-daxfs-functional-validation.md#boundary>)

DAXFS filesystem and mmap cases passed in a single QEMU guest using NVDIMM-backed devdax; two inspection-tool cases failed and the overall run returned nonzero. Guest CXL discovery, multi-host behavior, crash recovery, hardware performance, and famfs remain unverified.
