"use strict";

const DEFAULT_READER_SETTINGS = Object.freeze({
  readerAlignment: "center",
  readerDensity: "auto",
  readerSelectionToolbar: true,
  enableLocalPdf: true
});

function normalizeReaderSettings(value) {
  const data = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    readerAlignment: ["left", "center", "right"].includes(data.readerAlignment) ? data.readerAlignment : DEFAULT_READER_SETTINGS.readerAlignment,
    readerDensity: ["auto", "compact", "comfortable"].includes(data.readerDensity) ? data.readerDensity : DEFAULT_READER_SETTINGS.readerDensity,
    readerSelectionToolbar: typeof data.readerSelectionToolbar === "boolean" ? data.readerSelectionToolbar : DEFAULT_READER_SETTINGS.readerSelectionToolbar,
    enableLocalPdf: typeof data.enableLocalPdf === "boolean" ? data.enableLocalPdf : DEFAULT_READER_SETTINGS.enableLocalPdf
  };
}

function persistedObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

async function installReaderSettings(plugin) {
  plugin.readerSettings = normalizeReaderSettings(await plugin.loadData());
  let writes = Promise.resolve();
  plugin.updateReaderSettings = patch => {
    // Serialize changes so simultaneous controls cannot overwrite one another.
    const next = writes.catch(() => {}).then(async () => {
      if (!plugin.active) return;
      const stored = persistedObject(await plugin.loadData());
      if (!plugin.active) return;
      const settings = normalizeReaderSettings({ ...plugin.readerSettings, ...patch });
      await plugin.saveData({ ...stored, ...settings });
      if (!plugin.active) return;
      plugin.readerSettings = settings;
      plugin.reader?.configure();
    });
    writes = next;
    return next;
  };

  const { PluginSettingTab, Setting, Notice } = plugin.obsidian;
  class ReaderSettingsTab extends PluginSettingTab {
    display() {
      const { containerEl } = this;
      containerEl.empty();
      containerEl.createEl("h2", { text: "PDF reader" });
      const update = async patch => {
        try { await plugin.updateReaderSettings(patch); }
        catch (error) {
          console.error("Noema Zotero: reader settings could not be saved", error);
          new Notice("PDF reader settings could not be saved. Please try again.");
          this.display();
        }
      };
      new Setting(containerEl)
        .setName("Toolbar alignment")
        .addDropdown(dropdown => dropdown
          .addOptions({ left: "Left", center: "Center", right: "Right" })
          .setValue(plugin.readerSettings.readerAlignment)
          .onChange(value => update({ readerAlignment: value })));
      new Setting(containerEl)
        .setName("Toolbar density")
        .setDesc("Automatic adapts to available space; Compact uses icons; Comfortable shows labels.")
        .addDropdown(dropdown => dropdown
          .addOptions({ auto: "Automatic", compact: "Compact", comfortable: "Comfortable" })
          .setValue(plugin.readerSettings.readerDensity)
          .onChange(value => update({ readerDensity: value })));
      new Setting(containerEl)
        .setName("Selection toolbar")
        .setDesc("Show color and annotation actions beside selected PDF text.")
        .addToggle(toggle => toggle
          .setValue(plugin.readerSettings.readerSelectionToolbar)
          .onChange(value => update({ readerSelectionToolbar: value })));
      new Setting(containerEl)
        .setName("Enable for vault PDFs")
        .setDesc("Keep highlights and comments locally for PDFs outside Zotero.")
        .addToggle(toggle => toggle
          .setValue(plugin.readerSettings.enableLocalPdf)
          .onChange(value => update({ enableLocalPdf: value })));
      const pdfPlusEnabled = plugin.app.plugins?.enabledPlugins?.has("pdf-plus") === true;
      new Setting(containerEl)
        .setName("PDF++")
        .setDesc(pdfPlusEnabled
          ? "PDF++ is enabled. Its palette can be disabled to avoid duplicate controls."
          : "PDF++ is not enabled.");
    }
  }
  plugin.addSettingTab(new ReaderSettingsTab(plugin.app, plugin));
  return plugin.readerSettings;
}

module.exports = { DEFAULT_READER_SETTINGS, normalizeReaderSettings, installReaderSettings };
