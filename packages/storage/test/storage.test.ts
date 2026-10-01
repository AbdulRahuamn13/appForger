import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyAll, getText, LocalBlobStore, MemoryBlobStore, parseSkillMarkdown, S3BlobStore, SkillLibrary, skillsPrompt, type BlobStore } from "../src/index.ts";

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "appforge-storage-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function exercise(store: BlobStore) {
  await store.put("projects/p1/logs/a.txt", "hello");
  await store.put("projects/p1/logs/b.txt", Buffer.from("world"));
  await store.put("skills/x/SKILL.md", "---\nname: X\n---\nbody");
  expect(await getText(store, "projects/p1/logs/a.txt")).toBe("hello");
  expect(await store.get("missing.txt")).toBeUndefined();
  expect((await store.list("projects/p1/")).map((b) => b.key)).toEqual(["projects/p1/logs/a.txt", "projects/p1/logs/b.txt"]);
  expect((await store.list(""))).toHaveLength(3);
  await store.delete("projects/p1/logs/a.txt");
  expect((await store.list("projects/")).map((b) => b.key)).toEqual(["projects/p1/logs/b.txt"]);
  await expect(store.put("../escape.txt", "x")).rejects.toThrow(/Invalid storage key/);
}

describe("blob stores", () => {
  it("local folder", async () => {
    await exercise(new LocalBlobStore(path.join(tmp, "store")));
  });

  it("copies everything when switching backends", async () => {
    const from = new MemoryBlobStore();
    await from.put("a/b.txt", "1");
    await from.put("c.txt", "2");
    const to = new LocalBlobStore(path.join(tmp, "dest"));
    expect(await copyAll(from, to)).toBe(2);
    expect(await getText(to, "a/b.txt")).toBe("1");
  });

  it("S3-compatible bucket (against a fake S3 server)", async () => {
    const objects = new Map<string, { body: Buffer; at: Date }>();
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      const [, bucket, ...rest] = url.pathname.split("/");
      const key = decodeURIComponent(rest.join("/"));
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        expect(bucket).toBe("forge");
        if (req.method === "PUT") {
          objects.set(key, { body: Buffer.concat(chunks), at: new Date() });
          res.writeHead(200, { ETag: '"x"' }).end();
        } else if (req.method === "GET" && url.searchParams.get("list-type") === "2") {
          const prefix = url.searchParams.get("prefix") ?? "";
          const items = [...objects].filter(([k]) => k.startsWith(prefix));
          const xml = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>forge</Name><Prefix>${prefix}</Prefix><KeyCount>${items.length}</KeyCount><IsTruncated>false</IsTruncated>${items
            .map(([k, v]) => `<Contents><Key>${k}</Key><Size>${v.body.length}</Size><LastModified>${v.at.toISOString()}</LastModified></Contents>`)
            .join("")}</ListBucketResult>`;
          res.writeHead(200, { "Content-Type": "application/xml" }).end(xml);
        } else if (req.method === "GET") {
          const obj = objects.get(key);
          if (!obj) res.writeHead(404, { "Content-Type": "application/xml" }).end("<Error><Code>NoSuchKey</Code><Message>missing</Message></Error>");
          else res.writeHead(200, { "Content-Length": String(obj.body.length) }).end(obj.body);
        } else if (req.method === "DELETE") {
          objects.delete(key);
          res.writeHead(204).end();
        } else res.writeHead(400).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      const store = new S3BlobStore(
        { endpoint: `http://127.0.0.1:${port}`, region: "auto", bucket: "forge", prefix: "appforge", forcePathStyle: true },
        { accessKeyId: "test", secretAccessKey: "test" },
      );
      expect(store.describe()).toContain("s3://forge/appforge/");
      await exercise(store);
      expect([...objects.keys()].every((k) => k.startsWith("appforge/"))).toBe(true);
    } finally {
      server.close();
    }
  });
});

describe("skills", () => {
  it("parses Claude-Code-style SKILL.md frontmatter", () => {
    const s = parseSkillMarkdown("---\nname: Pdf tools\ndescription: Work with PDFs\nroles: [coder, reviewer, nope]\ndefault: false\n---\n\n# PDFs\nUse pypdf.");
    expect(s).toEqual({ name: "Pdf tools", description: "Work with PDFs", roles: ["coder", "reviewer"], default: false, body: "# PDFs\nUse pypdf." });
    expect(parseSkillMarkdown("# Heading only\ntext").name).toBe("Heading only");
  });

  it("stores, overrides built-ins, imports folders and renders per role", async () => {
    const store = new MemoryBlobStore();
    const lib = new SkillLibrary(() => store);
    const builtIns = await lib.list();
    expect(builtIns.length).toBeGreaterThan(5);
    expect(builtIns.every((s) => s.builtIn)).toBe(true);

    const mine = await lib.save({ name: "Use Zod", description: "Validate with zod", roles: ["coder"], default: true, body: "Validate every request body with zod." });
    expect(mine.id).toBe("use-zod");
    const edited = await lib.save({ id: "clean-code", name: "Clean code (mine)", description: "", roles: [], default: true, body: "My rules" });
    expect(edited.builtIn).toBe(true);
    expect((await lib.get("clean-code"))?.body).toBe("My rules");

    // A folder of skills, like ~/.claude/skills
    const root = path.join(tmp, "skills");
    await mkdir(path.join(root, "pdf", "scripts"), { recursive: true });
    await writeFile(path.join(root, "pdf", "SKILL.md"), "---\nname: PDF\ndescription: PDFs\n---\nRun scripts/fill.py");
    await writeFile(path.join(root, "pdf", "scripts", "fill.py"), "print('hi')");
    await mkdir(path.join(root, "notes"));
    await writeFile(path.join(root, "notes", "skill.md"), "# Notes\nKeep notes.");
    const imported = await lib.importFromPath(root);
    expect(imported.map((s) => s.id).sort()).toEqual(["notes", "pdf"]);
    expect((await lib.get("pdf"))?.files).toEqual(["scripts/fill.py"]);
    expect((await lib.readFile("pdf", "scripts/fill.py"))?.toString()).toBe("print('hi')");

    const enabled = await lib.enabledFor(["use-zod", "pdf"]);
    expect(skillsPrompt(enabled, "coder")).toContain("Validate every request body with zod.");
    expect(skillsPrompt(enabled, "reviewer")).not.toContain("zod");
    expect((await lib.enabledFor(undefined)).some((s) => s.id === "minimal-ui")).toBe(false);

    await lib.delete("use-zod");
    expect(await lib.get("use-zod")).toBeUndefined();
  });
});
