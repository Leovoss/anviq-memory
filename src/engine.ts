import { createHash, randomUUID } from "node:crypto";
import { MIGRATIONS, SCHEMA } from "./migrations.js";
import type {
  ForgetRequest,
  Memory,
  Namespace,
  Query,
  RecalledMemory,
  RecallRequest,
  SaveRequest,
} from "./types.js";

const MAX_CONTENT_LENGTH = 16_000;
const MAX_QUERY_TERMS = 32;
const MAX_LIMIT = 50;
const TABLE = `${SCHEMA}.memories`;

interface Row extends Record<string, unknown> {
  id: string;
  kind: Namespace["kind"];
  owner_id: string;
  generation: number | null;
  content: string;
  origin: "bot" | "file";
  updated_at: Date | string;
  rank?: number | string;
}

function namespaceOf(row: Row): Namespace {
  return row.kind === "history"
    ? { kind: "history", id: row.owner_id, generation: Number(row.generation) }
    : { kind: row.kind, id: row.owner_id };
}

function toMemory(row: Row): Memory {
  return {
    id: row.id,
    namespace: namespaceOf(row),
    content: row.content,
    origin: row.origin,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function namespaceFilter(namespaces: Namespace[], params: unknown[]): string {
  const clauses = namespaces.map((ns) => {
    params.push(ns.kind, ns.id);
    const kind = `$${params.length - 1}`;
    const owner = `$${params.length}`;
    if (ns.kind !== "history") return `(kind = ${kind} AND owner_id = ${owner})`;
    params.push(ns.generation);
    return `(kind = ${kind} AND owner_id = ${owner} AND generation = $${params.length}::integer)`;
  });
  return `(${clauses.join(" OR ")})`;
}

function searchTerms(query: string): string[] {
  const words = query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  return [...new Set(words)].slice(0, MAX_QUERY_TERMS);
}

export function createMemoryEngine(query: Query) {
  let ready: Promise<void> | undefined;

  async function migrate(): Promise<void> {
    await query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    await query(
      `CREATE TABLE IF NOT EXISTS ${SCHEMA}.migrations (
        version integer PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`,
    );
    const applied = new Set(
      (await query(`SELECT version FROM ${SCHEMA}.migrations`)).rows.map((row) =>
        Number(row.version),
      ),
    );
    for (const [index, statements] of MIGRATIONS.entries()) {
      const version = index + 1;
      if (applied.has(version)) continue;
      for (const statement of statements) await query(statement);
      await query(`INSERT INTO ${SCHEMA}.migrations (version) VALUES ($1) ON CONFLICT DO NOTHING`, [
        version,
      ]);
    }
  }

  function ensureSchema(): Promise<void> {
    ready ??= migrate().catch((error) => {
      ready = undefined;
      throw error;
    });
    return ready;
  }

  async function save(request: SaveRequest): Promise<{ id: string }> {
    const content = request.content.trim();
    if (!content) throw new Error("content is required");
    if (content.length > MAX_CONTENT_LENGTH) throw new Error("content is too long");
    const { namespace } = request;
    if (!namespace.id) throw new Error("namespace id is required");
    if (namespace.kind !== "org" && !request.spaceId) throw new Error("spaceId is required");
    const botId = namespace.kind === "bot" || namespace.kind === "history" ? namespace.id : null;
    await ensureSchema();
    const hash = createHash("sha256").update(content).digest("hex");
    const { rows } = await query(
      `INSERT INTO ${TABLE}
         (id, kind, owner_id, generation, space_id, bot_id, content, content_hash, origin)
       VALUES ($1, $2, $3, $4::integer, $5, $6, $7, $8, $9)
       ON CONFLICT (kind, owner_id, COALESCE(generation, -1), content_hash)
       DO UPDATE SET updated_at = now()
       RETURNING id`,
      [
        randomUUID(),
        namespace.kind,
        namespace.id,
        namespace.kind === "history" ? namespace.generation : null,
        namespace.kind === "org" ? null : (request.spaceId ?? null),
        botId,
        content,
        hash,
        request.origin ?? "bot",
      ],
    );
    return { id: String(rows[0]!.id) };
  }

  async function recall(request: RecallRequest): Promise<RecalledMemory[]> {
    const terms = searchTerms(request.query);
    if (terms.length === 0 || request.namespaces.length === 0) return [];
    await ensureSchema();
    const limit = Math.min(Math.max(Math.trunc(request.limit), 1), MAX_LIMIT);
    const params: unknown[] = [terms.join(" | ")];
    const filter = namespaceFilter(request.namespaces, params);
    params.push(limit);
    const { rows } = await query(
      `SELECT id, kind, owner_id, generation, content, origin, updated_at,
              ts_rank(search, q) AS rank
       FROM ${TABLE}, to_tsquery('simple', $1) q
       WHERE search @@ q AND ${filter}
       ORDER BY rank DESC, updated_at DESC
       LIMIT $${params.length}`,
      params,
    );
    return (rows as Row[]).map((row) => {
      const rank = Number(row.rank);
      return { ...toMemory(row), score: rank / (rank + 0.1) };
    });
  }

  async function forget(request: ForgetRequest): Promise<boolean> {
    if (request.namespaces.length === 0) return false;
    await ensureSchema();
    const params: unknown[] = [request.id];
    const filter = namespaceFilter(request.namespaces, params);
    const { rows } = await query(
      `DELETE FROM ${TABLE} WHERE id = $1 AND ${filter} RETURNING id`,
      params,
    );
    return rows.length > 0;
  }

  async function remove(where: string, params: unknown[]): Promise<number> {
    await ensureSchema();
    const { rows } = await query(`DELETE FROM ${TABLE} WHERE ${where} RETURNING id`, params);
    return rows.length;
  }

  return {
    ensureSchema,
    save,
    recall,
    forget,
    purgeHistory: (botId: string, generations: number[]) =>
      generations.length === 0
        ? Promise.resolve(0)
        : remove("kind = 'history' AND owner_id = $1 AND generation = ANY($2::integer[])", [
            botId,
            generations,
          ]),
    purgeBot: (botId: string) => remove("bot_id = $1", [botId]),
    purgeSpace: (spaceId: string) => remove("space_id = $1", [spaceId]),
    purgeOrg: (orgId: string) => remove("kind = 'org' AND owner_id = $1", [orgId]),
  };
}

export type MemoryEngine = ReturnType<typeof createMemoryEngine>;
