import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryEngine } from "./engine.js";
import type { MemorySealer, Namespace, Query } from "./types.js";

const word = (scope: string, term: string) =>
  createHmac("sha256", scope).update(term).digest().readInt32BE(0);
const termsOf = (text: string) => [
  ...new Set(text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []),
];

/** A reversible stand-in for the host's sealer: it binds a value to its row like the real one. */
function fakeSealer(enabled = true): MemorySealer {
  return {
    enabled,
    seal: async (row, text) =>
      `sealed:${row.scope}:${row.kind}:${row.owner}:${row.id}:${Buffer.from(text).toString("base64")}`,
    open: async (row, stored) => {
      if (!stored.startsWith("sealed:")) return stored;
      const [, scope, kind, owner, id, body] = stored.split(":");
      if (scope !== row.scope || kind !== row.kind || owner !== row.owner || id !== row.id)
        throw new Error("sealed value belongs to another row");
      return Buffer.from(body!, "base64").toString("utf8");
    },
    hash: async (scope, text) => createHmac("sha256", scope).update(`hash:${text}`).digest("hex"),
    tokens: async (scope, text) => termsOf(text).map((term) => word(scope, term)),
    queryTokens: async (scope, query) => termsOf(query).map((term) => [word(scope, term)]),
  };
}

let db: PGlite;
const run: Query = (sql, params) => db.query(sql, params as unknown[]);
const sealedEngine = (enabled = true) => createMemoryEngine(run, { sealer: fakeSealer(enabled) });

const bot = (id: string): Namespace => ({ kind: "bot", id });
const space = (id: string): Namespace => ({ kind: "space", id });
const org = (id: string): Namespace => ({ kind: "org", id });

beforeEach(() => {
  db = new PGlite();
});

afterEach(async () => {
  await db.close();
});

describe("sealed memory", () => {
  it("stores ciphertext and tokens, and recalls the plaintext", async () => {
    const engine = sealedEngine();
    await engine.save({ namespace: bot("b1"), spaceId: "s1", content: "Allergic to kiwi fruit" });

    const { rows } = await db.query<{ content: string; sealed: boolean; tokens: number[] }>(
      "SELECT content, sealed, search_tokens AS tokens FROM anviq_memory.memories",
    );
    expect(rows[0]!.sealed).toBe(true);
    expect(rows[0]!.content).not.toContain("kiwi");
    expect(rows[0]!.tokens.length).toBeGreaterThan(0);

    const found = await engine.recall({
      namespaces: [bot("b1")],
      spaceId: "s1",
      query: "kiwi",
      limit: 5,
    });
    expect(found.map((memory) => memory.content)).toEqual(["Allergic to kiwi fruit"]);
    expect(found[0]!.score).toBeGreaterThan(0);
  });

  it("keeps spaces apart even for the same words", async () => {
    const engine = sealedEngine();
    await engine.save({ namespace: space("s1"), spaceId: "s1", content: "Budget is wombat" });
    await engine.save({ namespace: space("s2"), spaceId: "s2", content: "Budget is wombat" });

    const first = await engine.recall({
      namespaces: [space("s1")],
      spaceId: "s1",
      query: "wombat budget",
      limit: 5,
    });
    expect(first).toHaveLength(1);
    expect(first[0]!.namespace).toEqual(space("s1"));
  });

  it("dedupes equal texts through the keyed hash", async () => {
    const engine = sealedEngine();
    const a = await engine.save({ namespace: bot("b1"), spaceId: "s1", content: "Same note" });
    const b = await engine.save({ namespace: bot("b1"), spaceId: "s1", content: "Same note" });
    expect(b.id).toBe(a.id);
  });

  it("ranks rows by how many query terms they hit", async () => {
    const engine = sealedEngine();
    await engine.save({ namespace: bot("b1"), spaceId: "s1", content: "kiwi smoothie recipe" });
    await engine.save({ namespace: bot("b1"), spaceId: "s1", content: "kiwi only" });

    const found = await engine.recall({
      namespaces: [bot("b1")],
      spaceId: "s1",
      query: "kiwi smoothie",
      limit: 5,
    });
    expect(found.map((memory) => memory.content)).toEqual(["kiwi smoothie recipe", "kiwi only"]);
  });

  it("recalls plaintext rows from before sealing next to sealed ones", async () => {
    await createMemoryEngine(run).save({
      namespace: bot("b1"),
      spaceId: "s1",
      content: "Old plaintext note about figs",
    });
    const engine = sealedEngine();
    await engine.save({
      namespace: bot("b1"),
      spaceId: "s1",
      content: "New sealed note about figs",
    });

    const found = await engine.recall({
      namespaces: [bot("b1")],
      spaceId: "s1",
      query: "figs",
      limit: 5,
    });
    expect(found.map((memory) => memory.content).sort()).toEqual([
      "New sealed note about figs",
      "Old plaintext note about figs",
    ]);
  });

  it("writes plaintext when sealing is off but still opens sealed rows", async () => {
    await sealedEngine().save({ namespace: bot("b1"), spaceId: "s1", content: "Sealed olives" });
    const engine = sealedEngine(false);
    await engine.save({ namespace: bot("b1"), spaceId: "s1", content: "Plain olives" });

    const { rows } = await db.query<{ sealed: boolean }>(
      "SELECT sealed FROM anviq_memory.memories ORDER BY sealed",
    );
    expect(rows.map((row) => row.sealed)).toEqual([false, true]);
    const found = await engine.recall({
      namespaces: [bot("b1")],
      spaceId: "s1",
      query: "olives",
      limit: 5,
    });
    expect(found.map((memory) => memory.content).sort()).toEqual(["Plain olives", "Sealed olives"]);
  });

  it("refuses a sealed value moved to another row", async () => {
    const engine = sealedEngine();
    await engine.save({ namespace: bot("b1"), spaceId: "s1", content: "First secret" });
    await engine.save({ namespace: bot("b1"), spaceId: "s1", content: "Second secret" });
    await db.query(
      `UPDATE anviq_memory.memories SET content = (
         SELECT content FROM anviq_memory.memories ORDER BY created_at, id LIMIT 1)
       WHERE content LIKE '%${Buffer.from("Second secret").toString("base64")}'`,
    );

    await expect(
      engine.recall({ namespaces: [bot("b1")], spaceId: "s1", query: "secret", limit: 5 }),
    ).rejects.toThrow("another row");
  });

  it("needs the space to recall bot memory when sealing is configured", async () => {
    const engine = sealedEngine();
    await engine.save({ namespace: bot("b1"), spaceId: "s1", content: "A note" });
    await expect(
      engine.recall({ namespaces: [bot("b1")], query: "note", limit: 5 }),
    ).rejects.toThrow("spaceId is required");
  });

  it("seals org memory under the organisation", async () => {
    const engine = sealedEngine();
    await engine.save({ namespace: org("o1"), content: "Company rule about invoices" });
    const found = await engine.recall({ namespaces: [org("o1")], query: "invoices", limit: 5 });
    expect(found.map((memory) => memory.content)).toEqual(["Company rule about invoices"]);
  });

  it("seals existing plaintext and can write it back", async () => {
    await createMemoryEngine(run).save({
      namespace: bot("b1"),
      spaceId: "s1",
      content: "Plain note about dates",
    });
    const engine = sealedEngine();

    expect(await engine.rewrite({ mode: "seal" })).toEqual({ scanned: 1, updated: 1 });
    const sealed = await db.query<{ content: string; sealed: boolean }>(
      "SELECT content, sealed FROM anviq_memory.memories",
    );
    expect(sealed.rows[0]!.sealed).toBe(true);
    expect(sealed.rows[0]!.content).not.toContain("dates");
    expect(await engine.rewrite({ mode: "seal" })).toEqual({ scanned: 0, updated: 0 });
    expect(
      (
        await engine.recall({ namespaces: [bot("b1")], spaceId: "s1", query: "dates", limit: 5 })
      ).map((memory) => memory.content),
    ).toEqual(["Plain note about dates"]);

    expect(await engine.rewrite({ mode: "unseal" })).toEqual({ scanned: 1, updated: 1 });
    const plain = await db.query<{ content: string; sealed: boolean }>(
      "SELECT content, sealed FROM anviq_memory.memories",
    );
    expect(plain.rows[0]).toEqual({ content: "Plain note about dates", sealed: false });
    expect(
      (
        await createMemoryEngine(run).recall({
          namespaces: [bot("b1")],
          query: "dates",
          limit: 5,
        })
      ).map((memory) => memory.content),
    ).toEqual(["Plain note about dates"]);
  });

  it("refuses to seal when sealing is off", async () => {
    await expect(sealedEngine(false).rewrite({ mode: "seal" })).rejects.toThrow("turned off");
  });
});

describe("sealed memory in the folder mirror", () => {
  let dir: string;
  const notes = async () =>
    (await readdir(path.join(dir, "bot", "b1")).catch(() => [])).filter((name) =>
      name.endsWith(".md"),
    );

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "anviq-sealed-mirror-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("exports readable notes from sealed rows and seals edits and new notes", async () => {
    const engine = sealedEngine();
    const { id } = await engine.save({
      namespace: bot("b1"),
      spaceId: "s1",
      content: "Invoices are due on Friday",
    });
    await engine.syncFolder({ dir, mode: "two-way" });

    const [name] = await notes();
    const file = path.join(dir, "bot", "b1", name!);
    expect(await readFile(file, "utf8")).toContain("Invoices are due on Friday");

    await writeFile(file, `---\nid: ${id}\n---\n\nInvoices are due on Monday\n`, "utf8");
    await mkdir(path.join(dir, "bot", "b1"), { recursive: true });
    await writeFile(path.join(dir, "bot", "b1", "new.md"), "A note written in a folder\n", "utf8");
    await engine.syncFolder({
      dir,
      mode: "two-way",
      resolveSpaceId: async () => "s1",
    });

    const { rows } = await db.query<{ content: string; sealed: boolean }>(
      "SELECT content, sealed FROM anviq_memory.memories ORDER BY created_at, id",
    );
    expect(rows.every((row) => row.sealed)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("Monday");
    expect(JSON.stringify(rows)).not.toContain("written in a folder");
    const found = await engine.recall({
      namespaces: [bot("b1")],
      spaceId: "s1",
      query: "monday folder",
      limit: 5,
    });
    expect(found.map((memory) => memory.content).sort()).toEqual([
      "A note written in a folder",
      "Invoices are due on Monday",
    ]);
  });
});
