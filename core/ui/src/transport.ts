export interface Transport {
  send(msg: { type: string; [key: string]: unknown }): void;
  listen(handler: (msg: { method: string; params?: unknown }) => void): void;
}
