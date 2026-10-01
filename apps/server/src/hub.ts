import type { ServerMessage } from "@appforge/core";

interface Socket {
  readyState: number;
  send(data: string): void;
  on(event: "close", listener: () => void): void;
}

const OPEN = 1;

/** Fan-out of ServerMessages to every connected UI tab. */
export class Hub {
  private readonly sockets = new Set<Socket>();
  private readonly listeners = new Set<(msg: ServerMessage) => void>();

  add(socket: Socket): void {
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    socket.send(JSON.stringify({ kind: "hello", version: "0.1.0" } satisfies ServerMessage));
  }

  broadcast(message: ServerMessage): void {
    const data = JSON.stringify(message);
    for (const socket of this.sockets) {
      if (socket.readyState === OPEN) socket.send(data);
    }
    for (const listener of this.listeners) listener(message);
  }

  /** In-process subscription (used by tests). */
  subscribe(listener: (msg: ServerMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get size(): number {
    return this.sockets.size;
  }
}
