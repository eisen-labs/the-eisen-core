import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

class IPC {
  private handler: ((msg: any) => void) | null = null;
  private unlisteners: UnlistenFn[] = [];
  private alive = false;

  async init(cwd: string, handler: (msg: any) => void) {
    this.alive = false;
    for (const unlisten of this.unlisteners) unlisten();
    this.unlisteners = [];
    this.handler = handler;

    // Register data listeners before spawn to not miss early messages
    const [stdoutUn, stderrUn] = await Promise.all([
      listen<string>("host-stdout", (event) => {
        this.alive = true;
        const line = event.payload;
        if (!line.trim()) return;
        try { this.handler?.(JSON.parse(line)); } catch (e) {
          console.warn("[IPC] Bad JSON from host:", e);
        }
      }),
      listen<string>("host-stderr", (event) => {
        console.error("[IPC host]", event.payload);
      }),
    ]);

    // spawn_host kills the previous host (blocks ~200ms) then starts a new one.
    // Register close listener AFTER spawn so the old host's death doesn't trigger it.
    await invoke("spawn_host", { cwd });

    const closeUn = await listen<number>("host-close", () => {
      if (!this.alive) return;
      this.alive = false;
      this.handler?.({ type: "hostDied" });
    });

    this.unlisteners = [stdoutUn, stderrUn, closeUn];
    this.send({ type: "ready" });
  }

  send(message: Record<string, unknown>) {
    invoke("send_to_host", { message: JSON.stringify(message) + "\n" }).catch((e) => {
      console.warn("[IPC] Send failed:", e);
    });
  }
}

export const ipc = new IPC();

export async function getLaunchCwd(): Promise<string | null> {
  try {
    return await invoke<string | null>("get_launch_cwd");
  } catch (e) {
    console.warn("[IPC] Failed to read launch CWD:", e);
    return null;
  }
}
