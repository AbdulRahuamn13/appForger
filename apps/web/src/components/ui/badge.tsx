import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils.ts";

const badgeVariants = cva("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap", {
  variants: {
    tone: {
      neutral: "bg-muted text-foreground",
      primary: "border-primary/30 bg-primary/10 text-primary",
      success: "border-success/30 bg-success/10 text-success",
      warning: "border-warning/40 bg-warning/15 text-[oklch(0.5_0.13_70)]",
      danger: "border-destructive/30 bg-destructive/10 text-destructive",
      info: "border-sky-300 bg-sky-50 text-sky-700",
    },
  },
  defaultVariants: { tone: "neutral" },
});

export type BadgeProps = HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>;

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

export type Tone = NonNullable<BadgeProps["tone"]>;

export function statusTone(status: string): Tone {
  if (["succeeded", "merged", "approved", "approve", "passed", "ok"].includes(status)) return "success";
  if (["failed", "rejected", "cancelled", "request-changes", "error"].includes(status)) return "danger";
  if (["awaiting-approval", "awaiting-input", "paused", "interrupted", "changes-requested", "pending"].includes(status)) return "warning";
  if (["running", "in-progress", "review", "testing", "ready-to-merge"].includes(status)) return "info";
  return "neutral";
}
