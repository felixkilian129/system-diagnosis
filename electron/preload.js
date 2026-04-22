"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("systemDiagnosis", {
  initial: () => ipcRenderer.invoke("app:initial"),
  listDevices: () => ipcRenderer.invoke("devices:list"),
  chooseOutput: () => ipcRenderer.invoke("output:choose"),
  openPath: (filePath) => ipcRenderer.invoke("path:open", filePath),
  run: (request) => ipcRenderer.invoke("diagnosis:run", request),
});
