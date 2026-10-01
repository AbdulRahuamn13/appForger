import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";
import type { AgentEventPayload } from "@appforge/core";
import { cn } from "@/lib/utils.ts";

export interface LogLine {
  /** Optional prefix, e.g. "coder-1". */
  label?: string;
  event: AgentEventPayload | { type: "log"; level: "info" | "warn" | "error"; message: string };
}

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
};

const LABEL_COLORS = [C.cyan, C.magenta, C.blue, C.yellow, C.green];

function labelColor(label: string): string {
  let h = 0;
  for (const ch of label) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return LABEL_COLORS[h % LABEL_COLORS.length] ?? C.cyan;
}

function clip(text: string, max = 600): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function formatLine({ label, event: e }: LogLine): string {
  const prefix = label ? `${labelColor(label)}[${label}]${C.reset} ` : "";
  switch (e.type) {
    case "log": {
      const color = e.level === "error" ? C.red : e.level === "warn" ? C.yellow : C.blue;
      return `${prefix}${color}▸ ${e.message}${C.reset}`;
    }
    case "session-start":
      return `${prefix}${C.dim}● session started${e.model ? ` (${e.model})` : ""}${C.reset}`;
    case "text":
      return `${prefix}${e.text}`;
    case "thinking":
      return `${prefix}${C.dim}${clip(e.text, 400)}${C.reset}`;
    case "tool-call":
      return `${prefix}${C.cyan}→ ${e.tool}${C.reset} ${C.dim}${clip(e.input, 300)}${C.reset}`;
    case "tool-result":
      return `${prefix}${e.isError ? C.red : C.dim}← ${clip(e.output.split("\n").slice(0, 6).join("\n"), 400)}${C.reset}`;
    case "file-change":
      return `${prefix}${C.green}✎ ${e.kind} ${e.path}${C.reset}`;
    case "command":
      return `${prefix}${C.yellow}$ ${e.command}${C.reset}${e.exitCode !== undefined ? ` ${e.exitCode === 0 ? C.green : C.red}(exit ${e.exitCode})${C.reset}` : ""}`;
    case "usage":
      return `${prefix}${C.dim}tokens in ${e.inputTokens.toLocaleString()} / out ${e.outputTokens.toLocaleString()}${e.costUsd ? ` · $${e.costUsd.toFixed(4)}` : ""}${C.reset}`;
    case "warning":
      return `${prefix}${C.yellow}⚠ ${e.message}${C.reset}`;
    case "error":
      return `${prefix}${C.red}✖ ${e.message}${e.rateLimited ? " (rate limited)" : ""}${C.reset}`;
    case "session-end":
      return `${prefix}${C.bold}${e.status === "completed" ? C.green : e.status === "stopped" ? C.yellow : C.red}■ ${e.status}${C.reset}`;
  }
}

/** Live agent output in an xterm.js pane. Appends incrementally; resets when lines shrink. */
export function LogPane({ lines, className }: { lines: LogLine[]; className?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal>(undefined);
  const written = useRef(0);

  useEffect(() => {
    if (!host.current) return;
    const t = new Terminal({
      convertEol: true,
      disableStdin: true,
      fontSize: 12,
      fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
      scrollback: 20_000,
      theme: { background: "#18181b", foreground: "#e4e4e7" },
      cursorStyle: "bar",
      cursorInactiveStyle: "none",
    });
    const fit = new FitAddon();
    t.loadAddon(fit);
    t.open(host.current);
    term.current = t;
    written.current = 0;
    const resize = () => {
      try {
        fit.fit();
      } catch {
        // hidden
      }
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(host.current);
    return () => {
      observer.disconnect();
      t.dispose();
      term.current = undefined;
    };
  }, []);

  useEffect(() => {
    const t = term.current;
    if (!t) return;
    if (lines.length < written.current) {
      t.reset();
      written.current = 0;
    }
    for (let i = written.current; i < lines.length; i++) t.writeln(formatLine(lines[i] as LogLine));
    written.current = lines.length;
  }, [lines]);

  return <div className={cn("overflow-hidden rounded-md bg-[#18181b] p-2", className)} ref={host} data-testid="log-pane" />;
}
