"use strict";

const state = {
  devices: [],
  selectedIndex: 0,
  outputDir: "",
  files: {},
  report: null,
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

function renderChecks(report) {
  els.checksList.innerHTML = "";
  const checks = report && Array.isArray(report.checks) ? report.checks : [];
  els.checkCount.textContent = String(checks.length);
  const rank = { fail: 0, warn: 1, ok: 2, info: 3, skip: 4 };

  for (const check of [...checks].sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9))) {
    const item = document.createElement("article");
    item.className = "check-item";

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
  els.runButton.disabled = true;
  updateFileButtons({});
  els.targetTitle.textContent = targetLabel(target);
  els.reportText.textContent = "Running diagnosis...";
  renderSummary(null);
  renderChecks(null);

  try {
    const result = await window.systemDiagnosis.run({
      target,
      profile: els.profileSelect.value,
      format: els.formatSelect.value,
      timeoutMs: Number(els.timeoutInput.value),
      output: els.outputPath.value,
    });
    state.report = result.report;
    renderSummary(result.report.summary);
    renderChecks(result.report);
    updateFileButtons(result.files);
    els.reportText.textContent = result.text;
    setRunState(result.report.summary.fail > 0 ? "Failed" : result.report.summary.warn > 0 ? "Warnings" : "Done", result.report.summary.fail > 0 ? "error" : "done");
  } catch (error) {
    els.reportText.textContent = error.stack || error.message;
    setRunState("Error", "error");
  } finally {
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
  updateFileButtons({});
  setRunState("Idle", "idle");
}

els.deviceSelect.addEventListener("change", () => {
  state.selectedIndex = Number(els.deviceSelect.value) || 0;
});
els.refreshButton.addEventListener("click", refreshDevices);
els.chooseOutputButton.addEventListener("click", chooseOutput);
els.runButton.addEventListener("click", runDiagnosis);
els.openTextButton.addEventListener("click", () => openReport("text"));
els.openJsonButton.addEventListener("click", () => openReport("json"));
els.openFolderButton.addEventListener("click", openFolder);

boot().catch((error) => {
  els.reportText.textContent = error.stack || error.message;
  setRunState("Error", "error");
});
