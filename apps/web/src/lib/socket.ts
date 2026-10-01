import { useEffect, useRef, useState } from "react";
import type { ServerMessage } from "@appforge/core";

type Listener = (msg: ServerMessage) => void;

/** One shared, auto-reconnecting WebSocket for the whole app. */
class SocketClient {
  private ws: WebSocket | undefined;
  private readonly listeners = new Set<Listener>();
  private readonly statusListeners = new Set<(up: boolean) => void>();
  private retry = 0;
  connected = false;

  start(): void {
    if (this.ws) return;
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.setConnected(true);
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as ServerMessage;
      for (const l of this.listeners) l(msg);
    };
    ws.onclose = () => {
      this.ws = undefined;
      this.setConnected(false);
      const delay = Math.min(10_000, 500 * 2 ** this.retry++);
      setTimeout(() => this.start(), delay);
    };
  }

  private setConnected(up: boolean): void {
    this.connected = up;
    for (const l of this.statusListeners) l(up);
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onStatus(listener: (up: boolean) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }
}

export const socket = new SocketClient();

/** Subscribe to server messages; the handler can change between renders. */
export function useServerMessages(handler: Listener): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    socket.start();
    return socket.on((msg) => ref.current(msg));
  }, []);
}

export function useSocketStatus(): boolean {
  const [up, setUp] = useState(socket.connected);
  useEffect(() => {
    socket.start();
    return socket.onStatus(setUp);
  }, []);
  return up;
}
