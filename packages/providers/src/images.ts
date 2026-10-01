import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

const TYPES: Record<string, ImageMediaType> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
/** Vision APIs reject very large images. */
const MAX_BYTES = 5 * 1024 * 1024;

export function imageMediaType(file: string): ImageMediaType | undefined {
  return TYPES[path.extname(file).toLowerCase()];
}

export interface LoadedImage {
  path: string;
  mediaType: ImageMediaType;
  base64: string;
}

/** Read reference images for vision-capable APIs, skipping unsupported or oversized files. */
export async function loadImages(paths: string[] = []): Promise<LoadedImage[]> {
  const out: LoadedImage[] = [];
  for (const p of paths) {
    const mediaType = imageMediaType(p);
    if (!mediaType) continue;
    const st = await stat(p).catch(() => undefined);
    if (!st?.isFile() || st.size > MAX_BYTES) continue;
    out.push({ path: p, mediaType, base64: (await readFile(p)).toString("base64") });
  }
  return out;
}

/** For CLI agents that open files themselves: tell them where the references are. */
export function imageHint(paths: string[] = [], cwd: string): string {
  const usable = paths.filter((p) => imageMediaType(p));
  if (!usable.length) return "";
  return `\n\n## Reference images\nOpen and study these images before you start (use your file-reading tool; they are design references):\n${usable
    .map((p) => `- ${path.relative(cwd, p) || p}`)
    .join("\n")}`;
}
