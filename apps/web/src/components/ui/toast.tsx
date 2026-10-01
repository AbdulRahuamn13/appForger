import { CheckCircle2, Info, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils.ts";

type ToastTone = "info" | "success" | "error";
interface ToastItem {
  id: number;
  text: string;
  tone: ToastTone;
  href?: string;
}

let next = 1;
const listeners = new Set<(items: ToastItem[]) => void>();
let items: ToastItem[] = [];

/** Show a small notification in the corner. */
export function toast(text: string, tone: ToastTone = "info", href?: string): void {
  const item: ToastItem = { id: next++, text, tone, ...(href ? { href } : {}) };
  items = [...items, item].slice(-4);
  listeners.forEach((l) => l(items));
  setTimeout(() => {
    items = items.filter((i) => i.id !== item.id);
    listeners.forEach((l) => l(items));
  }, 5_000);
}

export function Toaster() {
  const [list, setList] = useState<ToastItem[]>(items);
  useEffect(() => {
    listeners.add(setList);
    return () => void listeners.delete(setList);
  }, []);
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-80 flex-col gap-2" aria-live="polite">
      {list.map((t) => {
        const Icon = t.tone === "success" ? CheckCircle2 : t.tone === "error" ? XCircle : Info;
        const body = (
          <>
            <Icon className={cn("mt-0.5 size-4 shrink-0", t.tone === "success" ? "text-success" : t.tone === "error" ? "text-destructive" : "text-info")} />
            <span>{t.text}</span>
          </>
        );
        const cls = "pointer-events-auto flex items-start gap-2 rounded-lg border bg-card px-3 py-2.5 text-[13px] shadow-lg";
        return t.href ? (
          <a key={t.id} href={t.href} className={cn(cls, "hover:bg-muted")}>
            {body}
          </a>
        ) : (
          <div key={t.id} className={cls}>
            {body}
          </div>
        );
      })}
    </div>
  );
}
