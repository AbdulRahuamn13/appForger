// Sandboxed preload (must be CommonJS): the only bridge the web UI gets.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("appforge", {
  desktop: true,
  /** Native "choose folder" dialog; resolves to an absolute path or undefined. */
  pickFolder: () => ipcRenderer.invoke("appforge:pick-folder"),
});
