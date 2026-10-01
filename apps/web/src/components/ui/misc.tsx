import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils.ts";

export function ErrorNote({ error }: { error: string | undefined }) {
  if (!error) return null;
  return <p className="rounded-md border border-destructive/30 px-3 py-2 text-[13px] text-destructive">{error}</p>;
}

export function Empty({ children, className, icon }: { children: ReactNode; className?: string; icon?: ReactNode }) {
  return (
    <div className={cn("flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-10 text-center text-[13px] text-muted-foreground", className)}>
      {icon}
      {children}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn("size-3.5 animate-spin text-muted-foreground", className)} />;
}

/** Underlined text tabs. */
export function Tabs<T extends string>({
  value,
  onChange,
  tabs,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  tabs: { value: T; label: ReactNode; count?: number }[];
  className?: string;
}) {
  return (
    <div className={cn("flex gap-5 border-b text-[13px]", className)} role="tablist">
      {tabs.map((t) => (
        <button
          key={t.value}
          type="button"
          role="tab"
          aria-selected={value === t.value}
          className={cn(
            "-mb-px border-b-2 border-transparent pb-2 text-muted-foreground transition-colors hover:text-foreground",
            value === t.value && "border-foreground text-foreground",
          )}
          onClick={() => onChange(t.value)}
        >
          {t.label}
          {t.count ? <span className="ml-1.5 text-xs text-muted-foreground">{t.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border bg-muted px-1 font-mono text-[10px] text-muted-foreground">{children}</kbd>;
}
