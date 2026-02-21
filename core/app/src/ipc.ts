import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface HostMessage {
  type: string;
  [key: string]: unknown;
}

export type MessageHandler = (msg: any) => void;

class IPC {
  private running = false;
  private handlers: Set<MessageHandler> = new Set();
  private unlisteners: UnlistenFn[] = [];

  async init(cwd: string) {
    console.log(`[IPC] Spawning host with cwd: ${cwd}`);

    this.unlisteners.push(
      await listen<string>("host-stdout", (event) => {
        const line = event.payload;
        if (!line.trim()) return;
        try {
          const message = JSON.parse(line);
          this.notify(message);
        } catch (e) {
          console.warn("[IPC] Failed to parse host stdout:", e, line.substring(0, 200));
        }
      })
    );

    this.unlisteners.push(
      await listen<string>("host-stderr", (event) => {
        console.error("[IPC eisen-host]", event.payload);
      })
    );

    this.unlisteners.push(
      await listen<number>("host-close", (event) => {
        console.log(`[IPC] Host process exited with code ${event.payload}`);
        this.running = false;
      })
    );

    await invoke("spawn_host", { cwd });
    this.running = true;
    this.send({ type: "ready" });
  }

  send(message: Record<string, unknown>) {
    if (!this.running) {
      console.warn("[IPC] Cannot send — host not spawned");
      return;
    }
    const line = JSON.stringify(message) + "\n";
    invoke("send_to_host", { message: line }).catch((e) => {
      console.error("[IPC] Failed to send to host:", e);
    });
  }

  onMessage(handler: MessageHandler) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private notify(message: any) {
    for (const handler of this.handlers) {
      handler(message);
    }
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
