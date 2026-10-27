// The homepage uses vault metadata; activity represents each note's last modification date.
const app = dv.app;
const moment = window.moment;
const dashboardDir = input?.directory || "tools/obsidian/dashboard";
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const { config, zonedMoment, taskLabel, sourceTasks, validCalendarDay, journalFiles, journalDay, assertJournalPath, ensureJournal, appendTask }
  = await new AsyncFunction("app", "moment", await app.vault.adapter.read(`${dashboardDir}/tasks.js`))(app, moment);
const dashboardPagePath = `${dashboardDir}/DASHBOARD.md`;
const calendarPagePath = `${dashboardDir}/CALENDAR.md`;
const homePath = dv.currentFilePath || input?.homePath || dashboardPagePath;
const isExpandedCalendar = Boolean(input?.expandedCalendar);
const renderExpandedCalendar = isExpandedCalendar
  ? new Function("ctx", await app.vault.adapter.read(`${dashboardDir}/calendar.js`)) : null;
const now = () => zonedMoment();
const dayKey = timestamp => zonedMoment(timestamp).format("YYYY-MM-DD");
// Dataview reuses its component when re-rendering; dispose our previous handlers first.
dv.container._noemaHomepageCleanup?.();
const disposers = [];
let disposed = false;
function onDispose(callback) {
  if (disposed) callback();
  else disposers.push(callback);
}
function cleanup() {
  if (disposed) return;
  disposed = true;
  disposers.splice(0).forEach(callback => callback());
}
dv.container._noemaHomepageCleanup = cleanup;
dv.component.register(cleanup);
function isContentFile(file) {
  return file && ![homePath, dashboardPagePath, calendarPagePath, "AGENTS.md", "README.md"].includes(file.path)
    && !file.path.startsWith(`${vaultPath(app.vault.configDir)}/`)
    && !file.path.startsWith("tools/obsidian/")
    && !/^(?:templates\/|noema\/(assets|templates)\/)/.test(file.path);
}
const notes = app.vault.getMarkdownFiles().filter(isContentFile);
function taskDue(task) {
  return task.due?.toMillis?.() ?? Number.MAX_SAFE_INTEGER;
}
function taskPriority(task) {
  const rank = ["🔺", "⏫", "🔼", "", "🔽", "⏬"];
  const symbol = rank.find(value => value && String(task.text).includes(value)) || "";
  return rank.indexOf(symbol);
}
function noteTitle(file) {
  const cache = app.metadataCache.getFileCache(file);
  const custom = cache?.frontmatter?.title;
  if (typeof custom === "string" && custom.trim()) return custom;
  const title = cache?.headings?.find(heading => heading.level === 1)?.heading;
  if (title) return title;
  const aliases = cache?.frontmatter?.aliases;
  if (Array.isArray(aliases) && aliases.length) return String(aliases[0]);
  return file.basename.replace(/^\d+[-_]/, "").replaceAll("-", " ");
}
const root = dv.container.createDiv({ cls: "nh-dashboard" });
root.classList.toggle("is-expanded-calendar", isExpandedCalendar);
const iconPaths = {
  "calendar-days": '<path d="M8 2v4m8-4v4M3 10h18"/><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"/>',
  "file-plus-2": '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M12 12v6m-3-3h6"/>',
  "notebook-pen": '<path d="M4 3h12v7M4 21h10M4 3v18M2 7h4M2 12h4M2 17h4M14 19l6-6 2 2-6 6h-2z"/>',
  "search": '<circle cx="10.5" cy="10.5" r="7.5"/><path d="m16 16 5 5"/>',
  "sun-moon": '<path d="M9 3a6 6 0 0 0 0 12 7 7 0 0 1-6-12M18 2v2m0 12v2M10 10h2m12 0h-2m-10-6 2 2m8 8 2 2m0-12-2 2m-8 8-2 2"/><circle cx="18" cy="10" r="4"/>',
  "network": '<rect x="9" y="2" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="16" y="16" width="6" height="6" rx="1"/><path d="M12 8v4H5v4m7-4h7v4"/>',
  "sliders-horizontal": '<path d="M3 6h6m4 0h8M3 12h12m4 0h2M3 18h2m4 0h12"/><circle cx="11" cy="6" r="2"/><circle cx="17" cy="12" r="2"/><circle cx="7" cy="18" r="2"/>',
  "file-text": '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h6"/>',
  "graduation-cap": '<path d="m2 9 10-5 10 5-10 5zM6 11v6c4 3 8 3 12 0v-6M22 9v7"/>',
  "list-todo": '<path d="m3 6 2 2 3-4M12 6h9M12 12h9M12 18h9"/><rect x="3" y="11" width="4" height="4" rx="1"/><path d="M3 20h4"/>',
  "sparkles": '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5zM20 2v4m-2-2h4"/>',
  "arrow-up-right": '<path d="M7 17 17 7M7 7h10v10"/>',
  "sigma": '<path d="M18 4H6l7 8-7 8h12"/>',
  "book-open": '<path d="M12 5v16M3 3c4-1 7 0 9 2 2-2 5-3 9-2v16c-4-1-7 0-9 2-2-2-5-3-9-2z"/>',
  "files": '<rect x="7" y="2" width="13" height="16" rx="2"/><path d="M4 6H3v14a2 2 0 0 0 2 2h11v-1"/>',
  "leaf": '<path d="M20 3C9 2 3 8 5 15s12 8 15-12ZM4 21l11-11"/>',
  "chevron-right": '<path d="m9 5 7 7-7 7"/>',
  "chevron-left": '<path d="m15 5-7 7 7 7"/>',
  "chevron-down": '<path d="m5 9 7 7 7-7"/>',
  "arrow-left": '<path d="M19 12H5m7-7-7 7 7 7"/>',
  "circle-check": '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  "inbox": '<path d="m3 3-2 11v6a1 1 0 0 0 1 1h20a1 1 0 0 0 1-1v-6L21 3zM1 14h6l2 3h6l2-3h6"/>',
  "kanban": '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18M15 3v18M6 7v5M12 7v8M18 7v3"/>'
};

function element(parent, tag, cls, text) {
  return parent.createEl(tag, { cls, ...(text !== undefined ? { text } : {}) });
}
function icon(parent, name, cls = "nh-icon") {
  const node = element(parent, "span", cls);
  // These SVG paths are fixed design assets, never note content.
  node.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${iconPaths[name] || iconPaths["file-text"]}</svg>`;
  node.setAttribute("aria-hidden", "true");
  return node;
}
function button(parent, label, iconName, action, cls = "nh-button") {
  const node = element(parent, "button", cls);
  node.type = "button";
  if (iconName) icon(node, iconName);
  element(node, "span", "", label);
  node.addEventListener("click", async () => {
    node.disabled = true;
    try { await action(); }
    catch (error) {
      console.error("Noema homepage:", error);
      element(root, "p", "nh-error", "This action could not be completed. Please try again.");
    }
    finally { node.disabled = false; }
  });
  return node;
}
function command(id) {
  return () => app.commands.executeCommandById(id);
}
function link(parent, path, label, cls = "nh-link") {
  const node = element(parent, "a", cls, label);
  node.href = path;
  node.dataset.href = path;
  node.classList.add("internal-link");
  node.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    app.workspace.openLinkText(path, homePath, event.metaKey || event.ctrlKey);
  });
  return node;
}
function heading(parent, title, subtitle) {
  const row = element(parent, "div", "nh-panel-heading");
  element(row, "h2", "nh-section-title", title);
  if (subtitle) element(row, "span", "nh-caption", subtitle);
  return row;
}
function empty(parent, title, subtitle, iconName) {
  const node = element(parent, "div", "nh-empty");
  icon(node, iconName, "nh-empty-icon");
  element(node, "strong", "", title);
  if (subtitle) node.title = subtitle;
}
function vaultPath(path) {
  return String(path || "").replaceAll("\\", "/").replace(/\/{2,}/g, "/").replace(/^\/|\/$/g, "");
}
async function openJournal(day) {
  const file = await ensureJournal(day);
  await app.workspace.openLinkText(file.path, homePath, false);
}
async function openCalendarPage() {
  const file = taskFile(calendarPagePath);
  if (!file) throw new Error("The calendar page could not be found.");
  const existing = app.workspace.getLeavesOfType("markdown").find(leaf => leaf.view.file?.path === file.path);
  const leaf = existing || app.workspace.getLeaf("tab");
  await leaf.openFile(file, { active: true, state: { mode: "preview" } });
  await app.workspace.revealLeaf(leaf);
}
async function openDashboardPage() {
  const existing = app.workspace.getLeavesOfType("markdown").find(leaf => leaf.view.file?.path === dashboardPagePath);
  if (existing) return app.workspace.revealLeaf(existing);
  return app.workspace.openLinkText(dashboardPagePath, homePath, false);
}
function taskFile(path) {
  return app.vault.getFileByPath(path || "");
}
async function readTaskSource(file) {
  assertJournalPath(file.path);
  return app.vault.read(file);
}
async function readTaskSnapshot(path) {
  if (!journalDay(path)) throw new Error("This note is outside the daily notes.");
  const file = taskFile(path);
  if (file) {
    try { return [path, file, await readTaskSource(file)]; }
    catch (error) {
      // Vault and Dataview indexes can retain files moved or deleted outside Obsidian.
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return [path, null, ""];
}
async function processTaskSource(file, update) {
  assertJournalPath(file.path);
  await app.vault.process(file, content => {
    assertJournalPath(file.path);
    return update(content);
  });
}
async function openTaskSource(file) {
  return app.workspace.openLinkText(file.path, homePath, true);
}
async function addTask(day = now().format("YYYY-MM-DD")) {
  if (!validCalendarDay(day)) throw new Error("Choose a valid task date.");
  const line = await taskModal("editTaskLineModal", `- [ ] ⏳ ${day}`);
  if (!line.trim()) return;
  const file = await ensureJournal(day);
  await processTaskSource(file, content => appendTask(content, line));
}
async function setTaskCompleted(task, file, snapshot, completed) {
  if (task.completed === completed) return;
  const api = app.plugins.getPlugin("obsidian-tasks-plugin")?.apiV1;
  if (!api) throw new Error("Please enable the Tasks plugin.");
  const expected = snapshot.split("\n")[task.line];
  let replacement = api.executeToggleTaskDoneCommand(expected, file.path);
  if (!replacement.split("\n").some(line => {
    const match = line.match(/^\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[(.)\]/);
    return match && /x/i.test(match[1]) === completed;
  })) throw new Error("The Tasks plugin did not produce the requested completion state.");
  if (task.block_id) {
    let kept = false;
    replacement = replacement.split("\n").map(line => {
      const match = line.match(/^\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[(.)\]/);
      if (match && /x/i.test(match[1]) === completed && !kept) { kept = true; return line; }
      return line.replace(new RegExp(`\\s+\\^${task.block_id}\\s*$`), "");
    }).join("\n");
  }
  await replaceTask(task, expected, replacement);
}
function taskModal(method, line) {
  const api = app.plugins.getPlugin("obsidian-tasks-plugin")?.apiV1;
  if (!api) throw new Error("Please enable the Tasks plugin.");
  const doc = dv.container.ownerDocument;
  const previous = new Set(doc.querySelectorAll(".tasks-edit-modal-container"));
  const result = api[method](...(line === undefined ? [] : [line]));
  const modal = [...doc.querySelectorAll(".tasks-edit-modal-container")]
    .find(node => !previous.has(node));
  if (!modal) return result;
  // Tasks can leave its promise pending when a dialog is closed with Escape or X.
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (value, error) => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      window.clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const observer = new MutationObserver(() => {
      if (!modal.isConnected && timer === undefined) {
        timer = window.setTimeout(() => finish(""), 0);
      }
    });
    observer.observe(doc.body, { childList: true, subtree: true });
    Promise.resolve(result).then(value => finish(value), error => finish("", error));
  });
}
async function replaceTask(task, expected, replacement) {
  const file = taskFile(task.path);
  if (!file) throw new Error("The source note could not be found.");
  await processTaskSource(file, content => {
    const lines = content.split("\n");
    if (lines[task.line] !== expected) throw new Error("The task has changed. Refresh the homepage and try again.");
    lines.splice(task.line, 1, ...(replacement ? replacement.replace(/\n$/, "").split("\n") : []));
    return lines.join("\n");
  });
}
function taskBlockEnd(file, snapshot, task) {
  const lines = snapshot.split("\n");
  let end = task.line + 1;
  const indent = line => (line.match(/^[ \t]*(?:>[ \t]*)*/)?.[0] || "").replaceAll("\t", "    ").length;
  const level = indent(lines[task.line]);
  while (end < lines.length && (!lines[end].trim() || indent(lines[end]) > level)) end++;
  // Retain the spacing before the next task, heading, or settings footer.
  while (end > task.line + 1 && !lines[end - 1].trim()) end--;
  return end;
}
async function removeTask(file, snapshot, task) {
  let after;
  await processTaskSource(file, content => {
    if (content !== snapshot) throw new Error("The task source has changed. Refresh and try again.");
    const lines = content.split("\n");
    const current = sourceTasks(file, content).find(item => item.line === task.line);
    if (!current || current.status !== task.status || current.text !== task.text) {
      throw new Error("This task is no longer available.");
    }
    lines.splice(task.line, taskBlockEnd(file, content, task) - task.line);
    after = lines.join("\n");
    return after;
  });
  return { path: file.path, before: snapshot, after };
}
async function undoTaskRemoval(removal) {
  const file = taskFile(removal.path);
  if (!file) throw new Error("The source note could not be found.");
  await processTaskSource(file, content => {
    // Never restore an old document over a task added or edited since removal.
    if (content !== removal.after) throw new Error("The source changed after removal. Undo would overwrite newer edits.");
    return removal.before;
  });
}

// Banner and identity.
const hero = element(root, "section", "nh-hero");
const coverPath = input?.cover || `${dashboardDir}/paper.jpg`;
if (await app.vault.adapter.exists(coverPath)) {
  const resourcePath = app.vault.adapter.getResourcePath(coverPath);
  const image = element(hero, "img", "nh-cover");
  image.src = resourcePath;
  image.alt = "Snow-covered mountains and a village beneath the stars";
  image.decoding = "async";
}
const heroText = element(hero, "div", "nh-hero-text");
element(heroText, "h1", "nh-wordmark", "Noema");
const content = element(root, "div", "nh-content");
const intro = element(content, "div", "nh-intro");
const introText = element(intro, "div", "nh-intro-copy");
const greeting = element(introText, "h2", "nh-intro-title", "Welcome back.");
greeting.title = `${notes.length.toLocaleString()} notes in your corpus`;
const clock = element(intro, "div", "nh-clock");
const clockTime = element(clock, "time", "nh-clock-time");
const clockDate = element(clock, "span", "nh-clock-date");
let renderedDay = now().format("YYYY-MM-DD");
function tick() {
  clockTime.textContent = now().format("HH:mm");
  clockDate.textContent = now().locale(config.locale).format("MMM D · dddd");
  if (now().format("YYYY-MM-DD") !== renderedDay) {
    renderedDay = now().format("YYYY-MM-DD");
    app.commands.executeCommandById("dataview:dataview-force-refresh-views");
  }
}
tick();
const clockInterval = window.setInterval(tick, 30000);
onDispose(() => window.clearInterval(clockInterval));

const actions = element(intro, "nav", "nh-actions");
intro.insertBefore(actions, clock);
actions.setAttribute("aria-label", "Quick actions");
button(actions, "New note", "file-plus-2", command("file-explorer:new-file"));
button(actions, "Daily note", "notebook-pen", () => openJournal(now().format("YYYY-MM-DD")));
button(actions, "Search", "search", command("switcher:open"));
const weekStart = now().startOf("isoWeek").valueOf();

const catalogs = element(content, "nav", "nh-catalogs");
catalogs.setAttribute("aria-label", "Corpus navigation");
for (const [label, directory] of [["Courses", "courses"], ["Projects", "projects"], ["Research", "research"]]) {
  link(catalogs, `corpus/${directory}/README.md`, label, "nh-catalog-link");
}

// A single layout keeps visual and keyboard order aligned across screen sizes.
const workspace = element(content, "div", "nh-workspace");
const activity = element(workspace, "section", "nh-panel nh-activity");
const activityHeading = heading(activity, "Activity");
const yearControls = element(activityHeading, "div", "nh-year-controls");
const previousYear = element(yearControls, "button", "nh-year-button", "‹");
previousYear.type = "button";
previousYear.addEventListener("click", () => renderHeatmap(selectedYear - 1));
previousYear.setAttribute("aria-label", "Previous year");
const yearLabel = element(yearControls, "span", "nh-caption");
const nextYear = element(yearControls, "button", "nh-year-button", "›");
nextYear.type = "button";
nextYear.addEventListener("click", () => renderHeatmap(selectedYear + 1));
nextYear.setAttribute("aria-label", "Next year");
const activityCount = new Map();
notes.forEach(file => {
  const key = dayKey(file.stat.mtime);
  activityCount.set(key, (activityCount.get(key) || 0) + 1);
});
const chart = element(activity, "div", "nh-activity-chart");
const activityFoot = element(activity, "div", "nh-activity-foot");
const activitySummary = element(activityFoot, "span", "nh-caption");
const legend = element(activityFoot, "div", "nh-legend");
element(legend, "span", "", "Less");
for (let i = 0; i < 5; i++) element(legend, "span", `nh-heatmap-cell nh-level-${i}`);
element(legend, "span", "", "More");
let selectedYear = Number(dv.container._noemaHomepageYear) || now().year();
function renderHeatmap(year) {
  selectedYear = Math.min(year, now().year());
  dv.container._noemaHomepageYear = selectedYear;
  chart.empty();
  yearLabel.textContent = String(selectedYear);
  nextYear.disabled = selectedYear >= now().year();
  const first = now().year(selectedYear).startOf("year");
  const last = first.clone().endOf("year");
  const start = first.clone().startOf("isoWeek");
  const weekCount = last.clone().startOf("isoWeek").diff(start, "weeks") + 1;
  chart.style.setProperty("--nh-week-count", weekCount);
  const labels = element(chart, "div", "nh-weekdays");
  element(labels, "span", "nh-month-spacer");
  ["Mon", "", "Wed", "", "Fri", "", ""].forEach(label => element(labels, "span", "", label));
  const calendar = element(chart, "div", "nh-calendar-grid");
  const months = element(calendar, "div", "nh-months");
  for (let month = 0; month < 12; month++) {
    const date = first.clone().month(month).startOf("month");
    const column = date.clone().startOf("isoWeek").diff(start, "weeks");
    const label = element(months, "span", "", date.format("MMM"));
    label.style.gridColumn = `${column + 1} / span 3`;
  }
  const columns = element(calendar, "div", "nh-heatmap");
  columns.setAttribute("aria-label", `Notes by last modified date in ${selectedYear}`);
  let activeDays = 0;
  let noteCount = 0;
  for (let week = 0; week < weekCount; week++) {
    const column = element(columns, "div", "nh-heatmap-week");
    for (let day = 0; day < 7; day++) {
      const date = start.clone().add(week * 7 + day, "days");
      const inYear = date.year() === selectedYear;
      const future = date.isAfter(now(), "day");
      const count = inYear && !future ? activityCount.get(date.format("YYYY-MM-DD")) || 0 : 0;
      if (count) { activeDays++; noteCount += count; }
      const level = count === 0 ? 0 : count === 1 ? 1 : count <= 3 ? 2 : count <= 6 ? 3 : 4;
      const cell = element(column, "span", `nh-heatmap-cell nh-level-${level}`);
      cell.dataset.date = date.format("YYYY-MM-DD");
      cell.dataset.count = String(count);
      if (!inYear) { cell.classList.add("nh-outside-year"); continue; }
      cell.title = `${date.format("MMM D, YYYY")} · ${count} ${count === 1 ? "note" : "notes"} last edited on this day`;
      cell.setAttribute("aria-label", cell.title);
      if (future) cell.classList.add("nh-future");
      if (date.isSame(now(), "day")) cell.classList.add("nh-today");
    }
  }
  activitySummary.textContent = `${activeDays} active ${activeDays === 1 ? "day" : "days"}`;
  activitySummary.title = "Each note appears on its latest modification date. This is not a historical edit log.";
}
renderHeatmap(selectedYear);

// Recent notes with actual time filters.
const recent = element(workspace, "section", "nh-panel nh-recent");
heading(recent, "Recent notes");
const filters = element(recent, "div", "nh-filters");
filters.setAttribute("aria-label", "Filter recent notes");
const list = element(recent, "div", "nh-note-list");
function renderNotes(period) {
  list.empty();
  const startOfPeriod = period === "today" ? now().startOf("day").valueOf()
    : period === "week" ? weekStart
    : period === "month" ? now().startOf("month").valueOf() : 0;
  const matches = notes.filter(file => file.stat.mtime >= startOfPeriod)
    .sort((a, b) => b.stat.mtime - a.stat.mtime).slice(0, 5);
  if (!matches.length) {
    empty(list, "A quiet moment", "Try another time range to find your notes.", "leaf");
    return;
  }
  matches.forEach(file => {
    const row = link(list, file.path, "", "nh-note-row");
    const label = element(row, "span", "nh-note-label");
    element(label, "strong", "", noteTitle(file));
    element(row, "time", "nh-note-time", zonedMoment(file.stat.mtime).format("MM.DD"));
    icon(row, "chevron-right", "nh-note-arrow");
  });
}
const selectedPeriod = dv.container._noemaHomepagePeriod || "all";
[["Recent", "all"], ["Today", "today"], ["This week", "week"], ["This month", "month"]].forEach(([label, period]) => {
  const tab = button(filters, label, null, () => {
    for (const node of filters.children) {
      node.classList.remove("is-selected");
      node.setAttribute("aria-pressed", "false");
    }
    tab.classList.add("is-selected");
    tab.setAttribute("aria-pressed", "true");
    dv.container._noemaHomepagePeriod = period;
    renderNotes(period);
  }, "nh-filter");
  tab.classList.toggle("is-selected", period === selectedPeriod);
  tab.setAttribute("aria-pressed", String(period === selectedPeriod));
});
renderNotes(selectedPeriod);

const todo = element(workspace, "section", "nh-panel nh-todo");
workspace.append(todo, recent, activity);
const todoHeading = heading(todo, isExpandedCalendar ? "Calendar" : "Next actions");
const taskCount = element(todoHeading.querySelector("h2"), "span", "nh-count", "0");
taskCount.hidden = true;
taskCount.title = "Personal tasks";
if (isExpandedCalendar) button(todoHeading, "Dashboard", "arrow-left", openDashboardPage, "nc-back");
else button(todoHeading, "Open calendar", "arrow-up-right", openCalendarPage, "nh-open-calendar");
const toolbar = element(todo, "div", "nh-task-toolbar");
const viewSwitch = element(toolbar, "div", "nh-view-switch");
viewSwitch.setAttribute("role", "group");
viewSwitch.setAttribute("aria-label", "Task view");
let taskMode = isExpandedCalendar ? "calendar" : dv.container._noemaTaskMode || "calendar";
let showAllTasks = Boolean(dv.container._noemaTaskShowAll);
let taskQuery = dv.container._noemaTaskQuery || "";
let taskDate = dv.container._noemaTaskDate || now().format("YYYY-MM-DD");
let taskMonth = dv.container._noemaTaskMonth || (validCalendarDay(taskDate) ? taskDate.slice(0, 7) : now().format("YYYY-MM-DD").slice(0, 7));
let taskRenderVersion = 0;
let draggedCard;
const calendarView = button(viewSwitch, "Calendar", null, () => selectTaskMode("calendar"), "nh-filter");
const listView = button(viewSwitch, "List", null, () => selectTaskMode("list"), "nh-filter");
const boardView = button(viewSwitch, "Board", null, () => selectTaskMode("board"), "nh-filter");
viewSwitch.hidden = isExpandedCalendar;
const taskSearch = element(toolbar, "input", "nh-task-search");
taskSearch.type = "search";
taskSearch.placeholder = "Find a task…";
taskSearch.setAttribute("aria-label", "Search tasks, notes, and tags");
taskSearch.value = taskQuery;
taskSearch.addEventListener("input", () => {
  taskQuery = taskSearch.value;
  dv.container._noemaTaskQuery = taskQuery;
  renderTasks().catch(showTaskError);
});
const add = button(toolbar, "Add task", "file-plus-2", async () => {
  const day = taskMode === "calendar" && validCalendarDay(taskDate) ? taskDate : now().format("YYYY-MM-DD");
  await addTask(day);
  await renderTasks();
}, "nh-add-task");
const more = element(toolbar, "details", "nh-task-menu");
const moreToggle = element(more, "summary", "nh-menu-toggle", "•••");
moreToggle.setAttribute("aria-label", "More task actions");
const menu = element(more, "div", "nh-menu-items");
function menuAction(label, action) {
  return button(menu, label, null, async () => {
    more.open = false;
    await action();
  }, "nh-menu-item");
}
menuAction("Open today's note", () => openJournal(now().format("YYYY-MM-DD")));
menuAction("Show all tasks", showEveryTask);
const taskList = element(todo, "div", "nh-task-list");
const taskUndo = element(todo, "div", "nh-task-undo");
taskUndo.setAttribute("role", "status");
taskUndo.setAttribute("aria-live", "polite");
function renderTaskUndo() {
  taskUndo.empty();
  const removal = dv.container._noemaTaskUndo;
  taskUndo.hidden = !removal;
  if (!removal) return;
  element(taskUndo, "span", "", "Task removed.");
  button(taskUndo, "Undo", null, async () => {
    try {
      await undoTaskRemoval(removal);
      if (dv.container._noemaTaskUndo === removal) delete dv.container._noemaTaskUndo;
      renderTaskUndo();
      await renderTasks();
    } catch (error) { showTaskError(error); }
  }, "nh-task-undo-button");
}
renderTaskUndo();
function closeTaskMenus() {
  taskList.querySelectorAll(".nh-task-popover:popover-open").forEach(menu => menu.hidePopover());
}
taskList.addEventListener("scroll", closeTaskMenus, true);
window.addEventListener("resize", closeTaskMenus);
onDispose(() => window.removeEventListener("resize", closeTaskMenus));
function taskMenu(row, label) {
  const controls = element(row, "details", "nh-task-menu nh-card-menu");
  const toggle = element(controls, "summary", "nh-menu-toggle", "•••");
  toggle.setAttribute("aria-label", `Actions: ${label}`);
  const choices = element(controls, "div", "nh-menu-items nh-task-popover");
  choices.setAttribute("popover", "auto");
  controls.addEventListener("toggle", () => {
    if (!controls.open) {
      if (choices.matches(":popover-open")) choices.hidePopover();
      return;
    }
    if (!controls.isConnected) return;
    choices.showPopover();
    const anchor = toggle.getBoundingClientRect();
    const bounds = choices.getBoundingClientRect();
    const viewport = dv.container.ownerDocument.documentElement;
    const below = anchor.bottom + 4;
    choices.style.left = `${Math.max(8, Math.min(anchor.right - bounds.width, viewport.clientWidth - bounds.width - 8))}px`;
    choices.style.top = `${Math.max(8, below + bounds.height <= viewport.clientHeight - 8
      ? below : anchor.top - bounds.height - 4)}px`;
  });
  choices.addEventListener("toggle", event => {
    if (event.newState === "closed") controls.open = false;
  });
  return { choices, close: () => { controls.open = false; if (choices.matches(":popover-open")) choices.hidePopover(); } };
}
function showTaskError(error) {
  console.error("Noema task workspace:", error);
  const notice = root.querySelector(".nh-error") || element(root, "p", "nh-error");
  notice.textContent = error.message || "This action could not be completed.";
}
function taskMatches(task) {
  const file = taskFile(task.path);
  const text = `${task.text} ${task.path} ${file ? noteTitle(file) : ""}`.toLowerCase();
  return taskQuery.toLowerCase().trim().split(/\s+/).every(term => text.includes(term));
}
function taskCalendarDates(task) {
  const dates = new Map();
  const text = String(task.text);
  const read = symbol => text.match(new RegExp(`${symbol}\\s*(\\d{4}-\\d{2}-\\d{2})`, "u"))?.[1];
  if (task.completed) return validCalendarDay(read("✅")) ? new Map([[read("✅"), "Done"]]) : dates;
  [["🛫", "Starts"], ["⏳", "Planned"], ["📅", "Due"]].forEach(([symbol, label]) => {
    const day = read(symbol);
    if (validCalendarDay(day)) dates.set(day, label);
  });
  if (!dates.size) {
    const day = journalDay(task.path);
    if (day) dates.set(day, "Journal");
  }
  return dates;
}
function calendarLabel(day, options) {
  return new Intl.DateTimeFormat(config.locale, { timeZone: "UTC", ...options }).format(new Date(`${day}T12:00:00Z`));
}
async function selectTaskDate(day) {
  taskDate = day;
  dv.container._noemaTaskDate = day;
  if (validCalendarDay(day)) {
    taskMonth = day.slice(0, 7);
    dv.container._noemaTaskMonth = taskMonth;
  }
  await renderTasks();
}
let monthPickerCleanup = () => {};
onDispose(() => monthPickerCleanup());
function monthPicker(parent, month, label, cls = "") {
  monthPickerCleanup();
  const picker = element(parent, "details", `nh-month-picker ${cls}`);
  const toggle = element(picker, "summary", "nh-month-picker-toggle");
  element(toggle, "span", "nh-month-picker-label", label);
  icon(toggle, "chevron-down");
  toggle.setAttribute("aria-label", "Choose year and month");
  const panel = element(picker, "div", "nh-month-picker-panel");
  panel.setAttribute("role", "group");
  panel.setAttribute("aria-label", "Choose a calendar month");
  const yearRow = element(panel, "div", "nh-month-picker-year");
  let yearInput;
  const selectedYear = Number(month.slice(0, 4));
  const updateSelection = () => {
    const year = Number(yearInput.value);
    months.querySelectorAll("button").forEach((control, index) => {
      const selected = year === selectedYear && index === Number(month.slice(5, 7)) - 1;
      control.classList.toggle("is-selected", selected);
      control.setAttribute("aria-pressed", String(selected));
    });
  };
  const stepYear = direction => {
    const value = Number(yearInput.value);
    yearInput.value = String(Math.max(1, Math.min(9999, (Number.isInteger(value) && value > 0 ? value : selectedYear) + direction)));
    updateSelection();
  };
  const previous = button(yearRow, "", "chevron-left", () => stepYear(-1), "nh-month-picker-step");
  previous.setAttribute("aria-label", "Previous year");
  yearInput = element(yearRow, "input", "nh-month-picker-year-input");
  yearInput.type = "number";
  yearInput.min = "1";
  yearInput.max = "9999";
  yearInput.step = "1";
  yearInput.value = String(selectedYear);
  yearInput.required = true;
  yearInput.setAttribute("aria-label", "Calendar year");
  yearInput.addEventListener("input", updateSelection);
  const next = button(yearRow, "", "chevron-right", () => stepYear(1), "nh-month-picker-step");
  next.setAttribute("aria-label", "Next year");
  const months = element(panel, "div", "nh-month-picker-months");
  ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].forEach((name, index) => {
    const control = button(months, name, null, async () => {
      if (!yearInput.checkValidity()) { yearInput.reportValidity(); return; }
      const day = `${String(Number(yearInput.value)).padStart(4, "0")}-${String(index + 1).padStart(2, "0")}-01`;
      if (!validCalendarDay(day)) return;
      picker.open = false;
      await selectTaskDate(day);
    }, "nh-month-picker-month");
    control.setAttribute("aria-label", `Choose ${name}`);
  });
  updateSelection();
  picker.addEventListener("keydown", event => {
    if (event.key === "Escape") { picker.open = false; toggle.focus(); event.stopPropagation(); }
  });
  const closeOutside = event => { if (!picker.contains(event.target)) picker.open = false; };
  picker.ownerDocument.addEventListener("pointerdown", closeOutside);
  monthPickerCleanup = () => picker.ownerDocument.removeEventListener("pointerdown", closeOutside);
  return picker;
}
function renderTaskCalendar(snapshots, records) {
  taskList.empty();
  const today = now().format("YYYY-MM-DD");
  const matching = records.filter(taskMatches);
  const open = matching.filter(task => !task.completed);
  const overdue = open.filter(task => {
    const due = String(task.text).match(/📅\s*(\d{4}-\d{2}-\d{2})/u)?.[1];
    return validCalendarDay(due) && due < today;
  });
  const unscheduled = open.filter(task => !taskCalendarDates(task).size);
  const byDay = new Map();
  matching.forEach(task => taskCalendarDates(task).forEach((label, day) => {
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push({ task, label });
  }));
  const calendar = element(taskList, "div", "nh-task-calendar");
  const navigation = element(calendar, "div", "nh-calendar-nav");
  const first = `${taskMonth}-01`;
  monthPicker(navigation, taskMonth, calendarLabel(first, { month: "long", year: "numeric" }), "nh-calendar-month");
  const changeMonth = async direction => {
    const date = new Date(`${first}T12:00:00Z`);
    date.setUTCMonth(date.getUTCMonth() + direction);
    taskMonth = date.toISOString().slice(0, 7);
    dv.container._noemaTaskMonth = taskMonth;
    await renderTasks();
  };
  const previous = button(navigation, "‹", null, () => changeMonth(-1), "nh-calendar-nav-button");
  previous.setAttribute("aria-label", "Previous month");
  const todayButton = button(navigation, "Today", null, () => selectTaskDate(today), "nh-calendar-today");
  todayButton.setAttribute("aria-label", "Go to today");
  const next = button(navigation, "›", null, () => changeMonth(1), "nh-calendar-nav-button");
  next.setAttribute("aria-label", "Next month");
  const grid = element(calendar, "div", "nh-task-date-grid");
  grid.setAttribute("role", "group");
  grid.setAttribute("aria-label", "Task calendar");
  const plugin = app.plugins.getPlugin("calendar");
  const weekStart = plugin?.options?.weekStart;
  const locale = plugin?.options?.localeOverride;
  const calendarLocale = locale && locale !== "system-default" ? locale : moment.locale?.();
  const customWeekday = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].indexOf(String(weekStart).toLowerCase());
  const firstWeekday = customWeekday >= 0 ? customWeekday : moment.localeData?.(calendarLocale)?.firstDayOfWeek?.() ?? 1;
  const weekdays = ["S", "M", "T", "W", "T", "F", "S"];
  for (let i = 0; i < 7; i++) element(grid, "span", "nh-calendar-weekday", weekdays[(firstWeekday + i) % 7]);
  const start = new Date(`${first}T12:00:00Z`);
  const padding = (start.getUTCDay() - firstWeekday + 7) % 7;
  const days = moment.utc(first, "YYYY-MM-DD", true).daysInMonth();
  start.setUTCDate(1 - padding);
  const cells = Math.ceil((padding + days) / 7) * 7;
  for (let i = 0; i < cells; i++) {
    const day = start.toISOString().slice(0, 10);
    const entries = byDay.get(day) || [];
    const pending = entries.filter(entry => !entry.task.completed).length;
    const cell = button(grid, String(start.getUTCDate()), null, () => selectTaskDate(day), "nh-calendar-day");
    cell.dataset.date = day;
    cell.classList.toggle("is-outside", !day.startsWith(taskMonth));
    cell.classList.toggle("is-today", day === today);
    cell.classList.toggle("is-selected", day === taskDate);
    cell.setAttribute("aria-pressed", String(day === taskDate));
    cell.setAttribute("aria-label", `${calendarLabel(day, { month: "long", day: "numeric", year: "numeric" })}, ${pending} open tasks, ${entries.length - pending} completed`);
    cell.title = entries.map(entry => `${entry.task.completed ? "✓" : entry.label}: ${taskLabel(entry.task.text)}`).join("\n") || "No tasks";
    const dots = element(cell, "span", "nh-calendar-dots");
    dots.setAttribute("aria-hidden", "true");
    entries.slice(0, 3).forEach(entry => element(dots, "i", entry.task.completed ? "is-complete" : ""));
    start.setUTCDate(start.getUTCDate() + 1);
  }
  const quickFilters = element(calendar, "div", "nh-calendar-quick-filters");
  [["Overdue", "overdue", overdue], ["Unscheduled", "unscheduled", unscheduled]].forEach(([label, key, items]) => {
    if (!items.length && taskDate !== key) return;
    const filter = button(quickFilters, items.length ? `${label} ${items.length}` : label, null, () => selectTaskDate(key), "nh-filter");
    filter.classList.toggle("is-selected", taskDate === key);
    filter.setAttribute("aria-pressed", String(taskDate === key));
  });
  const agenda = element(taskList, "div", "nh-calendar-agenda");
  const agendaHeading = element(agenda, "div", "nh-agenda-heading");
  element(agendaHeading, "strong", "", taskDate === "overdue" ? "Overdue" : taskDate === "unscheduled"
    ? "Unscheduled" : calendarLabel(taskDate, { weekday: "short", month: "short", day: "numeric" }));
  if (validCalendarDay(taskDate)) {
    const daily = button(agendaHeading, "", "notebook-pen", () => openJournal(taskDate), "nh-agenda-daily");
    daily.setAttribute("aria-label", `Open daily note for ${taskDate}`);
    daily.title = "Open daily note";
  }
  const selected = taskDate === "overdue" ? overdue.map(task => ({ task, label: "Due" }))
    : taskDate === "unscheduled" ? unscheduled.map(task => ({ task, label: "" })) : byDay.get(taskDate) || [];
  const agendaList = element(agenda, "div", "nh-agenda-list");
  if (!selected.length) {
    empty(agendaList, taskQuery ? "No matching tasks." : "Nothing planned.", "", "circle-check");
    return;
  }
  const sources = new Map(snapshots.map(([path, file, snapshot]) => [path, { file, snapshot }]));
  selected.forEach(({ task, label }) => {
    const source = sources.get(task.path);
    const row = taskRow(agendaList, task, source.file, source.snapshot);
    if (row) row.title = `${label || "Unscheduled"} · ${source.file.basename}\n${task.text}`;
  });
}
function taskRow(parent, task, file, snapshot, card = false) {
  const expected = snapshot.split("\n")[task.line];
  const parsed = expected?.match(/^\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[(.)\]\s+(.*?)(?:\r)?$/);
  if (!parsed || parsed[1] !== task.status || parsed[2] !== String(task.text).split("\n")[0].trimEnd()) return;
  const row = element(parent, "div", card ? "nh-task-row nh-board-card" : "nh-task-row");
  row.dataset.path = task.path;
  row.classList.toggle("is-complete", task.completed);
  row.title = file.path;
  const checkbox = element(row, "input", "nh-task-checkbox");
  checkbox.type = "checkbox";
  checkbox.checked = task.completed;
  checkbox.setAttribute("aria-label", `${task.completed ? "Reopen" : "Complete"}: ${taskLabel(task.text)}`);
  const editTask = async () => {
    const updated = await taskModal("editTaskLineModal", expected);
    if (updated.trim()) {
      await replaceTask(task, expected, updated);
      await renderTasks();
    }
  };
  const text = button(row, taskLabel(task.text), null, editTask, "nh-task-text");
  text.title = `Click to edit\n${task.text}\n${file.path}`;
  text.setAttribute("aria-label", `Edit task: ${taskLabel(task.text)}`);
  const due = String(task.text).match(/📅\s*(\d{4}-\d{2}-\d{2})/u)?.[1];
  if (validCalendarDay(due) && !task.completed) {
    const date = element(row, "time", "nh-task-date", moment(due).locale(config.locale).format("MMM D"));
    date.dateTime = due;
    date.title = `Due ${due}`;
    date.classList.toggle("is-overdue", due < now().format("YYYY-MM-DD"));
  }
  checkbox.addEventListener("change", async () => {
    checkbox.disabled = true;
    try {
      await setTaskCompleted(task, file, snapshot, !task.completed);
      await renderTasks();
    } catch (error) { checkbox.checked = task.completed; showTaskError(error); }
    finally { checkbox.disabled = false; }
  });
  const edit = button(row, "", "notebook-pen", editTask, "nh-task-edit");
  edit.setAttribute("aria-label", `Edit: ${taskLabel(task.text)}`);
  edit.title = "Edit task, dates, or recurrence";
  const { choices, close } = taskMenu(row, taskLabel(task.text));
  button(choices, "Edit task", null, async () => { close(); await editTask(); }, "nh-menu-item");
  if (card) {
    button(choices, task.completed ? "Move to Open" : "Move to Done", null, async () => {
      close();
      await setTaskCompleted(task, file, snapshot, !task.completed);
      await renderTasks();
    }, "nh-menu-item");
  }
  button(choices, "Open source", null, () => { close(); return openTaskSource(file); }, "nh-menu-item");
  button(choices, "Remove task", null, async () => {
    close();
    try {
      dv.container._noemaTaskUndo = await removeTask(file, snapshot, task);
      renderTaskUndo();
      await renderTasks();
    } catch (error) { showTaskError(error); await renderTasks(); }
  }, "nh-menu-item nh-remove-task");
  if (card) {
    row.draggable = true;
    row.addEventListener("dragstart", event => {
      if (event.target.closest("input, summary, .nh-task-edit, .nh-menu-items")) { event.preventDefault(); return; }
      draggedCard = { file, snapshot, task };
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("application/x-noema-card", `${file.path}:${task.line}`);
      row.classList.add("is-dragging");
    });
    row.addEventListener("dragend", () => {
      draggedCard = undefined;
      row.classList.remove("is-dragging");
      taskList.querySelectorAll(".is-drop-target").forEach(node => node.classList.remove("is-drop-target"));
    });
  }
  return row;
}
async function selectTaskMode(mode) {
  taskMode = mode;
  dv.container._noemaTaskMode = mode;
  await renderTasks();
}
async function showEveryTask() {
  showAllTasks = true;
  dv.container._noemaTaskShowAll = true;
  taskQuery = "";
  taskSearch.value = "";
  dv.container._noemaTaskQuery = "";
  await selectTaskMode("list");
}
async function renderTasks() {
  const version = ++taskRenderVersion;
  listView.classList.toggle("is-selected", taskMode === "list");
  listView.setAttribute("aria-pressed", String(taskMode === "list"));
  boardView?.classList.toggle("is-selected", taskMode === "board");
  boardView?.setAttribute("aria-pressed", String(taskMode === "board"));
  calendarView.classList.toggle("is-selected", taskMode === "calendar");
  calendarView.setAttribute("aria-pressed", String(taskMode === "calendar"));
  taskList.classList.toggle("is-board", taskMode === "board");
  taskList.classList.toggle("is-calendar", taskMode === "calendar");
  // Daily-note task sections are the only task source in every view.
  const snapshots = await Promise.all(journalFiles().map(file => readTaskSnapshot(file.path)));
  if (disposed || version !== taskRenderVersion) return;
  const records = snapshots.flatMap(([, file, snapshot]) => file ? sourceTasks(file, snapshot) : [])
    .filter(task => task.status !== "-")
    .sort((a, b) => taskDue(a) - taskDue(b) || taskPriority(a) - taskPriority(b)
      || a.path.localeCompare(b.path) || a.line - b.line);
  const current = records.filter(task => !task.completed);
  taskCount.textContent = String(current.length);
  taskCount.hidden = !current.length;
  taskCount.title = "Personal tasks";
  if (taskMode === "board") {
    taskList.empty();
    taskList.style.setProperty("--nh-lane-count", "2");
    const sources = new Map(snapshots.map(([path, file, snapshot]) => [path, { file, snapshot }]));
    [["Open", false], ["Done", true]].forEach(([name, completed]) => {
      const column = element(taskList, "section", "nh-board-lane");
      column.dataset.lane = name;
      const header = element(column, "div", "nh-lane-header");
      const matching = records.filter(task => task.completed === completed && taskMatches(task));
      element(header, "strong", "nh-lane-title", name);
      element(header, "span", "nh-count", String(matching.length));
      const cards = element(column, "div", "nh-lane-cards");
      matching.forEach(task => {
        const source = sources.get(task.path);
        if (source?.file) taskRow(cards, task, source.file, source.snapshot, true);
      });
      if (!completed) button(column, "+ Add task", null, async () => {
        await addTask();
        await renderTasks();
      }, "nh-lane-add");
      column.addEventListener("dragover", event => {
        if (!draggedCard || draggedCard.task.completed === completed) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        column.classList.add("is-drop-target");
      });
      column.addEventListener("dragleave", event => {
        if (!column.contains(event.relatedTarget)) column.classList.remove("is-drop-target");
      });
      column.addEventListener("drop", async event => {
        event.preventDefault();
        column.classList.remove("is-drop-target");
        const dragged = draggedCard;
        draggedCard = undefined;
        if (!dragged || dragged.task.completed === completed) return;
        try {
          await setTaskCompleted(dragged.task, dragged.file, dragged.snapshot, completed);
          await renderTasks();
        } catch (error) { showTaskError(error); }
      });
    });
    return;
  }
  if (taskMode === "calendar") {
    if (isExpandedCalendar) renderExpandedCalendar({
      app, moment, config, root, container: taskList, records, snapshots, taskDate, taskMonth, taskQuery,
      today: now().format("YYYY-MM-DD"), state: dv.container, element, button, icon, taskRow,
      taskCalendarDates, taskLabel, validCalendarDay, calendarLabel, selectTaskDate, renderTasks, openJournal, monthPicker
    });
    else renderTaskCalendar(snapshots, records);
    return;
  }
  const matches = current.filter(taskMatches);
  const groups = new Map();
  (showAllTasks ? matches : matches.slice(0, 8)).forEach(task => {
    if (!groups.has(task.path)) groups.set(task.path, []);
    groups.get(task.path).push(task);
  });
  taskList.empty();
  if (!matches.length) {
    empty(taskList, taskQuery ? "No matching tasks." : "Nothing waiting.", "", "circle-check");
    return;
  }
  snapshots.forEach(([path, file, snapshot]) => {
    if (!file || !groups.has(path)) return;
    const group = element(taskList, "section", "nh-task-group");
    link(group, path, noteTitle(file), "nh-task-group-title");
    groups.get(path).forEach(task => taskRow(group, task, file, snapshot));
  });
  if (matches.length > 8 && !showAllTasks) {
    button(taskList, `Show all ${matches.length} tasks`, null, showEveryTask, "nh-show-all");
  }
}
await renderTasks();
