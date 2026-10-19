import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryEngine } from "./engine.js";

let db: PGlite;
let engine: ReturnType<typeof createMemoryEngine>;
let dir: string;

const bot = { kind: "bot", id: "b1" } as const;

async function noteFiles(sub = "bot/b1") {
  const entries = await readdir(path.join(dir, sub)).catch(() => []);
  return entries.filter((name) => name.endsWith(".md")).sort();
}

async function sync(mode: "export" | "two-way" = "two-way") {
  return engine.syncFolder({
    dir,
    mode,
    resolveSpaceId: async (id) => (id === "b2" ? "s1" : undefined),
  });
}

async function recall(query: string) {
  return (await engine.recall({ namespaces: [bot], query, limit: 10 })).map((m) => m.content);
}

beforeEach(async () => {
  db = new PGlite();
  engine = createMemoryEngine((sql, params) => db.query(sql, params as unknown[]));
  dir = await mkdtemp(path.join(tmpdir(), "anviq-mirror-"));
});

afterEach(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("export", () => {
  it("writes one note per memory and is stable on the next pass", async () => {
    const { id } = await engine.save({
      namespace: bot,
      spaceId: "s1",
      content: "Invoices are due on Friday",
    });
    await engine.save({
      namespace: { kind: "space", id: "s1" },
      spaceId: "s1",
      content: "Team policy",
    });
    await engine.save({ namespace: { kind: "org", id: "o1" }, content: "Company rule" });
    await engine.save({
      namespace: { kind: "history", id: "b1", generation: 1 },
      spaceId: "s1",
      content: "history stays out",
    });

    expect(await sync()).toMatchObject({ exported: 3, imported: 0, deleted: 0 });
    const [name] = await noteFiles();
    expect(name).toBe(`invoices-are-due-on-friday-${id.slice(0, 8)}.md`);
    expect(await readFile(path.join(dir, "bot/b1", name!), "utf8")).toBe(
      `---\nid: ${id}\n---\n\nInvoices are due on Friday\n`,
    );
    expect(await noteFiles("space/s1")).toHaveLength(1);
    expect(await noteFiles("org/o1")).toHaveLength(1);
    expect(await readdir(dir)).not.toContain("history");

    expect(await sync()).toEqual({ exported: 0, imported: 0, created: 0, deleted: 0, skipped: 0 });
  });

  it("removes a note when the memory is forgotten", async () => {
    const { id } = await engine.save({ namespace: bot, spaceId: "s1", content: "temporary fact" });
    await sync();
    await engine.forget({ id, namespaces: [bot] });
    expect((await sync()).deleted).toBe(1);
    expect(await noteFiles()).toEqual([]);
  });

  it("removes notes of a purged bot", async () => {
    await engine.save({ namespace: bot, spaceId: "s1", content: "to be purged" });
    await sync();
    await engine.purgeBot("b1");
    await sync();
    expect(await noteFiles()).toEqual([]);
  });

  it("overwrites edits and leaves new notes alone in export mode", async () => {
    await engine.save({ namespace: bot, spaceId: "s1", content: "original text" });
    await sync("export");
    const [name] = await noteFiles();
    const file = path.join(dir, "bot/b1", name!);
    const original = await readFile(file, "utf8");
    await writeFile(file, original.replace("original text", "edited text"));
    await writeFile(path.join(dir, "bot/b1", "mine.md"), "my own note");

    await sync("export");
    expect(await readFile(file, "utf8")).toBe(original);
    expect(await readFile(path.join(dir, "bot/b1", "mine.md"), "utf8")).toBe("my own note");
    expect(await recall("own")).toEqual([]);
  });
});

describe("two-way", () => {
  it("imports an edited note", async () => {
    await engine.save({ namespace: bot, spaceId: "s1", content: "original text" });
    await sync();
    const [name] = await noteFiles();
    const file = path.join(dir, "bot/b1", name!);
    await writeFile(file, (await readFile(file, "utf8")).replace("original text", "edited text"));
    const later = new Date(Date.now() + 5000);
    await utimes(file, later, later);

    expect(await sync()).toMatchObject({ imported: 1 });
    expect(await recall("edited")).toEqual(["edited text"]);
    expect(await recall("original")).toEqual([]);
    expect(await sync()).toEqual({ exported: 0, imported: 0, created: 0, deleted: 0, skipped: 0 });
  });

  it("creates a memory from a new note and writes its id back", async () => {
    await engine.save({ namespace: bot, spaceId: "s1", content: "seed" });
    await sync();
    await writeFile(path.join(dir, "bot/b1", "idea.md"), "Customers prefer invoices in German");

    expect(await sync()).toMatchObject({ created: 1 });
    expect(await recall("german")).toEqual(["Customers prefer invoices in German"]);
    expect(await readFile(path.join(dir, "bot/b1", "idea.md"), "utf8")).toMatch(
      /^---\nid: [\w-]+\n---/,
    );
    expect(await sync()).toMatchObject({ created: 0, imported: 0, deleted: 0 });
  });

  it("resolves the space of a bot that has no memories yet, or skips the note", async () => {
    await mkdir(path.join(dir, "bot/b2"), { recursive: true });
    await mkdir(path.join(dir, "bot/b9"), { recursive: true });
    await writeFile(path.join(dir, "bot/b2/a.md"), "known bot note");
    await writeFile(path.join(dir, "bot/b9/a.md"), "unknown bot note");
    expect(await sync()).toMatchObject({ created: 1, skipped: 1 });
  });

  it("deletes the memory when its note is deleted", async () => {
    await engine.save({ namespace: bot, spaceId: "s1", content: "keep this" });
    await engine.save({ namespace: bot, spaceId: "s1", content: "remove this" });
    await sync();
    for (const name of await noteFiles()) {
      const file = path.join(dir, "bot/b1", name);
      if ((await readFile(file, "utf8")).includes("remove this")) await rm(file);
    }
    expect((await sync()).deleted).toBe(1);
    expect(await recall("keep remove")).toEqual(["keep this"]);
  });

  it("does not delete anything when the folder looks wiped", async () => {
    await engine.save({ namespace: bot, spaceId: "s1", content: "precious fact" });
    await sync();
    await rm(path.join(dir, "bot"), { recursive: true });
    expect(await sync()).toMatchObject({ deleted: 0, skipped: 1 });
    expect(await recall("precious")).toEqual(["precious fact"]);
  });

  it("follows a renamed note and keeps extra properties", async () => {
    await engine.save({ namespace: bot, spaceId: "s1", content: "renamed fact" });
    await sync();
    const [name] = await noteFiles();
    const file = path.join(dir, "bot/b1", name!);
    const text = await readFile(file, "utf8");
    const renamed = path.join(dir, "bot/b1", "better-name.md");
    await writeFile(renamed, text.replace("---\n\n", "tags: work\n---\n\n"));
    await rm(file);
    expect(await sync()).toMatchObject({ deleted: 0, created: 0 });
    expect(await noteFiles()).toEqual(["better-name.md"]);
    expect(await recall("renamed")).toEqual(["renamed fact"]);
  });

  it("ignores hidden files, conflict copies and unknown folders", async () => {
    await engine.save({ namespace: bot, spaceId: "s1", content: "seed" });
    await sync();
    await writeFile(path.join(dir, "bot/b1", "x.sync-conflict-20260101-abc.md"), "conflict copy");
    await mkdir(path.join(dir, ".obsidian"), { recursive: true });
    await writeFile(path.join(dir, ".obsidian/app.md"), "settings");
    await writeFile(path.join(dir, "readme.md"), "not a memory");
    expect(await sync()).toEqual({ exported: 0, imported: 0, created: 0, deleted: 0, skipped: 0 });
  });
});
