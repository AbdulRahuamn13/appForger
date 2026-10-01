import { useEffect } from "react";
import type { ServerMessage } from "@appforge/core";
import { toast } from "@/components/ui/toast.tsx";
import { href } from "./router.ts";
import { socket } from "./socket.ts";

const KEY = "appforge.notifications";

export function notificationsEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

export async function setNotificationsEnabled(on: boolean): Promise<void> {
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    // ignore
  }
  if (on && "Notification" in window && Notification.permission === "default") await Notification.requestPermission();
}

function announce(text: string, tone: "info" | "success" | "error", link?: string): void {
  toast(text, tone, link);
  if (!notificationsEnabled() || !document.hidden || !("Notification" in window) || Notification.permission !== "granted") return;
  const n = new Notification("AppForge", { body: text, tag: text });
  n.onclick = () => {
    window.focus();
    if (link) window.location.hash = link.slice(1);
  };
}

/**
 * Long runs need you only at a few moments: a plan to review, a merge to
 * approve, a run that finished. Toast in the app, and notify the desktop
 * when the tab is in the background.
 */
export function useAttentionNotifications(): void {
  useEffect(() => {
    socket.start();
    const seen = new Set<string>();
    return socket.on((msg: ServerMessage) => {
      if (msg.kind === "story-updated" && msg.story.status === "plan-review" && msg.story.plan) {
        const key = `plan-${msg.story.id}-${msg.story.plan.version}`;
        if (!seen.has(key)) {
          seen.add(key);
          announce(`Plan ready for "${msg.story.title}" — review it`, "info", href({ page: "project", id: msg.story.projectId, tab: "stories", item: msg.story.id }));
        }
      } else if (msg.kind === "approval-updated" && msg.approval.status === "pending" && !seen.has(msg.approval.id)) {
        seen.add(msg.approval.id);
        announce(`Approval needed: ${msg.approval.title}`, "info", href({ page: "run", id: msg.approval.runId }));
      } else if (msg.kind === "run-updated" && ["succeeded", "failed"].includes(msg.run.status) && msg.run.mode !== "plan") {
        const key = `run-${msg.run.id}-${msg.run.status}`;
        if (!seen.has(key)) {
          seen.add(key);
          announce(`Run ${msg.run.status}: ${msg.run.brief.split("\n")[0]}`, msg.run.status === "succeeded" ? "success" : "error", href({ page: "run", id: msg.run.id }));
        }
      } else if (msg.kind === "run-updated" && msg.run.status === "paused" && !seen.has(`paused-${msg.run.id}-${msg.run.updatedAt}`)) {
        seen.add(`paused-${msg.run.id}-${msg.run.updatedAt}`);
        announce(`Run paused: ${msg.run.error ?? "needs you"}`, "error", href({ page: "run", id: msg.run.id }));
      }
    });
  }, []);
}
