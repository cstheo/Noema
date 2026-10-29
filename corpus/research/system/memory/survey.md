---
title: CXL research framework
updated: 2026-10-29
---

# CXL: ownership, coherence, and failure

## Request

On 2026-10-29 (Asia/Shanghai), the user asked:

> 请你帮我解释CXL，我可以如何展开基于CXL的research和survey

This is a proposed framework, not an adopted research question or a completed systematic review.

## Conceptual model

CXL is an interconnect for processors, memory devices, and accelerators. It reuses PCIe physical infrastructure and adds coherent cache/memory transactions. After software establishes a suitable mapping, application loads and stores can access device memory through the processor memory hierarchy; a load satisfied in a CPU cache does not generate a CXL transaction.

| Component | Meaning |
| --- | --- |
| CXL.io | PCIe-derived discovery, configuration, register access, interrupts, and I/O services. |
| CXL.cache | Allows a device to coherently cache host memory. |
| CXL.mem | Allows a host to access device-attached memory with memory semantics. |
| Type 1 | CXL.io and CXL.cache; no host-managed device memory requirement. |
| Type 2 | CXL.io, CXL.cache, and CXL.mem; accelerator with device memory. |
| Type 3 | CXL.io and CXL.mem; memory expansion, including volatile or persistent capacity. |

Do not confuse the absence of CXL.cache on a Type-3 device with an inability of host CPUs to cache mapped Type-3 memory. Device protocol support and the coherence contract of the whole multi-host topology are separate questions.

Distinguish three scenarios: expansion adds capacity to one host; pooling assigns capacity from a common resource to hosts, potentially with exclusive ownership at a time; sharing allows multiple hosts to access the same data and needs an explicit coherence, ordering, atomicity, and failure contract. These scenarios can coexist in a system.

CXL 1.x supplies direct host/device use cases; 2.0 adds single-level switching and pooling; 3.x expands fabrics, sharing, and coherence capabilities. The consortium announced 4.0 in November 2025, adding bandwidth, bundled-port, and RAS improvements. A standard feature does not establish its implementation in a particular CPU, switch, device, kernel, or artifact.

Linux can expose capacity through a DAX device for explicit mmap-based management, or add suitable capacity to its page allocator using dax_kmem/memory hotplug. These paths produce different software ownership and policy questions. Current documentation is not proof of support in the existing Linux 6.6 guest.

Memory access, coherent visibility, operation atomicity, filesystem consistency, and persistence are distinct properties. Persistent guarantees depend on the medium, cache/buffer persistence domain, ordering and flush requirements, and recovery protocol. Shared volatile memory may survive a client process failure without surviving loss of device power.

## Proposed survey scope

A useful first scope is: **From CXL memory access to shared-memory and storage abstractions: placement, ownership, coherence, and failure contracts.** Start with the broad system map, then deepen the shared-memory/filesystem branch connected to XMFS, DAXFS, and Micron famfs. This is a recommendation rather than an adopted scope.

Organize the survey around questions and assumptions rather than a sequence of paper summaries:

1. Which hardware/topology assumptions change between expansion, pooling, and sharing?
2. Who allocates, places, migrates, and reclaims data: kernel, application/runtime, device, or fabric manager?
3. Which contracts are delivered by hardware, and which must software implement?
4. What survives client, host, link, device, and power failure respectively?
5. Which evidence supports each claim: real hardware, NUMA proxy, functional emulation, calibrated simulation, or trace-driven analysis?

Include older DSM/PGAS, NUMA, RDMA, and persistent-memory antecedents when citation tracing identifies a necessary mechanism. CXL-tagged papers alone are not a complete historical scope. Use workshops and position papers where they challenge assumptions; venue rank is not a technical inclusion criterion.

## Collected topic map

The [initial library review](records/2026-10-29-cxl-library-review.md#inventory-findings) grouped collected titles and selected stored abstracts. This is a navigation aid, not a completed synthesis or a selected research agenda.

| Question | Collected examples |
| --- | --- |
| What does the actual device or evaluation environment expose? | [Demystifying CXL Memory with Genuine CXL-Ready Systems and Devices](zotero://select/library/items/QU83VZM6); [Systematic CXL Memory Characterization and Performance Analysis at Scale](zotero://select/library/items/W7DVTT9B); [Exploring Performance and Cost Optimization with ASIC-Based CXL Memory](zotero://select/library/items/2LT2NYZK); [Cylon: Fast and Accurate Full-System Emulation of CXL-SSDs](zotero://select/library/items/UVDRM6C8); [Xerxes: Extensive Exploration of Scalable Hardware Systems with CXL-Based Simulation Framework](zotero://select/library/items/AKHT35J2) |
| How are pooled capacity, topology, and transport managed? | [Direct Access, High-Performance Memory Disaggregation with DirectCXL](zotero://select/library/items/XIRGP93T); [Pond: CXL-Based Memory Pooling Systems for Cloud Platforms](zotero://select/library/items/QGSEEZBG); [Octopus: Enhancing CXL Memory Pods via Sparse Topology](zotero://select/library/items/5N8KDG66); [Building A CSFQ-Inspired Transport for Switched CXL Memory Pooling](zotero://select/library/items/9RBSEV3S); [Break On Through to the Other Side: Pooling Memory Elastically with RamRyder](zotero://select/library/items/PLMXDZTD) |
| What should be observed, placed, cached, or migrated? | [TPP: Transparent Page Placement for CXL-Enabled Tiered-Memory](zotero://select/library/items/MLJZLH9V); [Memtis: Efficient Memory Tiering with Dynamic Page Classification and Page Size Determination](zotero://select/library/items/IDEEV3FL); [Nomad: Non-Exclusive Memory Tiering via Transactional Page Migration](zotero://select/library/items/SBA99RS9); [NeoMem: Hardware/Software Co-Design for CXL-Native Memory Tiering](zotero://select/library/items/TW7QCE5X); [M5: Mastering Page Migration and Memory Management for CXL-based Tiered Memory Systems](zotero://select/library/items/RUY59RED); [Tiered Memory Management Beyond Hotness](zotero://select/library/items/2WTZE85B) |
| How do processes and runtimes use multi-host shared memory? | [HydraRPC: RPC in the CXL Era](zotero://select/library/items/G4R46E45); [cMPI: Using CXL Memory Sharing for MPI One-Sided and Two-Sided Inter-Node Communications](zotero://select/library/items/FCKGQDB3); [CXLfork: Fast Remote Fork over CXL Fabrics](zotero://select/library/items/6GJ54VLI); [Cxlalloc: Safe and Efficient Memory Allocation for a CXL Pod](zotero://select/library/items/6T4C9QZQ); [A Programming Model for Disaggregated Memory over CXL](zotero://select/library/items/BCGDZHUQ); [StarfishOS: Revisiting Single System Image on CXL with State-Partitioned Microkernel](zotero://select/library/items/J7FJ3M8P) |
| Which coherence, concurrency, and failure contracts are required? | [Partial Failure Resilient Memory Management System for (CXL-based) Distributed Shared Memory](zotero://select/library/items/FFDSUMQI); [Formalising CXL Cache Coherence](zotero://select/library/items/EEJRZPIL); [CXLMC: Model Checking CXL Shared Memory Programs](zotero://select/library/items/QECWJISM); [MEGALON: Efficient Data Sharing for Partly Coherent CXL Memory](zotero://select/library/items/GPX9LCLB); [XTRA: Unifying Cache Coherence and Concurrency Control for Distributed Transactions in a CXL Pod](zotero://select/library/items/MPSQZNBN) |
| What changes for memory-semantic storage? | [Overcoming the Memory Wall with CXL-Enabled SSDs](zotero://select/library/items/TJH95KIN); [ByteFS: System Support for (CXL-based) Memory-Semantic Solid-State Drives](zotero://select/library/items/2AZ4VS5H); [SkyByte: Architecting an Efficient Memory-Semantic CXL-based SSD with OS and Hardware Co-design](zotero://select/library/items/YS2TS42B); [XHarvest: Rethinking High-Performance and Cost-Efficient SSD Architecture with CXL-Driven Harvesting](zotero://select/library/items/G33A3TQL); [Borges: A Low-Latency Distributed Shared Log on a CXL Memory/SSD Hybrid](zotero://select/library/items/KB5SF98T) |
| How should database engines and indexes use CXL? | [Tigon: A Distributed Database for a CXL Pod](zotero://select/library/items/5UXS5UVX); [SIDLE: Tree-structure Aware Indexes for CXL-based Heterogeneous Memory](zotero://select/library/items/6FFZ2D3P); [An Examination of CXL Memory Use Cases for In-Memory Database Management Systems Using SAP HANA](zotero://select/library/items/GSV7LGU9); [CXL and the Return of Scale-Up Database Engines](zotero://select/library/items/BN725VA9) |
| Where do ML workloads benefit from capacity or near-data execution? | [CXL-ANNS: Software-Hardware Collaborative Memory Disaggregation and Computation for Billion-Scale Approximate Nearest Neighbor Search](zotero://select/library/items/SZZANMXL); [PIM Is All You Need: A CXL-Enabled GPU-Free System for Large Language Model Inference](zotero://select/library/items/YZH9I5ZW); [Beluga: A CXL-Based Memory Architecture for Scalable and Efficient LLM KVCache Management](zotero://select/library/items/7F5GU9PY); [CARINA: An Efficient CXL-Oriented Embedding Serving System for Recommendation Models](zotero://select/library/items/UGG9IXV4); [LIA: A Single-GPU LLM Inference Acceleration with Cooperative AMX-Enabled CPU-GPU Computation and CXL Offloading](zotero://select/library/items/U35IRNRZ) |

## Initial question-driven reading

| Question | Reading | Extraction target |
| --- | --- | --- |
| How does the interconnect work? | An Introduction to the Compute Express Link (CXL) Interconnect; official architecture documentation | Protocol direction, device types, topology and version dependencies. |
| How have surveys already organized the field? | Next-Gen Computing Systems with Compute Express Link, arXiv v2 | Compare its single-machine/distributed taxonomy with the proposed contract/evidence axes. |
| When is a NUMA proxy misleading? | Demystifying CXL Memory; existing Systematic CXL Memory Characterization paper | Identify which findings depend on the actual host/device and which extrapolate. |
| What should placement policies optimize? | TPP; Nomad | Hot/cold placement, exclusive versus non-exclusive tiers, migration cost, memory pressure, and policy overhead. |
| When does pooling pay? | Pond; A Case Against CXL Memory Pooling | Compare workload/VM distributions, packing assumptions, latency sensitivity, infrastructure cost, and objectives. Do not treat different assumptions as a resolved contradiction. |
| How can hosts share data under limited coherence and partial failure? | CXL-SHM (Partial Failure Resilient Memory Management System); MEGALON | Separate the papers' fault-management and coherence-management questions; inspect the exact hardware and fencing assumptions. |
| How do memory and storage interfaces meet? | DAXFS and Micron famfs project documentation; ByteFS paper | Separate shared-memory filesystems from memory-semantic SSDs. Check backing medium, supported APIs, publication rules, and durability rather than grouping by filesystem names. |

The introduction, comprehensive survey, and counterargument are reading pointers whose presence in the local library was not checked. DAXFS/famfs are reproduction targets, not confirmed paper-title matches.

## Evidence matrix

For each selected work, compare these dimensions in its paper note. Use exact sections/figures and inspected paper/artifact revisions; mark unknown rather than guessing.

| Field | What to record |
| --- | --- |
| Research question | Concrete workload, bottleneck, and objective. |
| Platform | CXL generation, real device, hosts, topology, CPU/ISA, and kernel. |
| Access and ownership | System RAM, device DAX, filesystem/mmap, pointers/offsets, allocation and reclamation owner. |
| Contract | Coherence scope, memory ordering, atomics, publication/visibility, application or filesystem consistency. |
| Failure and persistence | Failed components, detection/fencing, surviving state, persistence domain, flush and recovery assumptions. |
| Mechanism and cost | Management location, byte/cache-line/page/object/file granularity, metadata, copies, cache management, migration and CPU overhead. |
| Evaluation | Hardware/proxy/emulator/simulator, workloads, working sets, capacity/bandwidth budgets, baselines, ablations, and tail latency. |
| Claim boundary | What was measured or proven, what was assumed, and where the result fails to generalize. |

Cross-paper speedup numbers require compatible workloads, capacities, hardware, and semantics. Compare mechanisms and assumptions first; a larger reported speedup is not a cross-paper ranking.

## Candidate research hypotheses

These are falsifiable starting hypotheses, not established gaps or claims of novelty.

- **Ownership and publication for shared files:** for an explicitly declared single-writer or close-to-open contract, test whether ownership transfer and batched publication can reduce cache-management and metadata costs while satisfying that contract. Compare only implementations with compatible guarantees. Measure stale-read violations, transfer cost, metadata traffic, throughput and tail latency; vary sharing granularity and writer handoff rate.
- **Partial failure and reclamation:** interrupt reference publication, allocation, metadata update, and ownership transfer. Check whether surviving clients preserve safety, reclaim resources, and continue. State the failure detector and fencing assumptions. A process kill under one coherent host does not validate cross-host ordering or loss of device power.
- **Tier placement with filesystem knowledge:** test whether file/object lifecycle hints improve placement over measured policy baselines under specified memory pressure. Account for hint collection, migration, copies, and control overhead. This is an alternate branch requiring evidence about the selected workloads and memory tiers.

For any candidate, first state the observation, hypothesis, closest existing work, minimal mechanism, success/failure metrics, and a counterexample that would disprove its value. Read the closest work's full design and evaluation before claiming a gap. Ask which CXL-specific property changes the problem relative to NUMA, RDMA, or persistent-memory predecessors.

## Experiment ladder

1. Reuse the single-host functional baseline to learn mapping, filesystem APIs, metadata and ownership. Unit/software fault injection can test a declared software model only.
2. Add an isolated CXL-enabled guest kernel/profile to validate enumeration, region creation, DAX exposure and application access. Preserve original images and independent XMFS work.
3. Use a suitable, validated model or hardware setup for multi-host coherence, visibility and failure questions. Shared QEMU files do not automatically supply the intended CXL contract.
4. Use real hardware for hardware latency/bandwidth/tail behavior and deployment claims. A simulator needs explicit calibration and supported features for any extrapolation.

QEMU's general CXL documentation describes functional emulation, does not generally emulate a cache-coherence protocol, and scopes its description to a static single host. Timing collected in the current macOS/TCG setup is not genuine CXL hardware performance.

## Primary sources

Sources accessed 2026-10-29; selected architecture/abstract passages informed this framework.

- [CXL overview and current specification generation](https://computeexpresslink.org/about-cxl/).
- [Consortium architecture and version overview](https://computeexpresslink.org/blog/understanding-the-benefits-of-cxl-in-datacenter-environments-use-cases-and-implementations-1046/).
- [CXL 4.0 release announcement](https://computeexpresslink.org/wp-content/uploads/2025/11/CXL_4.0-Specification-Release_FINAL_Website-Copy.pdf).
- [Linux CXL DAX driver](https://docs.kernel.org/driver-api/cxl/linux/dax-driver.html).
- [CXL persistence/RAS whitepaper](https://computeexpresslink.org/wp-content/uploads/2023/12/CXL-RAS-Whitepaper-Post-WG-Revision_FINAL.pdf).
- [QEMU CXL scope](https://www.qemu.org/docs/master/system/devices/cxl.html).
- [CXL introduction, arXiv v3](https://arxiv.org/abs/2306.11227v3).
- [Comprehensive survey, arXiv v2](https://arxiv.org/abs/2412.20249v2).
- [Demystifying CXL Memory, author abstract](https://arxiv.org/abs/2303.15375).
- [TPP, arXiv v2](https://arxiv.org/abs/2206.02878v2).
- [Nomad, OSDI 2024](https://www.usenix.org/conference/osdi24/presentation/xiang).
- [Pond, official ASPLOS version on author institution](https://www.microsoft.com/en-us/research/wp-content/uploads/2022/10/2023_Pond_asplos23_official_asplos_version.pdf).
- [A Case Against CXL Memory Pooling, HotNets 2023](https://conferences.sigcomm.org/hotnets/2023/papers/hotnets23_levis.pdf).
- [CXL-SHM, author-hosted SOSP 2023 paper, inspected interface/recovery passages](https://madsys.cs.tsinghua.edu.cn/publication/partial-failure-resilient-memory-management-system-for-cxl-based-distributed-shared-memory/SOSP23-zhang.pdf).
- [MEGALON, OSDI 2026](https://www.usenix.org/conference/osdi26/presentation/hu-jiyu).
- [ByteFS, author abstract](https://arxiv.org/abs/2501.04993).

## Local experiments

See [DAXFS functional validation](../../../projects/kernel-dev/records/2026-10-29-daxfs-functional-validation.md) and [CXL environment audit](../../../projects/kernel-dev/records/2026-10-29-cxl-environment-audit.md). Their single-guest results do not establish multi-host CXL behavior or hardware performance.

[Memory Systems](README.md)
