"use strict";

const state = {
  devices: [],
  selectedIndex: 0,
  outputDir: "",
  files: {},
  report: null,
  selectedCheckId: null,
  activeView: "details",
  running: false,
};

const els = {
  versionLabel: document.querySelector("#versionLabel"),
  deviceSelect: document.querySelector("#deviceSelect"),
  deviceHint: document.querySelector("#deviceHint"),
  refreshButton: document.querySelector("#refreshButton"),
  profileSelect: document.querySelector("#profileSelect"),
  formatSelect: document.querySelector("#formatSelect"),
  timeoutInput: document.querySelector("#timeoutInput"),
  outputPath: document.querySelector("#outputPath"),
  chooseOutputButton: document.querySelector("#chooseOutputButton"),
  runButton: document.querySelector("#runButton"),
  runState: document.querySelector("#runState"),
  targetTitle: document.querySelector("#targetTitle"),
  failCount: document.querySelector("#failCount"),
  warnCount: document.querySelector("#warnCount"),
  okCount: document.querySelector("#okCount"),
  skipCount: document.querySelector("#skipCount"),
  infoCount: document.querySelector("#infoCount"),
  checkCount: document.querySelector("#checkCount"),
  checksList: document.querySelector("#checksList"),
  detailsTabButton: document.querySelector("#detailsTabButton"),
  reportTabButton: document.querySelector("#reportTabButton"),
  detailsView: document.querySelector("#detailsView"),
  reportText: document.querySelector("#reportText"),
  openTextButton: document.querySelector("#openTextButton"),
  openJsonButton: document.querySelector("#openJsonButton"),
  openFolderButton: document.querySelector("#openFolderButton"),
};

function setRunState(text, mode) {
  els.runState.textContent = text;
  els.runState.className = `run-state ${mode}`;
}

function targetLabel(target) {
  if (!target) return "No device selected";
  if (target.kind === "android") return `Android ${target.model || ""} ${target.serial || ""}`.trim();
  return `Local ${target.family || target.platform} ${target.hostname || ""}`.trim();
}

function renderDevices(inventory) {
  state.devices = inventory.devices || [];
  els.deviceSelect.innerHTML = "";

  state.devices.forEach((device, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = device.label;
    els.deviceSelect.appendChild(option);
  });

  if (!state.devices.length) {
    const option = document.createElement("option");
    option.value = "0";
    option.textContent = "No devices found";
    els.deviceSelect.appendChild(option);
  }

  state.selectedIndex = Math.min(state.selectedIndex, Math.max(0, state.devices.length - 1));
  els.deviceSelect.value = String(state.selectedIndex);

  if (!inventory.adbAvailable) {
    els.deviceHint.textContent = "Android: adb not found.";
  } else if (!state.devices.some((device) => device.kind === "android")) {
    els.deviceHint.textContent = "Android: adb found, no authorized device connected.";
  } else {
    els.deviceHint.textContent = "";
  }
}

function renderSummary(summary) {
  els.failCount.textContent = summary ? summary.fail || 0 : 0;
  els.warnCount.textContent = summary ? summary.warn || 0 : 0;
  els.okCount.textContent = summary ? summary.ok || 0 : 0;
  els.skipCount.textContent = summary ? summary.skip || 0 : 0;
  els.infoCount.textContent = summary ? summary.info || 0 : 0;
}

function statusRank(status) {
  return ({ fail: 0, warn: 1, ok: 2, info: 3, skip: 4 })[status] ?? 9;
}

function sortedChecks(report) {
  const checks = report && Array.isArray(report.checks) ? report.checks : [];
  return [...checks].sort((a, b) => statusRank(a.status) - statusRank(b.status));
}

function firstDetailCheck(report) {
  return sortedChecks(report).find((check) => check.status === "fail" || check.status === "warn") || sortedChecks(report)[0] || null;
}

function renderChecks(report) {
  els.checksList.innerHTML = "";
  const checks = sortedChecks(report);
  els.checkCount.textContent = String(checks.length);

  for (const check of checks) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = `check-item${check.id === state.selectedCheckId ? " selected" : ""}`;
    item.setAttribute("aria-pressed", check.id === state.selectedCheckId ? "true" : "false");
    item.addEventListener("click", () => selectCheck(check.id));

    const pill = document.createElement("div");
    pill.className = `status-pill status-${check.status}`;
    pill.textContent = check.status.toUpperCase();

    const body = document.createElement("div");
    body.className = "check-body";

    const title = document.createElement("h3");
    title.textContent = check.title;

    const summary = document.createElement("p");
    summary.textContent = check.summary || "";

    body.append(title, summary);
    for (const adviceText of check.advice || []) {
      const advice = document.createElement("div");
      advice.className = "advice";
      advice.textContent = adviceText;
      body.appendChild(advice);
    }

    item.append(pill, body);
    els.checksList.appendChild(item);
  }
}

function setActiveView(view) {
  state.activeView = view;
  const detailsActive = view === "details";
  els.detailsView.classList.toggle("hidden", !detailsActive);
  els.reportText.classList.toggle("hidden", detailsActive);
  els.detailsTabButton.classList.toggle("active", detailsActive);
  els.reportTabButton.classList.toggle("active", !detailsActive);
  els.detailsTabButton.setAttribute("aria-selected", detailsActive ? "true" : "false");
  els.reportTabButton.setAttribute("aria-selected", detailsActive ? "false" : "true");
}

function selectCheck(checkId) {
  state.selectedCheckId = checkId;
  renderChecks(state.report);
  renderDetails();
  setActiveView("details");
}

function selectedCheck() {
  const checks = state.report && Array.isArray(state.report.checks) ? state.report.checks : [];
  return checks.find((check) => check.id === state.selectedCheckId) || null;
}

function text(value, fallback = "") {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value);
}

function shortText(value, max = 900) {
  const cleaned = text(value).replace(/\s+/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1).trim()}...` : cleaned;
}

function append(parent, tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  parent.appendChild(node);
  return node;
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return text(value);
  return date.toLocaleString([], { dateStyle: "medium", timeStyle: "medium" });
}

function levelName(value) {
  const level = Number(value);
  if (level === 1) return "Critical";
  if (level === 2) return "Error";
  if (level === 3) return "Warning";
  if (level === 4) return "Information";
  return text(value);
}

function eventId(row) {
  return row.id ?? row.Id ?? row.eventIdentifier ?? row.EventIdentifier ?? "";
}

function eventProvider(row) {
  return row.providerName || row.ProviderName || row.sourceName || row.SourceName || row.productName || row.ProductName || row.logName || row.LogName || "";
}

function eventLevel(row) {
  return row.level || row.LevelDisplayName || row.Level || levelName(row.levelValue ?? row.LevelValue);
}

function eventTime(row) {
  return row.timeCreated || row.TimeCreated || row.timeGenerated || row.TimeGenerated || "";
}

function eventMessage(row) {
  return row.message || row.Message || "";
}

function extractFact(message, labels) {
  const source = text(message);
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`${escaped}\\s*:\\s*([^,;]+)`, "i").exec(source);
    if (match && match[1]) return match[1].trim();
  }
  return "";
}

function eventKind(row) {
  const provider = eventProvider(row).toLowerCase();
  const id = Number(eventId(row));
  if (provider.includes("application error") && id === 1000) return "App crash";
  if (provider.includes("application hang") || id === 1002) return "App hang";
  if (provider.includes("windows error reporting") || provider.includes("wer") || id === 1001) return "Crash report";
  if (provider.includes(".net runtime") || id === 1026) return ".NET app crash";
  if (provider.includes("whea")) return "Hardware error";
  if (/disk|ntfs|stor|atapi/.test(provider)) return "Storage event";
  if (/display|nvlddmkm|amdkmdag|igfx/.test(provider)) return "Display driver event";
  if (/thermal|acpi/.test(provider)) return "Thermal or ACPI event";
  if (provider.includes("service control manager")) return "Service event";
  if (/kernel-pnp|userpnp|driverframeworks|devicesetupmanager/.test(provider)) return "Driver or device event";
  if (row.sourceName || row.productName) return "Reliability record";
  return "Event";
}

function eventTitle(row) {
  const message = eventMessage(row);
  const app = extractFact(message, ["Faulting application name", "Application Name", "Name der fehlerhaften Anwendung"]);
  const module = extractFact(message, ["Faulting module name", "Fault Module Name", "Name des fehlerhaften Moduls"]);
  const product = row.productName || row.ProductName;
  if (app && module) return `${eventKind(row)}: ${app} in ${module}`;
  if (app) return `${eventKind(row)}: ${app}`;
  if (product) return `${eventKind(row)}: ${product}`;
  return `${eventKind(row)}: ${eventProvider(row) || "Unknown source"}`;
}

function eventFacts(row) {
  const message = eventMessage(row);
  return [
    ["Application", extractFact(message, ["Faulting application name", "Application Name", "Name der fehlerhaften Anwendung"])],
    ["Module", extractFact(message, ["Faulting module name", "Fault Module Name", "Name des fehlerhaften Moduls"])],
    ["Exception", extractFact(message, ["Exception code", "Exception Code", "Ausnahmecode"])],
    ["Path", extractFact(message, ["Faulting application path", "Application Path", "Pfad der fehlerhaften Anwendung"])],
  ].filter(([, value]) => value);
}

function collectEventSections(check) {
  const details = check && check.details ? check.details : {};
  const sections = [];
  const add = (title, rows, type = "events") => {
    const items = Array.isArray(rows) ? rows.filter(Boolean) : [];
    if (items.length) sections.push({ title, rows: items, type });
  };

  add("Important hardware events", details.severeHardwareEvents);
  add("Events", details.events);
  add("Update events", details.updateEvents);
  add("Service Control Manager events", details.serviceControlManagerEvents);
  add("Driver and device events", details.driverEvents);
  add("Reliability records", details.records, "records");
  add("Top repeated events", details.topEvents, "top");
  add("Top reliability records", details.topRecords, "top-records");

  for (const log of Array.isArray(details.logs) ? details.logs : []) {
    add(`${log.logName || "Event log"} recent events`, log.recentEvents);
    add(`${log.logName || "Event log"} repeated events`, log.topEvents, "top");
  }

  return sections;
}

function renderMetaChips(parent, entries) {
  const row = append(parent, "div", "meta-row");
  for (const entry of entries.filter(Boolean)) append(row, "span", "meta-chip", entry);
}

function renderEventCard(parent, row) {
  const card = append(parent, "article", "event-card");
  append(card, "h4", "", eventTitle(row));
  renderMetaChips(card, [
    eventProvider(row),
    eventId(row) ? `Event ${eventId(row)}` : "",
    eventLevel(row),
    formatDate(eventTime(row)),
  ]);

  const facts = eventFacts(row);
  if (facts.length) {
    const grid = append(card, "dl", "fact-grid");
    for (const [label, value] of facts) {
      append(grid, "dt", "", label);
      append(grid, "dd", "", value);
    }
  }

  const message = shortText(eventMessage(row), 1400);
  if (message) append(card, "p", "event-message", message);
}

function renderTopEventTable(parent, rows, type) {
  const table = append(parent, "div", "simple-table");
  const header = append(table, "div", "simple-row simple-header");
  for (const label of ["Count", "Source", "Event", "Level"]) append(header, "span", "", label);

  for (const row of rows.slice(0, 24)) {
    const item = append(table, "div", "simple-row");
    append(item, "span", "", text(row.count ?? row.Count ?? ""));
    append(item, "span", "", eventProvider(row));
    append(item, "span", "", eventId(row) ? `Event ${eventId(row)}` : text(row.eventIdentifier || ""));
    append(item, "span", "", type === "top-records" ? "" : levelName(row.levelValue ?? row.LevelValue ?? row.level));
  }
}

function primitiveEntries(object) {
  if (!object || typeof object !== "object" || Array.isArray(object)) return [];
  return Object.entries(object).filter(([, value]) => value === null || ["string", "number", "boolean"].includes(typeof value));
}

function renderKeyFacts(parent, details) {
  const entries = primitiveEntries(details).filter(([key]) => !/message|stdout|stderr|stack/i.test(key));
  if (!entries.length) return;

  const section = append(parent, "section", "detail-section");
  append(section, "h3", "", "Key facts");
  const grid = append(section, "dl", "fact-grid");
  for (const [key, value] of entries.slice(0, 16)) {
    append(grid, "dt", "", key);
    append(grid, "dd", "", text(value));
  }
}

function renderEventSections(parent, sections) {
  for (const sectionInfo of sections) {
    const section = append(parent, "section", "detail-section");
    append(section, "h3", "", `${sectionInfo.title} (${sectionInfo.rows.length})`);
    if (sectionInfo.type === "top" || sectionInfo.type === "top-records") {
      renderTopEventTable(section, sectionInfo.rows, sectionInfo.type);
    } else {
      const list = append(section, "div", "event-list");
      for (const event of sectionInfo.rows.slice(0, 80)) renderEventCard(list, event);
    }
  }
}

function renderRawDetails(parent, check) {
  const section = append(parent, "section", "detail-section");
  const details = document.createElement("details");
  details.className = "raw-details";
  const summary = document.createElement("summary");
  summary.textContent = "Raw structured details";
  const pre = document.createElement("pre");
  pre.className = "detail-json";
  pre.textContent = JSON.stringify({ details: check.details || {}, evidence: check.evidence || [] }, null, 2);
  details.append(summary, pre);
  section.appendChild(details);
}

function renderDetails() {
  els.detailsView.innerHTML = "";
  const check = selectedCheck();
  if (!check) {
    const empty = append(els.detailsView, "div", "empty-state");
    append(empty, "h3", "", state.running ? "Running diagnosis" : state.report ? "No check selected" : "No result yet");
    append(empty, "p", "", state.running ? "Collecting checks and evidence." : state.report ? "Select a check to inspect its evidence." : "Run a diagnosis to see check details.");
    return;
  }

  const header = append(els.detailsView, "section", "detail-header");
  const titleRow = append(header, "div", "detail-title-row");
  const pill = append(titleRow, "span", `status-pill status-${check.status}`, check.status.toUpperCase());
  pill.setAttribute("aria-label", `Status ${check.status}`);
  append(titleRow, "h2", "", check.title);
  append(header, "p", "detail-summary", check.summary || "");
  renderMetaChips(header, [
    check.id,
    check.severity ? `Severity: ${check.severity}` : "",
    check.startedAt && check.finishedAt ? `${formatDate(check.startedAt)} - ${formatDate(check.finishedAt)}` : "",
  ]);

  if (Array.isArray(check.advice) && check.advice.length) {
    const advice = append(els.detailsView, "section", "detail-section");
    append(advice, "h3", "", "Advice");
    const list = append(advice, "ul", "advice-list");
    for (const item of check.advice) append(list, "li", "", item);
  }

  const eventSections = collectEventSections(check);
  if (eventSections.length) renderEventSections(els.detailsView, eventSections);
  renderKeyFacts(els.detailsView, check.details || {});
  renderRawDetails(els.detailsView, check);
}

function updateFileButtons(files) {
  state.files = files || {};
  els.openTextButton.disabled = !state.files.text;
  els.openJsonButton.disabled = !state.files.json;
  els.openFolderButton.disabled = !(state.files.text || state.files.json);
}

function selectedTarget() {
  const index = Number(els.deviceSelect.value);
  return state.devices[index] ? state.devices[index].target : null;
}

async function refreshDevices() {
  els.refreshButton.disabled = true;
  try {
    renderDevices(await window.systemDiagnosis.listDevices());
  } catch (error) {
    els.deviceHint.textContent = error.message;
  } finally {
    els.refreshButton.disabled = false;
  }
}

async function chooseOutput() {
  const folder = await window.systemDiagnosis.chooseOutput();
  if (!folder) return;
  state.outputDir = folder;
  els.outputPath.value = folder;
}

async function runDiagnosis() {
  const target = selectedTarget();
  if (!target) {
    els.reportText.textContent = "No device selected.";
    return;
  }

  setRunState("Running", "running");
  state.running = true;
  state.report = null;
  els.runButton.disabled = true;
  updateFileButtons({});
  els.targetTitle.textContent = targetLabel(target);
  els.reportText.textContent = "Running diagnosis...";
  renderSummary(null);
  state.selectedCheckId = null;
  renderChecks(null);
  renderDetails();
  setActiveView("details");

  try {
    const result = await window.systemDiagnosis.run({
      target,
      profile: els.profileSelect.value,
      format: els.formatSelect.value,
      timeoutMs: Number(els.timeoutInput.value),
      output: els.outputPath.value,
    });
    state.report = result.report;
    state.selectedCheckId = (firstDetailCheck(result.report) || {}).id || null;
    renderSummary(result.report.summary);
    renderChecks(result.report);
    renderDetails();
    updateFileButtons(result.files);
    els.reportText.textContent = result.text;
    setRunState(result.report.summary.fail > 0 ? "Failed" : result.report.summary.warn > 0 ? "Warnings" : "Done", result.report.summary.fail > 0 ? "error" : "done");
  } catch (error) {
    els.reportText.textContent = error.stack || error.message;
    setActiveView("report");
    setRunState("Error", "error");
  } finally {
    state.running = false;
    renderDetails();
    els.runButton.disabled = false;
  }
}

async function openReport(kind) {
  const filePath = state.files[kind];
  if (filePath) await window.systemDiagnosis.openPath(filePath);
}

async function openFolder() {
  const filePath = state.files.text || state.files.json;
  if (!filePath) return;
  const folder = filePath.includes("\\") ? filePath.slice(0, filePath.lastIndexOf("\\")) : filePath.slice(0, filePath.lastIndexOf("/"));
  await window.systemDiagnosis.openPath(folder);
}

async function boot() {
  setRunState("Loading", "running");
  const initial = await window.systemDiagnosis.initial();
  els.versionLabel.textContent = `Version ${initial.version}`;
  state.outputDir = initial.outputDir;
  els.outputPath.value = initial.outputDir;
  renderDevices(initial.inventory);
  renderSummary(null);
  renderChecks(null);
  renderDetails();
  updateFileButtons({});
  setActiveView("details");
  setRunState("Idle", "idle");
}

els.deviceSelect.addEventListener("change", () => {
  state.selectedIndex = Number(els.deviceSelect.value) || 0;
});
els.refreshButton.addEventListener("click", refreshDevices);
els.chooseOutputButton.addEventListener("click", chooseOutput);
els.runButton.addEventListener("click", runDiagnosis);
els.detailsTabButton.addEventListener("click", () => setActiveView("details"));
els.reportTabButton.addEventListener("click", () => setActiveView("report"));
els.openTextButton.addEventListener("click", () => openReport("text"));
els.openJsonButton.addEventListener("click", () => openReport("json"));
els.openFolderButton.addEventListener("click", openFolder);

boot().catch((error) => {
  els.reportText.textContent = error.stack || error.message;
  setRunState("Error", "error");
});
