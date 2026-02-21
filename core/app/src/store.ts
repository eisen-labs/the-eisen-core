import { load } from "@tauri-apps/plugin-store";

const STORE_PATH = "eisen-settings.json";
const RECENT_KEY = "recentWorkspaces";

export interface RecentWorkspace {
  path: string;
  name: string;
  lastOpened: number;
}

export class AppStore {
  private static instance: AppStore;
  
  private constructor() {}

  static getInstance() {
    if (!AppStore.instance) {
      AppStore.instance = new AppStore();
    }
    return AppStore.instance;
  }

  async getRecentWorkspaces(): Promise<RecentWorkspace[]> {
    const store = await load(STORE_PATH);
    const recent = await store.get<RecentWorkspace[]>(RECENT_KEY);
    return recent || [];
  }

  async addRecentWorkspace(path: string) {
    const store = await load(STORE_PATH);
    let recent = await this.getRecentWorkspaces();
    
    // Remove if exists
    recent = recent.filter(w => w.path !== path);
    
    // Add to front
    const name = path.split(/[/\\]/).filter(Boolean).pop() || path;
    recent.unshift({
      path,
      name,
      lastOpened: Date.now()
    });
    
    // Limit to 10
    recent = recent.slice(0, 10);
    
    await store.set(RECENT_KEY, recent);
    await store.save();
  }

  async removeRecentWorkspace(path: string) {
    const store = await load(STORE_PATH);
    let recent = await this.getRecentWorkspaces();
    recent = recent.filter(w => w.path !== path);
    await store.set(RECENT_KEY, recent);
    await store.save();
  }
}
