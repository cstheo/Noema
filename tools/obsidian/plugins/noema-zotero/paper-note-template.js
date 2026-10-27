(function (scope) {
  "use strict";

  const headings = Object.freeze([
    "1. Problem",
    "2. Contribution",
    "3. Insights",
    "4. Design",
    "5. Evaluation",
    "6. Limitation"
  ]);
  const names = headings.map(heading => heading.replace(/^\d+\. /, "").toLowerCase());
  const markdown = headings.map(heading => `## ${heading}\n`).join("\n") + "\n";
  const html = headings.map(heading => `<h2>${heading}</h2><p></p>`).join("");

  function dimension(title) {
    let name = title.trim(), previous;
    // Common emphasis wrappers do not change a section's name.
    do {
      previous = name;
      for (const marker of ["**", "__", "*", "_", "`"]) {
        if (name.startsWith(marker) && name.endsWith(marker) && name.length > marker.length * 2) {
          name = name.slice(marker.length, -marker.length).trim();
        }
      }
      name = name.replace(/^\d+[.)]\s*/, "").replace(/[:：]\s*$/, "").trim();
    } while (name !== previous);
    return names.indexOf(name.toLowerCase());
  }

  function inspect(body) {
    const found = new Set();
    let fence = null;
    let raw = null;
    let previous = null;
    for (const line of body.split(/\r\n?|\n/)) {
      const fenceLine = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (fence) {
        if (fenceLine && fenceLine[1][0] === fence.marker[0]
          && fenceLine[1].length >= fence.marker.length && !fenceLine[2].trim()) fence = null;
        previous = null;
        continue;
      }
      if (raw) {
        if (line.toLowerCase().includes(`</${raw}>`)) raw = null;
        previous = null;
        continue;
      }
      // Quoted fences and quoted headings belong to the passage, not the note.
      if (/^ {0,3}>/.test(line)) { previous = null; continue; }
      const rawStart = line.match(/^ {0,3}<(pre|script|style|textarea)(?:[ \t>])/i);
      if (rawStart) {
        const tag = rawStart[1].toLowerCase();
        if (!line.toLowerCase().includes(`</${tag}>`)) raw = tag;
        previous = null;
        continue;
      }
      if (fenceLine && (fenceLine[1][0] !== "`" || !fenceLine[2].includes("`"))) {
        fence = { marker: fenceLine[1] };
        previous = null;
        continue;
      }
      const heading = line.match(/^ {0,3}#{1,6}(?:[ \t]+|$)(.*)$/);
      if (heading) {
        const index = dimension(heading[1].replace(/[ \t]+#+[ \t]*$/, ""));
        if (index !== -1) found.add(index);
        previous = null;
      } else if (/^ {0,3}(?:=+|-+)[ \t]*$/.test(line)) {
        if (previous !== null) {
          const index = dimension(previous);
          if (index !== -1) found.add(index);
        }
        previous = null;
      } else {
        // Four-space/tab-indented code cannot provide a setext heading title.
        previous = line.trim() && !/^(?: {4}| {0,3}\t)/.test(line)
          ? (previous === null ? line : `${previous}\n${line}`) : null;
      }
    }
    return { found, fence, raw };
  }

  function initialize(body = "") {
    if (typeof body !== "string") throw new TypeError("Paper note content must be text.");
    const { found, fence, raw } = inspect(body);
    const missing = headings.filter((heading, index) => !found.has(index));
    if (!missing.length) return body;
    // Never trim, normalize line endings, or move authored text. Close an
    // unfinished fence by appending so the new sections are outside code.
    let prefix = body;
    if (fence) prefix += `\n\n${fence.marker}\n`;
    if (raw) prefix += `\n\n</${raw}>\n`;
    const separator = prefix ? (/\r?\n\r?\n$/.test(prefix) ? "" : /[\r\n]$/.test(prefix) ? "\n" : "\n\n") : "";
    return prefix + separator + missing.map(heading => `## ${heading}\n`).join("\n") + "\n";
  }

  const api = Object.freeze({ headings, markdown, html, initialize });
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (scope) scope.NoemaPaperNoteTemplate = api;
})(typeof globalThis === "object" ? globalThis : this);
