// Daily notes are the shared task source for the dashboard and mobile bridge.
const fs = require("node:fs");
const nativePath = require("node:path");
const vaultRoot = fs.realpathSync(app.vault.adapter.basePath);
function relativePath(value, allowEmpty = false) {
  if (typeof value !== "string" || /[\x00-\x1f]/.test(value) || nativePath.isAbsolute(value)
    || nativePath.win32.isAbsolute(value)) throw new Error("Daily note paths must be relative to the vault.");
  const path = value.replaceAll("\\", "/").replace(/\/{2,}/g, "/").replace(/\/$/, "");
  if ((!path && !allowEmpty) || path.split("/").some(part => part === "." || part === "..")) {
    throw new Error("Daily note paths must stay inside the vault.");
  }
  return path;
}
function assertVaultPath(relative) {
  const path = relativePath(relative);
  const parts = path.split("/");
  let current = vaultRoot;
  for (let index = 0; index < parts.length; index++) {
    current = nativePath.join(current, parts[index]);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) { if (error.code === "ENOENT") break; throw error; }
    if (stat.isSymbolicLink()) throw new Error("Refusing a daily note path through a symbolic link.");
    if (index < parts.length - 1 && !stat.isDirectory()) throw new Error("A daily note parent is not a directory.");
  }
  return nativePath.join(vaultRoot, path);
}
// Rust deploys this projection from tools/config.toml. Do not maintain JS defaults.
const configPath = `${app.vault.configDir}/noema.json`;
if (!(await app.vault.adapter.exists(configPath))) throw new Error("Deploy Noema tools/config.toml before opening the dashboard.");
const config = JSON.parse(await app.vault.adapter.read(configPath));
const settings = { ...config.journal };
const zoneFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: config.timezone, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
});
// Canonical keys stay ASCII; locale is applied only when rendering labels.
function zonedMoment(value = Date.now()) {
  const timestamp = new Date(value).valueOf();
  const fields = Object.fromEntries(zoneFormatter.formatToParts(timestamp).map(part => [part.type, part.value]));
  const wall = Date.UTC(+fields.year, +fields.month - 1, +fields.day, +fields.hour, +fields.minute, +fields.second);
  const offset = (wall - Math.floor(timestamp / 1000) * 1000) / 60000;
  return moment(timestamp).utcOffset(offset).locale("en");
}
settings.folder = relativePath(settings.folder);
settings.format = relativePath(settings.format);
settings.template = relativePath(settings.template, true);
function taskLabel(text) {
  return String(text).split("\n")[0]
    .replace(/\s+\^[A-Za-z0-9-]+\s*$/, "")
    .replace(/\s*(?:📅|⏳|🛫|➕|✅|❌)\s*\d{4}-\d{2}-\d{2}/gu, "")
    .replace(/\s*🔁[^📅⏳🛫➕✅❌]*/gu, "")
    .replace(/[🔺⏫🔼🔽⏬]/gu, "")
    .replace(/\[\[([^|\]]+)(?:\|([^\]]+))?\]\]/g, (_, path, alias) => alias || path)
    .trim();
}
function sourceTasks(file, snapshot) {
  let fence = "";
  let inTasks = false;
  return snapshot.split("\n").flatMap((raw, index) => {
    const marker = raw.match(/^\s*(?:>\s*)*(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = "";
      return [];
    }
    if (fence) return [];
    if (/^#{1,2}\s+/.test(raw)) {
      inTasks = /^##\s+Tasks\s*$/i.test(raw);
      return [];
    }
    if (!inTasks) return [];
    const match = raw.match(/^\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[(.)\]\s+(.*?)(?:\r)?$/);
    if (!match) return [];
    const due = match[2].match(/📅\s*(\d{4}-\d{2}-\d{2})/u)?.[1];
    const block_id = match[2].match(/\s+\^([A-Za-z0-9-]+)\s*$/)?.[1] || null;
    return [{ path: file.path, line: index, raw, block_id, status: match[1], completed: /x/i.test(match[1]), text: match[2],
      ...(due ? { due: { toMillis: () => moment.utc(due, "YYYY-MM-DD", "en", true).valueOf() } } : {}) }];
  });
}
function validCalendarDay(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || "")) return false;
  const date = new Date(`${day}T12:00:00Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === day;
}
function journalDate(day) {
  if (!validCalendarDay(day)) throw new Error("Choose a valid journal date.");
  return moment.utc(day, "YYYY-MM-DD", "en", true);
}
function journalPath(day) {
  return relativePath(`${settings.folder}/${journalDate(day).format(settings.format)}.md`);
}
function journalDay(path) {
  if (typeof path !== "string" || !path.endsWith(".md")) return undefined;
  if (!path.startsWith(`${settings.folder}/`)) return undefined;
  const relative = path.slice(settings.folder.length + 1, -3);
  const parsed = moment.utc(relative, settings.format, "en", true);
  if (!parsed.isValid()) return undefined;
  const day = parsed.format("YYYY-MM-DD");
  return validCalendarDay(day) && journalPath(day) === path ? day : undefined;
}
function journalFiles() {
  return app.vault.getMarkdownFiles().filter(file => journalDay(file.path));
}
function assertJournalPath(path) {
  if (!journalDay(path)) throw new Error("This note is outside the configured daily notes.");
  return assertVaultPath(path);
}
async function ensureJournal(day) {
  const path = journalPath(day);
  assertJournalPath(path);
  const existing = app.vault.getFileByPath(path);
  if (existing) return existing;
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i++) {
    const folder = parts.slice(0, i).join("/");
    assertVaultPath(folder);
    const current = app.vault.getAbstractFileByPath(folder);
    if (current) {
      if (!Array.isArray(current.children)) throw new Error(`A file already exists at ${folder}.`);
      continue;
    }
    try { await app.vault.createFolder(folder); }
    catch (error) { if (!Array.isArray(app.vault.getAbstractFileByPath(folder)?.children)) throw error; }
  }
  let content = `# ${day}\n\n## Tasks\n\n## Notes\n\n## Review\n`;
  if (settings.template) {
    const template = settings.template;
    const templatePath = /\.md$/i.test(template) ? template : `${template}.md`;
    assertVaultPath(templatePath);
    if (!(await app.vault.adapter.exists(templatePath))) throw new Error(`Daily note template not found: ${templatePath}`);
    const date = journalDate(day);
    const now = zonedMoment();
    const title = path.split("/").at(-1).replace(/\.md$/, "");
    content = (await app.vault.adapter.read(templatePath)).replace(/\{\{\s*(date|time|title)(?:\s*:\s*([^}]+))?\s*\}\}/g,
      (_, field, format) => field === "title" ? title
        : (field === "date" ? date : now).format(format?.trim() || (field === "date" ? "YYYY-MM-DD" : "HH:mm")));
  }
  assertJournalPath(path);
  try { return await app.vault.create(path, content); }
  catch (error) { const file = app.vault.getFileByPath(path); if (!file) throw error; return file; }
}
function appendTask(content, line) {
  const lines = content.split("\n");
  let fence = "";
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const marker = lines[i].match(/^\s*(?:>\s*)*(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = "";
      continue;
    }
    if (fence) continue;
    if (start < 0 && /^##\s+Tasks\s*$/i.test(lines[i])) start = i + 1;
    else if (start >= 0 && end === lines.length && /^#{1,2}\s+/.test(lines[i])) end = i;
  }
  if (fence) throw new Error("Close the Markdown code fence before adding a task.");
  if (start < 0) return `${content.trimEnd()}\n\n## Tasks\n\n${line.trim()}\n`;
  while (end > start && !lines[end - 1].trim()) end--;
  lines.splice(end, 0, "", line.trim(), "");
  return lines.join("\n");
}
return { config, zonedMoment, taskLabel, sourceTasks, validCalendarDay, journalFiles, journalDay, journalPath, assertJournalPath, ensureJournal, appendTask, settings };
