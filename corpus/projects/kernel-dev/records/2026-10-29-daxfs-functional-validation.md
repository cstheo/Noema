---
record_id: 2026-10-29-daxfs-functional-validation
date: 2026-10-29
---

# DAXFS single-guest functional validation

## Request

> 请你尝试在 /Volumes/Dev/kernel-dev中验证daxfs

The selected studies are [DAXFS and Micron famfs](../../../research/system/memory/techniques/cxl-environments.md#request). This experiment tested DAXFS only.

## Environment and revisions

- Platform: `/Volumes/Dev/kernel-dev` at `d683ed1a686ff3a3e5a172a9bfdd447f9da6c20b`, with pre-existing unrelated changes. Experiment: `projects/daxfs/`.
- [DAXFS](https://github.com/multikernel/daxfs) at `11ab401585b79b4a7c9164019852e0219e197d13`; no tracked upstream changes or compatibility patches.
- Prepared kernel source: `kernel/xmfs` at `931c184ca2c72dadbee2ddc8b47fb6df85bea0bd`, with pre-existing changes. It was mounted read-only; no kernel rebuild occurred.
- Guest: Ubuntu 24.04, x86_64 Linux `6.6.0 #26 SMP PREEMPT_DYNAMIC Mon Sep 7 21:16:00 UTC 2026`. GCC 13.3.0; the minimal init shell requires an exported PATH.
- Host: macOS, QEMU 11.0.0, q35/TCG, `cpu=max`, two vCPUs, 1536 MiB RAM. Build image: `kernel-dev-daxfs:ubuntu-24.04`, ARM64 Ubuntu 24.04 with GCC 13 x86 cross-compilation.

## Isolation

The existing QCOW2 used `snapshot=on`; the kernel-dev 9P share was read-only. A disposable 258 MiB NVDIMM backing file was created outside the nearly-full development volume and removed after QEMU exited. Original source/configuration and images were preserved. The experiment scripts and build image remain available; Colima was stopped after the run.

## Build and fixture

```sh
make -C /work/kernel/xmfs M=/experiment/repo/daxfs ARCH=x86 CROSS_COMPILE=x86_64-linux-gnu- modules
ndctl create-namespace --force --reconfig=namespace0.0 --mode=devdax
```

`/work` was the read-only platform mount; `/experiment` was the writable project directory. The x86-64 module built and loaded. Guest tools/tests used `make -C tools CC=gcc` and `make -C tests CC=gcc`.

The existing kernel lacks DMA heap support and CXL_BUS. Simulated NVDIMM produced `/dev/dax0.0` (250 MiB, 2 MiB alignment); DAXFS used 128 MiB with the COHERENT backend. The guest-only overlay fixture replaced `/dev/dma_heap/system` and `-H` with `/dev/dax0.0` and `-D`. Test bodies and assertions stayed unchanged. A preflight required a real DAXFS mount before counting accepted results.

## Results

| Check | Result |
| --- | --- |
| External module compile/load | Passed without upstream source changes |
| Overlay/page-cache suite | **18/20 passed**: file reads, updates, namespace operations, and directory iteration |
| mmap suite | **10/10 passed**: shared/private mappings, syscall visibility, fork, offset/large mappings, and reopen |
| Unmount/remount | Written data was visible after remount with `validate,mem_model=coherent` |
| Module unload | Passed after unmount |
| Overall script | **Exit 1**, retaining the two inspection failures |

```text
DAXFS_VALIDATION_RESULT overlay=1 mmap=0 inspect_mount=1 remount=0
```

## Inspection failures

`Inspect status` and `Inspect overlay` call `daxfs-inspect -m MOUNTPOINT`. At this revision, `open_mount()` uses `DAXFS_IOC_GET_DMABUF` without a devdax fallback and reported `not a dma-buf backed mount`. The suggested physical-memory `-p/-s` route also failed: `/dev/mem` with `O_SYNC` requested uncached-minus mappings while this environment supplied write-back mappings (`mmap /dev/mem: Resource temporarily unavailable`). These cases remain failed.

An earlier failed physical-memory fixture printed some ordinary-directory PASS lines; those are excluded from the reported counts. The accepted results come from the mounted devdax fixture and final logs.

## Artifacts and reproduction

The experiment entry is `/Volumes/Dev/kernel-dev/projects/daxfs/README.md`. From the platform root:

```sh
colima start
docker build -t kernel-dev-daxfs:ubuntu-24.04 -f projects/daxfs/build/Dockerfile projects/daxfs/build
bash projects/daxfs/build-module.sh
python3 projects/daxfs/run.py
```

The guest executes `projects/daxfs/guest-test.sh` through the read-only share. Final evidence is in ignored `projects/daxfs/runs/guest-overlay-devdax.log`, `guest-mmap-final.log`, `guest-validation-final.log`, and `summary.json`.

## Boundary

This establishes one-guest COHERENT functional behavior on simulated NVDIMM-backed devdax. Remount visibility is not power-failure recovery. Guest CXL discovery, the CXL3 backend, multiple hosts, physical persistence, hardware performance, and famfs remain untested. The separate [CXL environment audit](2026-10-29-cxl-environment-audit.md) identifies the guest-configuration gap.
