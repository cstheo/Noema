---
record_id: 2026-10-29-zotero-reorganization
date: 2026-10-29
---

# Zotero collection reorganization

## Request

Original organization concern:

> 目前zotero paper收录了大量不知名（非CCFA）会议或期刊，导致整体目录组织杂乱，而且目前System的大分类过于庞大，请你思考可以如何进行更好地在zotero中组织papers

Approved scope:

> 就按这个方案整理 Zotero，拆分 System，收拢零散的 venue 分支，并建立 CXL 和 Kernel Architecture 的研究集合。保留现有论文、PDF、笔记和标签，不删除条目。

## Outcome

At local API versions `10901` → `11253`, the library moved from 171 to 133 active collections. The adopted navigation is documented in [Research](../README.md#zotero-organization): **01 Research**, **02 Venues**, and **03 References**. Research views add memberships to existing items without duplicating bibliography or files.

The existing Architecture/Operating Systems container keys and retained venue/year collection keys were preserved. Sparse historical and supporting branches moved into Foundations/Related Work. Forty-eight emptied collections were reversibly retired; no item was deleted and Trash was not emptied. No CCF or reading-status labels were assigned.

## Preservation verification

Recorded local checks preserved all **2,838 active regular items** and the complete **5,467-item identity set**, including children and existing Trash. Existing PDFs, note/annotation data, bibliographic fields, raw tags, and Noema routing were preserved. Expected changes were collection memberships and associated write-version/date metadata. Saved searches were empty before and after.

A tag-array ordering difference was examined before retirement proceeded; tag names and values were unchanged. Cloud sync completion and paper-reading progress were not verified.

## Method and recovery

Writes used the authorized running Zotero API with current object versions, limited to collection changes and memberships. No direct SQLite writes, uploads, or bibliography-content edits were made.

Private recovery data is under `.local/zotero/organization/2026-10-29/`: before/after library snapshots, the collection plan, write receipts, and `rollback-map.json`. The rollback map retains original collection keys, names, parents, and memberships. Restore using current version preconditions and `deleted=false`; retire new empty collections afterward. Original items and attachments must not be replaced during recovery.

| Entry point | Collection key |
| --- | --- |
| 01 Research | `E5HLD4AA` |
| 02 Venues | `676W9AVA` |
| 03 References | `XF27ZAM7` |
| CXL | `SVJTKJA7` |
| Kernel Architecture | `GS927N6N` |

[Zotero collections and tags](https://www.zotero.org/support/collections_and_tags) explains the multiple-membership model. Current item counts and membership should be queried from Zotero rather than copied into long-term memory.
