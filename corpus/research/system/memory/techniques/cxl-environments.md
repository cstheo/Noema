---
title: CXL filesystem experiment environments
updated: 2026-10-29
---

# CXL filesystem experiment environments

## Request

On 2026-10-29 (Asia/Shanghai), the user stated:

> 我现在希望复现cxl中与fs相关的两个工作，一个是daxfs和famfs，我可以在macos中进行复现和运行吗

The selected studies are DAXFS and Micron famfs, distinct from the older HewlettPackard/FAMfs project.

## Sources

Reviewed upstream source/documentation on 2026-10-29:

- DAXFS repository: https://github.com/multikernel/daxfs ; default-branch head reported by GitHub API: `11ab401585b79b4a7c9164019852e0219e197d13`.
- DAXFS build requirements: https://github.com/multikernel/daxfs/blob/main/README.md#building ; Linux kernel build plumbing: https://github.com/multikernel/daxfs/blob/main/Makefile . README states Linux 5.11+ and `CONFIG_FS_DAX`; that lower bound does not guarantee compatibility with every newer kernel.
- DAXFS coherence contract: https://github.com/multikernel/daxfs/blob/main/docs/COHERENCE.md ; checked source at the recorded revision: https://github.com/multikernel/daxfs/blob/11ab401585b79b4a7c9164019852e0219e197d13/daxfs/coherence.h .
- famfs user-space repository: https://github.com/cxl-micron-reskit/famfs ; default-branch head reported by GitHub API: `d78e10f38c3bbe699e864dfb3e9bc81f47c4de37`. This is distinct from the older HewlettPackard/FAMfs Gen-Z project.
- famfs setup: https://github.com/cxl-micron-reskit/famfs/blob/master/markdown/getting-started.md .
- famfs virtual devdax recipe: https://github.com/cxl-micron-reskit/famfs/blob/master/markdown/vm-configuration.md . Web representations of this moving document disagreed in older EFI details; no specific EFI workaround is endorsed here. Pin and inspect the chosen revision before execution.
- famfs FUSE design: https://github.com/cxl-micron-reskit/famfs/blob/master/markdown/famfs-fuse-design-notes.md .
- QEMU acceleration/platform support: https://www.qemu.org/docs/master/system/introduction.html .
- QEMU CXL emulation scope: https://www.qemu.org/docs/master/system/devices/cxl.html .

## Findings

The inspected host reported `Darwin arm64`.

Both filesystems depend on Linux kernel facilities and cannot be mounted natively by macOS using their existing implementations. DAXFS builds a Linux kernel module and requires suitable directly addressable memory backing. Famfs requires a compatible Linux kernel and at least one real or virtual devdax device. Its FUSE version adds Linux-specific kernel/FUSE support (including `CONFIG_FUSE_FAMFS_DAX`, `GET_FMAP`, and `GET_DAXDEV`); ordinary macFUSE is not sufficient.

The famfs project documents basic tests with simulated pmem converted to devdax, and file-backed virtual pmem shared between guests. Its examples use a Linux/libvirt host; they are evidence for the simulated-device approach, not proof that the exact recipe runs unchanged on macOS.

On this arm64 Mac, QEMU 11/TCG ran x86_64 Linux 6.6 and DAXFS on simulated NVDIMM-backed devdax. The functional experiment passed 18/20 overlay checks and 10/10 mmap checks; two inspection checks failed. Famfs and arm64 guest compatibility remain untested.

DAXFS explicitly supports the COHERENT backend within one hardware cache-coherence domain. The CXL3 backend is a scaffold, with real cross-host atomics, publication ordering, and failure behavior still subject to validation. Its `coherence.h` routes both backends to the same current primitives and retains CXL TODOs. Selecting `mem_model=cxl3` over coherent RAM does not establish real inter-host coherence.

QEMU's CXL documentation describes functional device/topology emulation; it explicitly does not emulate the coherence protocol generally and limits the documented setup to a single static host. Shared backing files or two guests do not by themselves reproduce real multi-host CXL protocol, ordering, failure, or performance behavior.

## Reproduction boundary

| Goal | Assessment |
| --- | --- |
| Native macOS mounts | Unsupported by the existing implementations. |
| DAXFS single-guest build, mount, file access, and mmap | Functional baseline completed on simulated devdax; two inspection checks remain failed. |
| Famfs single-guest operation | Untested; requires compatible Linux/devdax and famfs support. |
| Guest CXL bus, region provisioning, and DAX access | Pending; only host-side topology realization was verified. |
| Multiple guests sharing emulated memory | A later controlled software experiment; correctness assumptions need explicit validation. |
| Real CXL latency, bandwidth, cross-host coherence, and physical failure behavior | Requires suitable Linux/CXL hardware and topology; QEMU/TCG measurements do not reproduce those results. |

Next steps: resolve the DAXFS inspection failures, test famfs separately with a compatible guest, and add an isolated CXL-enabled guest kernel/profile to verify enumeration, region provisioning, and DAX access. Multi-host experiments require an explicit coherence and failure model. A remote x86_64 Linux host with KVM remains an alternative to local cross-architecture emulation. These are recommendations, not adopted environment decisions.

[Memory Systems](../README.md)
