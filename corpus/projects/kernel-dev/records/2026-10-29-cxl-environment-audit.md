---
record_id: 2026-10-29-cxl-environment-audit
date: 2026-10-29
---

# CXL host-topology probe and guest gap

## Request

> 查看/Volumes/Dev/kernel-dev搭建的Linux环境，其可以进行qemu-cxl等环境的模拟吗？

## Environment

Inspected `/Volumes/Dev/kernel-dev` at `d683ed1a686ff3a3e5a172a9bfdd447f9da6c20b`, with existing unrelated changes. Native macOS QEMU reported 11.0.0. The launcher selected q35/TCG and virtio-pmem; it had no dedicated CXL topology model. No platform source, configuration, or image was changed.

## Static findings

- Current `kernel/xmfs`, `kernel/linux`, and `kernel/olk-6.6` configuration files all disabled `CONFIG_CXL_BUS`. These files were not matched to the configuration embedded in the existing boot images.
- The existing PMEM fragment supplied PMEM and DAX groundwork, not CXL driver configuration. No famfs-specific kernel extensions were configured.
- A temporary qemuctl profile generated a CXL command through machine properties and `advanced.extra_args`; preview success did not establish guest operation.

## Runtime probe

A paused QEMU TCG machine used 512 MiB RAM, a temporary 256 MiB CXL memory backing file, a 1 MiB label-storage file, one `pxb-cxl` bridge, one `cxl-rp` port, and one `cxl-type3` device. QMP negotiated capabilities, queried status and `info qtree`, then quit.

| Observation | Result |
| --- | --- |
| Process exit | 0 |
| QMP status | `prelaunch`, `running: false` |
| Device tree | All three expected CXL models present |
| QMP errors / stderr | None / empty |
| Existing guest resources | No kernel, rootfs, PMEM image, repository share, or network backend opened |

The reusable [probe script](../cxl-probe.py) preserves the command and QMP checks. Temporary backing files were removed on exit.

## Boundary and next requirement

This establishes host-side topology realization only. Guest enumeration, CXL region provisioning, DAX access, filesystems, multi-host behavior, persistence, and hardware performance were not tested.

A separate guest kernel/profile must enable applicable CXL/DAX support, boot, and verify driver binding, `cxl list`, region/namespace provisioning, and mmap access. Use isolated builds and fresh backing files. Later [DAXFS devdax validation](2026-10-29-daxfs-functional-validation.md) does not close this CXL guest gap.

[QEMU's CXL documentation](https://www.qemu.org/docs/master/system/devices/cxl.html) describes functional topology emulation for a static single host; shared backing files do not establish real cross-host coherence or hardware timing.
