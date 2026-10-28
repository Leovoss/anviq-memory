import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryEngine } from "./engine.js";
import type { Namespace } from "./types.js";

let db: PGlite;
let engine: ReturnType<typeof createMemoryEngine>;

const bot = (id: string): Namespace => ({ kind: "bot", id });
const space = (id: string): Namespace => ({ kind: "space", id });
const org = (id: string): Namespace => ({ kind: "org", id });
const history = (id: string, generation: number): Namespace => ({
  kind: "history",
  id,
  generation,
});

async function recallContents(namespaces: Namespace[], query: string) {
  return (await engine.recall({ namespaces, query, limit: 10 })).map((m) => m.content);
}

beforeEach(() => {
  db = new PGlite();
  engine = createMemoryEngine((sql, params) => db.query(sql, params as unknown[]));
});

afterEach(async () => {
  await db.close();
});

describe("schema", () => {
  it("migrates idempotently", async () => {
    await engine.ensureSchema();
    await createMemoryEngine((sql, params) => db.query(sql, params as unknown[])).ensureSchema();
    const { rows } = await db.query("SELECT count(*)::int AS n FROM anviq_memory.migrations");
    expect(rows[0]).toEqual({ n: 3 });
  });
});

describe("recall", () => {
  it("only returns memories from the requested namespaces", async () => {
    await engine.save({ namespace: bot("b1"), spaceId: "s1", content: "Bot one likes espresso" });
    await engine.save({ namespace: bot("b2"), spaceId: "s1", content: "Bot two likes espresso" });
    await engine.save({ namespace: space("s1"), spaceId: "s1", content: "Team drinks espresso" });
    await engine.save({ namespace: space("s2"), spaceId: "s2", content: "Other team espresso" });
    await engine.save({ namespace: org("o1"), content: "Company espresso policy" });

    expect(await recallContents([bot("b1")], "espresso")).toEqual(["Bot one likes espresso"]);
    expect((await recallContents([bot("b1"), space("s1")], "espresso")).sort()).toEqual([
      "Bot one likes espresso",
      "Team drinks espresso",
    ]);
    expect(await recallContents([org("o1")], "espresso")).toEqual(["Company espresso policy"]);
  });

  it("returns nothing without namespaces or search terms", async () => {
    await engine.save({ namespace: bot("b1"), spaceId: "s1", content: "anything here" });
    expect(await recallContents([], "anything")).toEqual([]);
    expect(await recallContents([bot("b1")], "!!! ??")).toEqual([]);
  });

  it("matches a long natural-language prompt on any term", async () => {
    await engine.save({
      namespace: bot("b1"),
      spaceId: "s1",
      content: "Invoices are due on Friday",
    });
    const found = await recallContents(
      [bot("b1")],
      "Hey, could you remind me when the invoices are due this month?",
    );
    expect(found).toEqual(["Invoices are due on Friday"]);
  });

  it("handles non-English text and ranks closer matches first", async () => {
    await engine.save({
      namespace: bot("b1"),
      spaceId: "s1",
      content: "Der Kunde wünscht Rechnungen auf Deutsch",
    });
    await engine.save({
      namespace: bot("b1"),
      spaceId: "s1",
      content: "Rechnungen Kunde Deutsch Frist Freitag",
    });
    const found = await engine.recall({
      namespaces: [bot("b1")],
      query: "Kunde Rechnungen Deutsch Frist",
      limit: 5,
    });
    expect(found[0]?.content).toBe("Rechnungen Kunde Deutsch Frist Freitag");
    expect(found.every((m) => m.score > 0 && m.score < 1)).toBe(true);
  });

  it("treats query text as data", async () => {
    await engine.save({ namespace: bot("b1"), spaceId: "s1", content: "plain note" });
    expect(await recallContents([bot("b1")], "note'); DROP TABLE x; -- | & !")).toEqual([
      "plain note",
    ]);
  });

  it("scopes history to its generation", async () => {
    await engine.save({
      namespace: history("b1", 1),
      spaceId: "s1",
      content: "old turn about tax",
    });
    await engine.save({
      namespace: history("b1", 2),
      spaceId: "s1",
      content: "new turn about tax",
    });
    expect(await recallContents([history("b1", 2)], "tax")).toEqual(["new turn about tax"]);
  });
});

describe("save", () => {
  it("deduplicates identical content in a namespace", async () => {
    const first = await engine.save({ namespace: bot("b1"), spaceId: "s1", content: "same fact" });
    const second = await engine.save({
      namespace: bot("b1"),
      spaceId: "s1",
      content: " same fact ",
    });
    expect(second.id).toBe(first.id);
    const other = await engine.save({ namespace: bot("b2"), spaceId: "s1", content: "same fact" });
    expect(other.id).not.toBe(first.id);
  });

  it("validates input", async () => {
    await expect(
      engine.save({ namespace: bot("b1"), spaceId: "s1", content: "  " }),
    ).rejects.toThrow("content is required");
    await expect(engine.save({ namespace: bot("b1"), content: "x fact" })).rejects.toThrow(
      "spaceId is required",
    );
    await expect(
      engine.save({ namespace: org("o1"), content: "x".repeat(16_001) }),
    ).rejects.toThrow("too long");
  });
});

describe("forget and purge", () => {
  it("forgets only inside the allowed namespaces", async () => {
    const { id } = await engine.save({
      namespace: bot("b1"),
      spaceId: "s1",
      content: "secret plan",
    });
    expect(await engine.forget({ id, namespaces: [bot("b2")] })).toBe(false);
    expect(await recallContents([bot("b1")], "secret")).toEqual(["secret plan"]);
    expect(await engine.forget({ id, namespaces: [bot("b1")] })).toBe(true);
    expect(await recallContents([bot("b1")], "secret")).toEqual([]);
  });

  it("purges history generations", async () => {
    await engine.save({ namespace: history("b1", 1), spaceId: "s1", content: "gen one note" });
    await engine.save({ namespace: history("b1", 2), spaceId: "s1", content: "gen two note" });
    expect(await engine.purgeHistory("b1", [1])).toBe(1);
    expect(await recallContents([history("b1", 1), history("b1", 2)], "note")).toEqual([
      "gen two note",
    ]);
    expect(await engine.purgeHistory("b1", [])).toBe(0);
  });

  it("purges a bot with its history but keeps space and org memory", async () => {
    await engine.save({ namespace: bot("b1"), spaceId: "s1", content: "bot fact" });
    await engine.save({ namespace: history("b1", 1), spaceId: "s1", content: "bot history fact" });
    await engine.save({ namespace: space("s1"), spaceId: "s1", content: "space fact" });
    await engine.save({ namespace: org("o1"), content: "org fact" });
    expect(await engine.purgeBot("b1")).toBe(2);
    const all = [bot("b1"), history("b1", 1), space("s1"), org("o1")];
    expect((await recallContents(all, "fact")).sort()).toEqual(["org fact", "space fact"]);
  });

  it("purges a space and its bots but keeps org memory", async () => {
    await engine.save({ namespace: bot("b1"), spaceId: "s1", content: "bot fact" });
    await engine.save({ namespace: space("s1"), spaceId: "s1", content: "space fact" });
    await engine.save({ namespace: bot("b9"), spaceId: "s2", content: "other fact" });
    await engine.save({ namespace: org("o1"), content: "org fact" });
    expect(await engine.purgeSpace("s1")).toBe(2);
    const all = [bot("b1"), space("s1"), bot("b9"), org("o1")];
    expect((await recallContents(all, "fact")).sort()).toEqual(["org fact", "other fact"]);
  });

  it("purges an org", async () => {
    await engine.save({ namespace: org("o1"), content: "org fact" });
    expect(await engine.purgeOrg("o1")).toBe(1);
    expect(await recallContents([org("o1")], "fact")).toEqual([]);
  });
});
