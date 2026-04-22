"use strict";

const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const diagnosis = require("../system_diagnosis");

let mainWindow = null;
let running = false;

function debugLog(message) {
  const logPath = process.env.SYSTEM_DIAGNOSIS_DEBUG_LOG;
  if (!logPath) return;
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`, "utf8");
  } catch (_) {
    // Debug logging must never affect normal app startup.
  }
}

process.on("uncaughtException", (error) => {
  debugLog(`uncaughtException: ${error.stack || error.message}`);
  throw error;
});

process.on("unhandledRejection", (error) => {
  debugLog(`unhandledRejection: ${error && error.stack ? error.stack : error}`);
});

function defaultOutputDir() {
  return path.join(app.getPath("documents"), "System Diagnosis", "logs");
}

function createWindow() {
  debugLog("createWindow");
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 920,
    minHeight: 620,
    backgroundColor: "#f5f7fb",
    title: "System Diagnosis",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, "index.html"));

  mainWindow.webContents.once("did-finish-load", async () => {
    debugLog("did-finish-load");
    const screenshotPath = process.env.SYSTEM_DIAGNOSIS_SCREENSHOT;
    if (!screenshotPath && process.env.SYSTEM_DIAGNOSIS_SMOKE !== "1") return;
    mainWindow.show();
    mainWindow.focus();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    if (screenshotPath) {
      const bounds = mainWindow.getBounds();
      const image = await mainWindow.webContents.capturePage({
        x: 0,
        y: 0,
        width: bounds.width,
        height: bounds.height,
      });
      const png = image.toPNG();
      debugLog(`screenshot-size: ${JSON.stringify(image.getSize())}, bytes=${png.length}`);
      fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
      fs.writeFileSync(screenshotPath, png);
      debugLog(`screenshot-written: ${screenshotPath}`);
    }
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
    app.exit(0);
  });
}

app.whenReady().then(() => {
  debugLog("app-ready");
  app.setName("System Diagnosis");
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("app:initial", async () => ({
  version: diagnosis.VERSION,
  outputDir: defaultOutputDir(),
  inventory: await diagnosis.listDevices(),
}));

ipcMain.handle("devices:list", async () => diagnosis.listDevices());

ipcMain.handle("output:choose", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Choose report folder",
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle("path:open", async (_event, filePath) => {
  if (!filePath) return { ok: false, error: "No path provided" };
  const error = await shell.openPath(filePath);
  return { ok: !error, error };
});

ipcMain.handle("diagnosis:run", async (_event, request) => {
  if (running) throw new Error("A diagnosis is already running.");
  running = true;
  try {
    const target = request && request.target;
    if (!target) throw new Error("No device selected.");

    const options = {
      profile: ["quick", "full", "extended"].includes(request.profile) ? request.profile : "full",
      format: ["text", "json", "all"].includes(request.format) ? request.format : "all",
      output: request.output || defaultOutputDir(),
      timeoutMs: Number(request.timeoutMs) > 0 ? Number(request.timeoutMs) : 15000,
      nonInteractive: true,
    };

    const report = await diagnosis.runDiagnosis(target, options);
    const files = diagnosis.writeReports(report, options);
    return {
      report,
      files,
      text: diagnosis.render(report),
    };
  } finally {
    running = false;
  }
});
