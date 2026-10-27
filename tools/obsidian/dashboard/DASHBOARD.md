---
cssclasses:
  - noema-homepage
---
```dataviewjs
const directory = "tools/obsidian/dashboard";
const source = await dv.app.vault.adapter.read(`${directory}/view.js`);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
await new AsyncFunction("dv", "input", source)(dv, { directory });
```
