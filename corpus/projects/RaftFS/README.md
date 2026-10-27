---
title: RaftFS
---

# RaftFS

Go filesystem combining Raft replication with a Linux FUSE interface.

- [Source README](sources/README.md)
- [Overview](sources/docs/architecture/system-overview.md) · [Design](sources/docs/architecture/detailed-design.md)
- [Consensus](sources/pkg/raft/) · [Replication](sources/pkg/rsm/) · [State machine](sources/pkg/fsm/)
- [FUSE](sources/pkg/fuse/) · [Network](sources/pkg/network/) · [Storage](sources/pkg/storage/)
- [Operation guides](sources/docs/guides/) · [Development](sources/docs/development/)

Separate replicated-state consistency, client-cache visibility, and file-byte recovery.

[Projects](../README.md)
