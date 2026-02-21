import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

let _cwd = process.cwd();

export function setCwd(dir: string): void {
  _cwd = dir;
}

export function getCwd(): string {
  return _cwd;
}

function getAppDataDir(): string {
  const appName = "app.labs.eisen";
  switch (process.platform) {
    case "darwin":
      return path.join(os.homedir(), "Library", "Application Support", appName);
    case "win32":
      return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), appName);
    default:
      return path.join(
        process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"),
        appName,
      );
  }
}

export class StateStore {
  private data: Record<string, unknown> = {};
  private filePath: string;

  constructor() {
    const dir = getAppDataDir();
    this.filePath = path.join(dir, "host-state.json");

    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, "utf-8");
        this.data = JSON.parse(raw);
      }
    } catch (e) {
      console.error("[StateStore] Failed to load state:", e);
      this.data = {};
    }
  }

  get<T>(key: string, defaultValue?: T): T | undefined {
    return (this.data[key] as T) ?? defaultValue;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.data[key] = value;
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
    } catch (e) {
      console.error("[StateStore] Failed to save state:", e);
    }
  }
}
