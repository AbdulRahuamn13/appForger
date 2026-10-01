import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils.ts";

/** Safe Markdown (no raw HTML) for plans, specs, skills and memory. */
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn("prose-min text-[13px]", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}
