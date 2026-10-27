# Zotero integration

Connects Zotero's library, PDFs, annotations, and shared paper notes to Obsidian through the local API.

Open **My Library** from [Research](../../../../corpus/research/README.md). Keep Zotero open. Filter tags with **Match all/any**, sort results, and refresh after metadata changes.

## Paper notes

[fields.json](../../../../corpus/research/fields.json) defines routing. A parent paper's `field:<id>` tag selects its field; unique topic-tag or configured collection-key matches provide defaults. Missing or ambiguous matches go to `corpus/research/papers/`.

In **Paper notes**, choose a field to move all active Markdown notes and route future child notes. **Use Zotero mapping** clears this local override. Classification preserves Zotero tags, collections, UUIDs, and sync baselines. Discovery runs at startup and the configured refresh interval while Obsidian is open.

In a PDF, use **Highlight / Underline in Zotero** for shared marks. **Add selection to note** opens a source-linked Markdown draft. PDF++ backlinks support local concept notes and synthesis.

Choose **Enable writeback** and approve **Noema Obsidian** in Zotero. **Sync notes** sends edits back; authorized notes also sync while their paper view or PDF is open. Review the saved Zotero version when both apps change a note.

Legacy notes under `papers/notes/` or `papers/unfiled/` migrate during refresh; interrupted moves recover on restart. Back up Markdown and its private registries, baselines, and recovery records together.

## Development

Preserve native PDF/PDF++ navigation, selection, and source links. Keep record identities and recovery behavior intact.

From the repository root:

```sh
node --test tools/obsidian/plugins/noema-zotero/tests/*.test.js
make -C tools obsidian ARGS=build-addon
```

Install the configured `.xpi` output in Zotero separately. The optional add-on initializes new blank child notes; existing notes stay unchanged.

[Obsidian setup and deployment](../../README.md)
