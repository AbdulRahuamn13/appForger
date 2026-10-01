import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils.ts";

const badgeVariants = cva("inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap", {
  variants: {
    tone: {
      neutral: "text-muted-foreground",
      primary: "text-foreground",
      success: "text-success",
      warning: "text-warning",
      danger: "text-destructive",
      info: "text-info",
    },
  },
  defaultVariants: { tone: "neutral" },
});

const DOT: Record<string, string> = {
  neutral: "bg-muted-foreground/60",
  primary: "bg-foreground",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-destructive",
  info: "bg-info",
};

export type BadgeProps = HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants> & { dot?: boolean; pulse?: boolean };

/** Quiet status pill: coloured dot + text. */
export function Badge({ className, tone, dot = false, pulse = false, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ tone }), className)} {...props}>
      {dot && <span className={cn("size-1.5 rounded-full", DOT[tone ?? "neutral"], pulse && "animate-pulse")} />}
      {children}
    </span>
  );
}

export type Tone = NonNullable<BadgeProps["tone"]>;

export function statusTone(status: string): Tone {
  if (["succeeded", "merged", "approved", "approve", "passed", "ok", "done", "running-ok"].includes(status)) return "success";
  if (["failed", "rejected", "cancelled", "request-changes", "error"].includes(status)) return "danger";
  if (["awaiting-approval", "awaiting-input", "paused", "interrupted", "changes-requested", "pending", "plan-review", "reverted"].includes(status)) return "warning";
  if (["running", "in-progress", "review", "testing", "ready-to-merge", "planning", "starting"].includes(status)) return "info";
  return "neutral";
}

export function isBusy(status: string): boolean {
  return ["running", "in-progress", "review", "testing", "planning", "starting", "pending"].includes(status);
}
