import * as net from "node:net";

interface PendingRpc {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export class CoreClient {
  private socket: net.Socket | null = null;
  private buffer = "";
  private pending = new Map<string, PendingRpc>();
  private seq = 0;

  constructor(private readonly onMessage: (msg: any) => void) {}

  connect(port: number): void {
    if (this.socket) {
      this.socket.destroy();
    }
    this.socket = net.createConnection({ host: "127.0.0.1", port }, () => {
      console.error(`[CoreClient] Connected to eisen-core TCP on port ${port}`);
    });
    this.buffer = "";

    this.socket.on("data", (data: Buffer) => {
      this.buffer += data.toString();
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg?.type === "rpc_result" || msg?.type === "rpc_error") {
            const pending = this.pending.get(msg.id);
            if (pending) {
              clearTimeout(pending.timeout);
              this.pending.delete(msg.id);
              if (msg.type === "rpc_result") {
                pending.resolve(msg.result);
              } else {
                pending.reject(new Error(msg.error?.message || "rpc_error"));
              }
            }
            continue;
          }
          this.onMessage(msg);
        } catch (e) {
          console.warn("[CoreClient] Failed to parse TCP line:", (e as Error).message, line.substring(0, 200));
        }
      }
    });

    this.socket.on("error", (err) => {
      console.error("[CoreClient] TCP error:", err.message);
    });

    this.socket.on("close", () => {
      console.error("[CoreClient] TCP connection closed");
      this.socket = null;
    });
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("core socket closed"));
    }
    this.pending.clear();
  }

  send(msg: Record<string, unknown>): void {
    if (!this.socket) return;
    const line = JSON.stringify(msg) + "\n";
    this.socket.write(line);
  }

  requestSnapshot(sessionId?: string): void {
    this.send({ type: "request_snapshot", ...(sessionId ? { session_id: sessionId } : {}) });
  }

  setStreamFilter(filter: { sessionId?: string; sessionMode?: string }): void {
    const payload: Record<string, unknown> = { type: "set_stream_filter" };
    if (filter.sessionId) payload.session_id = filter.sessionId;
    if (filter.sessionMode) payload.session_mode = filter.sessionMode;
    this.send(payload);
  }

  async rpc(method: string, params?: Record<string, unknown>, timeoutMs = 5000): Promise<any> {
    if (!this.socket) {
      throw new Error("core socket not connected");
    }
    const id = `rpc_${Date.now()}_${this.seq++}`;
    const payload: Record<string, unknown> = {
      type: "rpc",
      id,
      method,
      ...(params ? { params } : {}),
    };

    const result = new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("rpc timeout"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
    });

    this.send(payload);
    return result;
  }
}
