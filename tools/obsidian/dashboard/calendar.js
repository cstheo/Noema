// Expanded calendar is a presentation of the dashboard's original task records.
const {
  app, moment, config, container, records, snapshots, taskDate, taskMonth, taskQuery,
  today, state, element, button, taskRow, taskCalendarDates,
  validCalendarDay, calendarLabel, selectTaskDate, renderTasks, openJournal, monthPicker
} = ctx;
container.empty();
const calendar = element(container, "div", "nc-calendar");
const layouts = ["month", "week", "agenda"];
const statuses = ["all", "open", "completed"];
const layout = layouts.includes(state._noemaCalendarLayout) ? state._noemaCalendarLayout : "week";
const status = statuses.includes(state._noemaCalendarStatus) ? state._noemaCalendarStatus : "all";
calendar.dataset.layout = layout;
state._noemaCalendarLayout = layout;
state._noemaCalendarStatus = status;
const date = day => moment.utc(day, "YYYY-MM-DD", "en", true);
const shift = (day, amount, unit = "days") => date(day).add(amount, unit).format("YYYY-MM-DD");
const selectedDay = validCalendarDay(taskDate) ? taskDate : today;
const monthDay = validCalendarDay(`${taskMonth}-01`) ? `${taskMonth}-01` : selectedDay;
const anchor = layout === "month" ? monthDay : selectedDay;
const start = layout === "month" ? date(anchor).startOf("month").format("YYYY-MM-DD")
  : layout === "week" ? date(anchor).startOf("isoWeek").format("YYYY-MM-DD") : shift(anchor, -7);
const end = layout === "month" ? date(anchor).endOf("month").format("YYYY-MM-DD")
  : layout === "week" ? shift(start, 6) : shift(anchor, 14);
const sources = new Map(snapshots.map(([path, file, snapshot]) => [path, { file, snapshot }]));
const identity = task => `${task.path}:${task.line}`;
const query = String(taskQuery || "").toLowerCase().trim().split(/\s+/).filter(Boolean);
const unique = new Map();
records.forEach(task => {
  const source = sources.get(task.path);
  if (!source?.file) return;
  const title = app.metadataCache.getFileCache(source.file)?.frontmatter?.title || source.file.basename || "";
  const text = `${task.text} ${task.path} ${title}`.toLowerCase();
  if (query.every(term => text.includes(term))) unique.set(identity(task), task);
});
const matching = [...unique.values()];
const accepts = task => status === "all" || (status === "completed" ? task.completed : !task.completed);
const dates = new Map(matching.map(task => [identity(task), taskCalendarDates(task)]));
const buckets = new Map();
matching.forEach(task => dates.get(identity(task)).forEach((label, day) => {
  if (!validCalendarDay(day)) return;
  if (!buckets.has(day)) buckets.set(day, new Map());
  buckets.get(day).set(identity(task), { task, day, label });
}));
const entriesFor = day => [...(buckets.get(day)?.values() || [])];
const visibleFor = day => entriesFor(day).filter(entry => accepts(entry.task));
const fullDate = day => calendarLabel(day, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
const shortDate = day => calendarLabel(day, { month: "short", day: "numeric" });
function blank(parent, title, description) {
  const node = element(parent, "div", "nc-empty");
  element(node, "strong", "", title);
  if (description) node.title = description;
}
function inlineTask(parent, entry, showDate = false) {
  const source = sources.get(entry.task.path);
  if (!source?.file) return;
  const wrapper = element(parent, "div", "nc-task");
  wrapper.classList.add(entry.task.completed ? "is-done" : "is-planned");
  wrapper.classList.toggle("is-overdue", !entry.task.completed && entry.label === "Due" && entry.day < today);
  const row = taskRow(wrapper, entry.task, source.file, source.snapshot);
  if (!row) { wrapper.remove(); return; }
  const due = row.querySelector(".nh-task-date");
  if (due && due.dateTime === entry.day) due.remove();
  else if (due) due.textContent = `Due ${due.textContent}`;
  row.title = `${entry.label || (entry.task.completed ? "Completed" : "Unscheduled")} · ${entry.task.path}`;
  if (showDate && entry.day) {
    const context = element(wrapper, "div", "nc-task-context");
    context.title = row.title;
    const time = element(context, "time", "nc-task-date", shortDate(entry.day));
    time.dateTime = entry.day;
  }
}
function progress(parent, day) {
  const entries = entriesFor(day);
  const completed = entries.filter(entry => entry.task.completed).length;
  const pending = entries.length - completed;
  const summary = element(parent, "div", "nc-day-summary");
  summary.hidden = !entries.length;
  if (pending) element(summary, "span", "nc-count-open", `${pending} open`);
  if (completed) element(summary, "span", "nc-count-done", `${completed} done`);
  const ratio = entries.length ? Math.round(completed / entries.length * 100) : 0;
  const meter = element(parent, "div", "nc-progress");
  meter.hidden = !entries.length;
  meter.setAttribute("role", "progressbar");
  meter.setAttribute("aria-label", `Completion on ${fullDate(day)}`);
  meter.setAttribute("aria-valuemin", "0");
  meter.setAttribute("aria-valuemax", "100");
  meter.setAttribute("aria-valuenow", String(ratio));
  meter.setAttribute("aria-valuetext", entries.length ? `${completed} of ${entries.length} tasks completed` : "No dated tasks");
  element(meter, "span", "nc-progress-fill").style.width = `${ratio}%`;
}
function dayCard(parent, day, cls, month = false) {
  const card = element(parent, "section", `nc-day-card ${cls}`);
  card.dataset.date = day;
  card.dataset.weekday = String(date(day).isoWeekday());
  card.classList.toggle("is-empty", !entriesFor(day).length);
  card.classList.toggle("has-completed", entriesFor(day).some(entry => entry.task.completed));
  card.classList.toggle("has-open", entriesFor(day).some(entry => !entry.task.completed));
  card.classList.toggle("is-today", day === today);
  card.classList.toggle("is-selected", day === selectedDay);
  if (month) card.classList.toggle("is-outside", day.slice(0, 7) !== anchor.slice(0, 7));
  const heading = element(card, "div", "nc-day-heading");
  const select = button(heading, "", null, () => selectTaskDate(day), "nc-day-select");
  if (!month) element(select, "span", "nc-date-weekday", date(day).format(layout === "agenda" ? "ddd, MMM" : "ddd"));
  element(select, "span", "nc-date-number", date(day).format("D"));
  select.setAttribute("aria-label", `Select ${fullDate(day)}`);
  select.setAttribute("aria-pressed", String(day === selectedDay));
  if (day === today) element(heading, "span", "nc-today-label", "Today");
  const journal = button(heading, "", "notebook-pen", () => openJournal(day), "nc-day-journal");
  journal.setAttribute("aria-label", `Open daily note for ${fullDate(day)}`);
  journal.title = "Open daily note";
  progress(card, day);
  const list = element(card, "div", "nc-day-tasks");
  visibleFor(day).forEach(entry => inlineTask(list, entry));
  return card;
}
function overview(parent, title, entries, description, tone = "neutral", collapsible = false, limit = 4) {
  const panel = element(parent, collapsible ? "details" : "section", `nc-overview-card nc-tone-${tone}`);
  if (collapsible) {
    panel.classList.add("is-collapsible");
    const expanded = state._noemaCalendarDetails ||= {};
    panel.open = Boolean(expanded[title]);
    panel.addEventListener("toggle", () => { expanded[title] = panel.open; });
  }
  const heading = element(panel, collapsible ? "summary" : "div", "nc-overview-heading");
  heading.title = description || "";
  element(heading, "h3", "nc-section-title", title);
  if (tone === "done" || tone === "upcoming") element(heading, "span", "nc-section-period", tone === "done" ? "7d" : "14d");
  if (entries.length) element(heading, "span", "nc-section-count", String(entries.length));
  const list = element(panel, "div", "nc-overview-tasks");
  if (!entries.length) { blank(list, tone === "done" ? "No recent completions." : "No upcoming tasks."); return; }
  entries.slice(0, limit).forEach(entry => inlineTask(list, entry, true));
  if (entries.length > limit) {
    const more = button(panel, `Show all ${entries.length}`, null, () => {
      entries.slice(limit).forEach(entry => inlineTask(list, entry, true));
      more.remove();
    }, "nc-show-all");
  }
}
const header = element(calendar, "div", "nc-header");
const title = element(header, "div", "nc-title-block");
monthPicker(title, anchor.slice(0, 7), layout === "month" ? date(anchor).format("MMMM YYYY")
  : `${shortDate(start)} – ${shortDate(end)}, ${date(end).format("YYYY")}`, "nc-title");
title.title = layout === "agenda" ? "The previous 7 days and next 14 days around your selected date."
  : "Tasks are placed by planned dates or recorded completion dates.";
const navigation = element(header, "div", "nc-navigation");
function navigate(direction) {
  if (layout === "month") return selectTaskDate(shift(anchor, direction, "months"));
  return selectTaskDate(shift(selectedDay, direction * 7));
}
const previous = button(navigation, "", "chevron-left", () => navigate(-1), "nc-nav-button");
previous.setAttribute("aria-label", `Previous ${layout === "month" ? "month" : "week"}`);
previous.title = previous.getAttribute("aria-label");
button(navigation, "Today", null, () => selectTaskDate(today), "nc-nav-today");
const next = button(navigation, "", "chevron-right", () => navigate(1), "nc-nav-button");
next.setAttribute("aria-label", `Next ${layout === "month" ? "month" : "week"}`);
next.title = next.getAttribute("aria-label");
const controls = element(calendar, "div", "nc-controls");
const layoutGroup = element(controls, "div", "nc-switch");
layoutGroup.setAttribute("role", "group");
layoutGroup.setAttribute("aria-label", "Calendar layout");
layouts.forEach(value => {
  const control = button(layoutGroup, value[0].toUpperCase() + value.slice(1), null, () => {
    state._noemaCalendarLayout = value;
    return renderTasks();
  }, "nc-filter");
  control.classList.toggle("is-selected", value === layout);
  control.setAttribute("aria-pressed", String(value === layout));
});
const statusGroup = element(controls, "div", "nc-status-switch");
statusGroup.setAttribute("role", "group");
statusGroup.setAttribute("aria-label", "Task status");
statuses.forEach(value => {
  const control = button(statusGroup, value[0].toUpperCase() + value.slice(1), null, () => {
    state._noemaCalendarStatus = value;
    return renderTasks();
  }, "nc-filter");
  control.classList.toggle("is-selected", value === status);
  control.dataset.status = value;
  control.setAttribute("aria-pressed", String(value === status));
});
const summary = element(controls, "div", "nc-record-summary");
const openCount = matching.filter(task => !task.completed).length;
const doneCount = matching.filter(task => task.completed).length;
if (openCount) element(summary, "span", "nc-count-open", `${openCount} open`);
if (doneCount) element(summary, "span", "nc-count-done", `${doneCount} done`);
summary.hidden = !openCount && !doneCount;
summary.title = "Unique tasks matching your search. Daily progress includes both open and completed tasks.";
if (query.length && !matching.length) blank(calendar, "No tasks match your search.", "Try a task title, tag, or note name.");
const body = element(calendar, "div", "nc-body");
const main = element(body, "div", "nc-main");
if (layout === "month") {
  const weekdays = element(main, "div", "nc-month-weekdays");
  Array.from({length: 7}, (_, day) => moment.utc().locale(config.locale).isoWeekday(day + 1).format("ddd")).forEach(value => element(weekdays, "span", "", value));
  const grid = element(main, "div", "nc-month-grid");
  const first = date(start).startOf("isoWeek").format("YYYY-MM-DD");
  const last = date(end).endOf("isoWeek").format("YYYY-MM-DD");
  for (let day = first; day <= last; day = shift(day, 1)) dayCard(grid, day, "nc-month-day", true);
} else if (layout === "week") {
  const grid = element(main, "div", "nc-week-grid");
  for (let day = start; day <= end; day = shift(day, 1)) dayCard(grid, day, "nc-week-day");
} else {
  const agenda = element(main, "div", "nc-agenda");
  let groups = 0;
  for (let day = start; day <= end; day = shift(day, 1)) {
    if (!visibleFor(day).length) continue;
    dayCard(agenda, day, "nc-agenda-day");
    groups++;
  }
  if (!groups) blank(agenda, "No dated tasks in this range.", "Add a planned task or choose another date range.");
}
if (layout !== "agenda" && !matching.some(task => [...dates.get(identity(task)).keys()].some(day => day >= start && day <= end) && accepts(task))) {
  element(main, "p", "nc-range-empty", layout === "week" ? "No dated tasks this week." : "No dated tasks this month.");
}
const side = element(body, "aside", "nc-side");
side.setAttribute("aria-label", "Task overview");
const completed = matching.filter(task => task.completed);
const pending = matching.filter(task => !task.completed);
if (status !== "open") {
  const recentStart = shift(today, -6);
  const recent = completed.flatMap(task => [...dates.get(identity(task))].map(([day, label]) => ({ task, day, label })))
    .filter(entry => entry.day >= recentStart && entry.day <= today)
    .sort((a, b) => b.day.localeCompare(a.day) || identity(a.task).localeCompare(identity(b.task)));
  if (recent.length) overview(side, "Completed", recent, "Last 7 days · recorded completion dates", "done");
}
if (status !== "completed") {
  const upcomingEnd = shift(today, 13);
  const upcoming = pending.flatMap(task => {
    const next = [...dates.get(identity(task))].filter(([day]) => day >= today && day <= upcomingEnd)
      .sort(([a], [b]) => a.localeCompare(b))[0];
    return next ? [{ task, day: next[0], label: next[1] }] : [];
  }).sort((a, b) => a.day.localeCompare(b.day) || identity(a.task).localeCompare(identity(b.task)));
  if (upcoming.length) overview(side, "Upcoming", upcoming, "Next 14 days · each task appears once", "upcoming");
  const overdue = pending.flatMap(task => {
    const due = [...dates.get(identity(task))].find(([day, label]) => label === "Due" && day < today);
    return due ? [{ task, day: due[0], label: "Due" }] : [];
  }).sort((a, b) => a.day.localeCompare(b.day));
  if (overdue.length) overview(side, "Overdue", overdue, "Open tasks with a past due date", "overdue");
  const unscheduled = pending.filter(task => !dates.get(identity(task)).size)
    .map(task => ({ task, label: "Unscheduled" }));
  if (unscheduled.length) overview(side, "Unscheduled", unscheduled, "Open tasks without a calendar date", "neutral", true);
}
if (status !== "open") {
  const undated = completed.filter(task => !dates.get(identity(task)).size)
    .map(task => ({ task, label: "Completion date not recorded" }));
  if (undated.length) overview(side, "Date not recorded", undated, "Completed tasks without recorded completion dates", "neutral", true);
}
