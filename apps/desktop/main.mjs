// AppForge desktop wrapper: starts the local server, opens it in a window,
// and offers a native folder dialog to the UI. The server itself is the
// same one `pnpm start` runs; nothing here talks to models or credentials.
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, "../server");
const smokeShot = process.env.APPFORGE_DESKTOP_SMOKE;

let serverProcess;
let mainWindow;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`AppForge server did not start at ${url}`);
}

async function startServer() {
  const port = Number(process.env.APPFORGE_PORT) || (await freePort());
  // Use the system Node (native modules such as better-sqlite3 are built for it, not Electron).
  serverProcess = spawn(process.env.APPFORGE_NODE ?? "node", ["--import", "tsx", "src/index.ts"], {
    cwd: serverDir,
    env: { ...process.env, APPFORGE_PORT: String(port), NODE_ENV: "production" },
    stdio: "inherit",
  });
  serverProcess.on("exit", (code) => {
    if (!app.isQuitting) dialog.showErrorBox("AppForge", `The AppForge server stopped (exit ${code}).`);
    app.quit();
  });
  const url = `http://127.0.0.1:${port}`;
  await waitFor(`${url}/api/health`);
  return url;
}

ipcMain.handle("appforge:pick-folder", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
  const result = await dialog.showOpenDialog(win, {
    title: "Choose a project folder",
    properties: ["openDirectory", "createDirectory"],
  });
  return result.canceled ? undefined : result.filePaths[0];
});

async function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    title: "AppForge",
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Links to other sites open in the default browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (!target.startsWith(url)) void shell.openExternal(target);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (e, target) => {
    if (!target.startsWith(url)) e.preventDefault();
  });
  await mainWindow.loadURL(url);

  if (smokeShot) {
    // Headless smoke test: check the bridge, save a screenshot, quit.
    const bridge = await mainWindow.webContents.executeJavaScript("typeof window.appforge?.pickFolder");
    await new Promise((r) => setTimeout(r, 1500));
    const image = await mainWindow.webContents.capturePage();
    await writeFile(smokeShot, image.toPNG());
    console.log(`desktop smoke: bridge=${bridge} screenshot=${smokeShot}`);
    app.quit();
  }
}

app.on("before-quit", () => {
  app.isQuitting = true;
  serverProcess?.kill("SIGTERM");
});
app.on("window-all-closed", () => app.quit());

app.whenReady().then(async () => {
  try {
    await createWindow(await startServer());
  } catch (err) {
    dialog.showErrorBox("AppForge", String(err?.message ?? err));
    app.quit();
  }
});
