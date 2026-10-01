import type { ReactNode } from "react";
import { cn } from "@/lib/utils.ts";

export function ErrorNote({ error }: { error: string | undefined }) {
  if (!error) return null;
  return <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>;
}

export function Empty({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground", className)}>{children}</div>;
}

export function Tabs<T extends string>({
  value,
  onChange,
  tabs,
}: {
  value: T;
  onChange: (v: T) => void;
  tabs: { value: T; label: ReactNode }[];
}) {
  return (
    <div className="inline-flex rounded-md bg-muted p-1 text-sm" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.value}
          type="button"
          role="tab"
          aria-selected={value === t.value}
          className={cn("rounded px-3 py-1 font-medium text-muted-foreground", value === t.value && "bg-card text-foreground shadow-xs")}
          onClick={() => onChange(t.value)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
