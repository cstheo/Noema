"use strict";

var noemaPaperTemplateRuntime;
var noemaPaperTemplateStartup = 0;

function install() {}
function uninstall() {}

async function startup({ rootURI }) {
  const generation = ++noemaPaperTemplateStartup;
  await Zotero.initializationPromise;
  if (generation !== noemaPaperTemplateStartup) return;
  const scope = {};
  Services.scriptloader.loadSubScript(rootURI + "paper-note-template.js", scope);
  Services.scriptloader.loadSubScript(rootURI + "native-template.js", scope);
  noemaPaperTemplateRuntime = scope.NoemaNativePaperTemplate.createRuntime(
    Zotero, scope.NoemaPaperNoteTemplate, error => Zotero.logError(error)
  );
  noemaPaperTemplateRuntime.installEditor();
  for (const window of Zotero.getMainWindows()) noemaPaperTemplateRuntime.installWindow(window);
}

function onMainWindowLoad({ window }) {
  noemaPaperTemplateRuntime?.installWindow(window);
}

function onMainWindowUnload({ window }) {
  noemaPaperTemplateRuntime?.uninstallWindow(window);
}

function shutdown() {
  ++noemaPaperTemplateStartup;
  noemaPaperTemplateRuntime?.shutdown();
  noemaPaperTemplateRuntime = undefined;
}
