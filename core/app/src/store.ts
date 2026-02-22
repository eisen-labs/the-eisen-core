import { load } from "@tauri-apps/plugin-store";

export interface RecentWorkspace { path: string; name: string; lastOpened: number }

const STORE = "eisen-settings.json";
const KEY = "recentWorkspaces";

export async function getRecent(): Promise<RecentWorkspace[]> {
  return (await (await load(STORE)).get<RecentWorkspace[]>(KEY)) ?? [];
}

export async function addRecent(path: string) {
  const store = await load(STORE);
  const list = (await getRecent()).filter((w) => w.path !== path);
  list.unshift({ path, name: path.split(/[/\\]/).filter(Boolean).pop() || path, lastOpened: Date.now() });
  await store.set(KEY, list.slice(0, 10));
  await store.save();
}
