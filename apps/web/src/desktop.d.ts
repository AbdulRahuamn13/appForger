/** Bridge exposed by the optional Electron wrapper (apps/desktop/preload.cjs). */
interface AppForgeDesktopBridge {
  desktop: true;
  pickFolder(): Promise<string | undefined>;
}

interface Window {
  appforge?: AppForgeDesktopBridge;
}
