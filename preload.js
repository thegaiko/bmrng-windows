const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bmrng", {
  devices: () => ipcRenderer.invoke("devices"),
  accountInfo: () => ipcRenderer.invoke("account-info"),
  accountLogin: (p) => ipcRenderer.invoke("account-login", p),
  accountLogout: () => ipcRenderer.invoke("account-logout"),
  catalog: () => ipcRenderer.invoke("catalog"),
  checkOwned: (app) => ipcRenderer.invoke("check-owned", app),
  install: (p) => ipcRenderer.invoke("install", p),
  onInstallProgress: (cb) => ipcRenderer.on("install-progress", (_e, m) => cb(m)),
  register: (b) => ipcRenderer.invoke("bmrng-register", b),
  verify: (b) => ipcRenderer.invoke("bmrng-verify", b),
  login: (b) => ipcRenderer.invoke("bmrng-login", b),
  configGet: () => ipcRenderer.invoke("config-get"),
  configSet: (p) => ipcRenderer.invoke("config-set", p),
});
