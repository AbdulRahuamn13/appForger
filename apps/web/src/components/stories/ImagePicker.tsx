import { ImagePlus, X } from "lucide-react";
import { useRef, useState } from "react";
import { KnowledgeApi } from "@/lib/api.ts";
import { cn } from "@/lib/utils.ts";
import { Spinner } from "../ui/misc.tsx";
import { toast } from "../ui/toast.tsx";

/** Reference images: click, drop or paste (⌘V) screenshots and mockups. */
export function ImagePicker({ projectId, value, onChange, readOnly = false }: { projectId: string; value: string[]; onChange?: (ids: string[]) => void; readOnly?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);

  const upload = async (files: File[]) => {
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (!images.length || !onChange) return;
    setBusy(true);
    const ids = [...value];
    for (const file of images) {
      try {
        ids.push((await KnowledgeApi.uploadImage(projectId, file)).id);
      } catch (err) {
        toast((err as Error).message, "error");
      }
    }
    setBusy(false);
    onChange(ids);
  };

  if (readOnly && !value.length) return null;
  return (
    <div
      className="flex flex-wrap gap-2"
      onPaste={(e) => {
        if (readOnly) return;
        const files = [...e.clipboardData.files];
        if (files.length) {
          e.preventDefault();
          void upload(files);
        }
      }}
    >
      {value.map((id) => (
        <div key={id} className="group relative">
          <a href={KnowledgeApi.imageUrl(id)} target="_blank" rel="noreferrer">
            <img src={KnowledgeApi.imageUrl(id)} alt="Reference" className="size-20 rounded-md border object-cover" />
          </a>
          {!readOnly && (
            <button
              type="button"
              aria-label="Remove image"
              onClick={() => onChange?.(value.filter((v) => v !== id))}
              className="absolute -top-1.5 -right-1.5 hidden rounded-full border bg-card p-0.5 group-hover:block"
            >
              <X className="size-3" />
            </button>
          )}
        </div>
      ))}
      {!readOnly && (
        <button
          type="button"
          onClick={() => input.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            void upload([...e.dataTransfer.files]);
          }}
          className={cn(
            "flex size-20 flex-col items-center justify-center gap-1 rounded-md border border-dashed text-[11px] text-muted-foreground hover:bg-muted",
            over && "border-foreground bg-muted",
          )}
          title="Add reference images: click, drop, or paste"
        >
          {busy ? <Spinner /> : <ImagePlus className="size-4" />}
          {busy ? "Uploading" : "Add image"}
        </button>
      )}
      <input ref={input} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={(e) => void upload([...(e.target.files ?? [])])} />
    </div>
  );
}
