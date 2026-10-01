import { DiffEditor, loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor/editor/editor.api";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
// Syntax colouring only (Monarch tokenizers, loaded per language on demand); no language-service workers.
import "monaco-editor/languages/definitions/register.all";
import "monaco-editor/features/codicon/register";
import { useState } from "react";
import type { FileDiff } from "@appforge/core";
import { cn } from "@/lib/utils.ts";

// Bundle Monaco locally instead of loading it from a CDN: AppForge is a local tool.
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
loader.config({ monaco: monaco as unknown as Parameters<typeof loader.config>[0]["monaco"] });

const LANGS: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  json: "javascript",
  md: "markdown",
  css: "css",
  html: "html",
  py: "python",
  cs: "csharp",
  csproj: "xml",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  sql: "sql",
  sh: "shell",
};

function language(file: string): string {
  return LANGS[file.split(".").pop()?.toLowerCase() ?? ""] ?? "plaintext";
}

const STATUS_COLORS: Record<FileDiff["status"], string> = {
  added: "text-success",
  modified: "text-sky-600",
  deleted: "text-destructive",
  renamed: "text-[oklch(0.5_0.13_70)]",
};

/** Side-by-side Monaco diff with a file list. Default export so it can be lazy-loaded. */
export default function DiffViewer({ files }: { files: FileDiff[] }) {
  const [selected, setSelected] = useState(0);
  const file = files[selected];
  if (!file) return <p className="p-4 text-sm text-muted-foreground">No changes.</p>;
  return (
    <div className="flex h-[70vh] min-h-96 overflow-hidden rounded-md border">
      <ul className="w-64 shrink-0 overflow-y-auto border-r bg-muted/40 text-xs">
        {files.map((f, i) => (
          <li key={f.path}>
            <button
              type="button"
              onClick={() => setSelected(i)}
              className={cn("flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-muted", i === selected && "bg-card font-medium")}
            >
              <span className={cn("w-3 shrink-0 font-mono", STATUS_COLORS[f.status])}>{f.status[0]?.toUpperCase()}</span>
              <span className="truncate font-mono" title={f.path}>
                {f.path}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className="min-w-0 flex-1">
        <DiffEditor
          key={file.path}
          original={file.before}
          modified={file.after}
          language={language(file.path)}
          // Avoids "TextModel got disposed before DiffEditorWidget model got reset" on unmount.
          keepCurrentOriginalModel
          keepCurrentModifiedModel
          options={{ readOnly: true, renderSideBySide: true, minimap: { enabled: false }, scrollBeyondLastLine: false, fontSize: 12, automaticLayout: true }}
        />
      </div>
    </div>
  );
}
