import { ChevronUp, Folder, FolderGit2, FolderOpen, FolderPlus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Api, type DirListing } from "@/lib/api.ts";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";
import { ErrorNote } from "./ui/misc.tsx";

/** Server-side folder browser: browsers can't give us real paths, so the server lists them. */
export function FolderPicker({ value, onChange }: { value: string; onChange: (path: string) => void }) {
  const [listing, setListing] = useState<DirListing>();
  const [error, setError] = useState<string>();
  const [typed, setTyped] = useState(value);
  const [newName, setNewName] = useState("");

  const open = useCallback(
    async (path?: string) => {
      try {
        const l = await Api.listDir(path);
        setListing(l);
        setTyped(l.path);
        onChange(l.path);
        setError(undefined);
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [onChange],
  );

  useEffect(() => {
    void open(value || undefined);
  }, []);

  const create = async () => {
    if (!listing || !newName.trim()) return;
    try {
      const { path } = await Api.mkdir(listing.path, newName.trim());
      setNewName("");
      await open(path);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="space-y-2">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void open(typed);
        }}
      >
        <Input value={typed} onChange={(e) => setTyped(e.target.value)} className="font-mono text-xs" aria-label="Folder path" />
        <Button type="submit" variant="outline" size="sm" className="h-9">
          Go
        </Button>
        {window.appforge?.pickFolder && (
          <Button
            variant="outline"
            size="sm"
            className="h-9"
            onClick={() => void window.appforge?.pickFolder().then((picked) => (picked ? open(picked) : undefined))}
          >
            <FolderOpen /> Choose…
          </Button>
        )}
      </form>
      {listing && (
        <div className="flex flex-wrap gap-1">
          {listing.shortcuts.map((s) => (
            <Button key={s.path} variant="ghost" size="sm" onClick={() => void open(s.path)}>
              {s.label}
            </Button>
          ))}
        </div>
      )}
      <div className="h-56 overflow-y-auto rounded-md border bg-muted/40 text-sm">
        {listing?.parent && (
          <button type="button" className="flex w-full items-center gap-2 px-3 py-1.5 hover:bg-muted" onClick={() => void open(listing.parent)}>
            <ChevronUp className="size-4 text-muted-foreground" /> ..
          </button>
        )}
        {listing?.entries.map((entry) => (
          <button
            type="button"
            key={entry.path}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-muted"
            onClick={() => void open(entry.path)}
          >
            {entry.isGitRepo ? <FolderGit2 className="size-4 text-primary" /> : <Folder className="size-4 text-muted-foreground" />}
            <span className="truncate">{entry.name}</span>
          </button>
        ))}
        {listing && listing.entries.length === 0 && <p className="px-3 py-2 text-muted-foreground">No sub-folders</p>}
      </div>
      <div className="flex gap-2">
        <Input placeholder="New folder name" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <Button variant="outline" onClick={() => void create()} disabled={!newName.trim()}>
          <FolderPlus /> Create here
        </Button>
      </div>
      <ErrorNote error={error} />
    </div>
  );
}
