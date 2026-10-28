import { randomUUID } from "node:crypto";
import { hashContent, MAX_CONTENT_LENGTH } from "./content.js";
import { MIGRATIONS, SCHEMA } from "./migrations.js";
import { createMirror } from "./mirror.js";
import type {
  ForgetRequest,
  Memory,
  MemorySealer,
  Namespace,
  Query,
  RecalledMemory,
  RecallRequest,
  SaveRequest,
  SealedRowRef,
} from "./types.js";

const MAX_QUERY_TERMS = 32;
const MAX_LIMIT = 50;
/** Sealed rows are ranked here, so this many of the newest candidates are read per scope. */
const SEALED_CANDIDATES = 200;
const TABLE = `${SCHEMA}.memories`;

interface Row extends Record<string, unknown> {
  id: string;
  kind: Namespace["kind"];
  owner_id: string;
  generation: number | null;
  space_id: string | null;
  content: string;
  content_hash?: string;
  sealed: boolean;
  origin: "bot" | "file";
  updated_at: Date | string;
  rank?: number | string;
  search_tokens?: number[] | null;
}

function namespaceOf(row: Row): Namespace {
  return row.kind === "history"
    ? { kind: "history", id: row.owner_id, generation: Number(row.generation) }
    : { kind: row.kind, id: row.owner_id };
}

function toMemory(row: Row, content: string): Memory {
  return {
    id: row.id,
    namespace: namespaceOf(row),
    content,
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

/** The space of a space, bot or history row, or the organisation of an org row. */
function scopeOf(kind: Namespace["kind"], ownerId: string, spaceId: string | null | undefined) {
  return kind === "org" ? ownerId : (spaceId ?? undefined);
}

export function createMemoryEngine(query: Query, options: { sealer?: MemorySealer } = {}) {
  const sealer = options.sealer;
  let ready: Promise<void> | undefined;

  async function migrate(): Promise<void> {
    // A schema the owner role already migrated needs no DDL, so a runtime login without CREATE works.
    const present = await query(`SELECT to_regclass('${SCHEMA}.migrations')::text AS found`);
    if (present.rows[0]?.found) {
      const done = await query(`SELECT version FROM ${SCHEMA}.migrations`);
      if (done.rows.length >= MIGRATIONS.length) return;
    }
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

  function refOf(row: Row): SealedRowRef {
    const scope = scopeOf(row.kind, row.owner_id, row.space_id);
    if (!scope) throw new Error("A sealed memory has no scope");
    return { id: row.id, kind: row.kind, scope, owner: row.owner_id };
  }

  async function contentOf(row: Row): Promise<string> {
    if (!row.sealed) return row.content;
    if (!sealer) throw new Error("This memory is sealed and no sealer is configured");
    return sealer.open(refOf(row), row.content);
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
    const id = randomUUID();
    let stored = content;
    let hash = hashContent(content);
    let tokens: number[] | null = null;
    const scope = scopeOf(namespace.kind, namespace.id, request.spaceId);
    if (sealer?.enabled && scope) {
      const ref: SealedRowRef = { id, kind: namespace.kind, scope, owner: namespace.id };
      [stored, hash, tokens] = await Promise.all([
        sealer.seal(ref, content),
        sealer.hash(scope, content),
        sealer.tokens(scope, content),
      ]);
    }
    const { rows } = await query(
      `INSERT INTO ${TABLE}
         (id, kind, owner_id, generation, space_id, bot_id, content, content_hash, origin,
          sealed, search_tokens)
       VALUES ($1, $2, $3, $4::integer, $5, $6, $7, $8, $9, $10, $11::integer[])
       ON CONFLICT (kind, owner_id, COALESCE(generation, -1), content_hash)
       DO UPDATE SET updated_at = now()
       RETURNING id`,
      [
        id,
        namespace.kind,
        namespace.id,
        namespace.kind === "history" ? namespace.generation : null,
        namespace.kind === "org" ? null : (request.spaceId ?? null),
        botId,
        stored,
        hash,
        request.origin ?? "bot",
        tokens !== null,
        tokens,
      ],
    );
    return { id: String(rows[0]!.id) };
  }

  async function recallPlain(
    terms: string[],
    namespaces: Namespace[],
    limit: number,
  ): Promise<RecalledMemory[]> {
    const params: unknown[] = [terms.join(" | ")];
    const filter = namespaceFilter(namespaces, params);
    params.push(limit);
    const { rows } = await query(
      `SELECT id, kind, owner_id, generation, space_id, content, sealed, origin, updated_at,
              ts_rank(search, q) AS rank
       FROM ${TABLE}, to_tsquery('simple', $1) q
       WHERE NOT sealed AND search @@ q AND ${filter}
       ORDER BY rank DESC, updated_at DESC
       LIMIT $${params.length}`,
      params,
    );
    return (rows as Row[]).map((row) => {
      const rank = Number(row.rank);
      return { ...toMemory(row, row.content), score: rank / (rank + 0.1) };
    });
  }

  /** Sealed rows are matched on blind-index tokens and ranked by how many query terms they hit. */
  async function recallSealed(request: RecallRequest): Promise<Array<{ row: Row; score: number }>> {
    if (!sealer) return [];
    const byScope = new Map<string, Namespace[]>();
    for (const namespace of request.namespaces) {
      const scope = scopeOf(namespace.kind, namespace.id, request.spaceId);
      if (!scope) throw new Error("spaceId is required to recall sealed memory");
      byScope.set(scope, [...(byScope.get(scope) ?? []), namespace]);
    }
    const hits: Array<{ row: Row; score: number }> = [];
    for (const [scope, namespaces] of byScope) {
      const perTerm = await sealer.queryTokens(scope, request.query);
      const all = [...new Set(perTerm.flat())];
      if (all.length === 0) continue;
      const params: unknown[] = [all];
      const filter = namespaceFilter(namespaces, params);
      params.push(SEALED_CANDIDATES);
      const { rows } = await query(
        `SELECT id, kind, owner_id, generation, space_id, content, sealed, origin, updated_at,
                search_tokens
         FROM ${TABLE}
         WHERE sealed AND search_tokens && $1::integer[] AND ${filter}
         ORDER BY updated_at DESC
         LIMIT $${params.length}`,
        params,
      );
      for (const row of rows as Row[]) {
        const present = new Set(row.search_tokens ?? []);
        const matched = perTerm.filter((tokens) => tokens.some((token) => present.has(token)));
        const share = matched.length / Math.max(perTerm.length, 1);
        hits.push({ row, score: share / (share + 0.1) });
      }
    }
    return hits;
  }

  async function recall(request: RecallRequest): Promise<RecalledMemory[]> {
    const terms = searchTerms(request.query);
    if (terms.length === 0 || request.namespaces.length === 0) return [];
    await ensureSchema();
    const limit = Math.min(Math.max(Math.trunc(request.limit), 1), MAX_LIMIT);
    const [plain, sealed] = await Promise.all([
      recallPlain(terms, request.namespaces, limit),
      recallSealed(request),
    ]);
    const ranked = [
      ...plain.map((memory) => ({ score: memory.score, updatedAt: memory.updatedAt, memory })),
      ...sealed.map(({ row, score }) => ({
        score,
        updatedAt: new Date(row.updated_at).toISOString(),
        row,
      })),
    ]
      .sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
    return Promise.all(
      ranked.map(async (entry) =>
        "memory" in entry
          ? entry.memory
          : { ...toMemory(entry.row, await contentOf(entry.row)), score: entry.score },
      ),
    );
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

  /**
   * Seals plaintext memories, or writes sealed ones back as plaintext for a rollback. Safe to
   * interrupt and rerun: finished rows are skipped, and a row edited meanwhile is left for the
   * next pass.
   */
  async function rewrite(options: {
    mode: "seal" | "unseal";
    batchSize?: number;
  }): Promise<{ scanned: number; updated: number }> {
    if (!sealer) throw new Error("A sealer is required to rewrite memories");
    if (options.mode === "seal" && !sealer.enabled)
      throw new Error("Sealing is turned off for this deployment");
    await ensureSchema();
    const batch = options.batchSize ?? 200;
    const toSeal = options.mode === "seal";
    const progress = { scanned: 0, updated: 0 };
    let cursor = "";
    while (true) {
      const { rows } = await query(
        `SELECT id, kind, owner_id, generation, space_id, content, sealed, origin, updated_at
         FROM ${TABLE} WHERE id > $1 AND sealed = $2 ORDER BY id LIMIT $3`,
        [cursor, !toSeal, batch],
      );
      if (rows.length === 0) break;
      for (const row of rows as Row[]) {
        cursor = row.id;
        progress.scanned += 1;
        const scope = scopeOf(row.kind, row.owner_id, row.space_id);
        if (!scope) continue;
        const plaintext = toSeal ? row.content : await contentOf(row);
        const ref: SealedRowRef = { id: row.id, kind: row.kind, scope, owner: row.owner_id };
        const [stored, hash, tokens] = toSeal
          ? await Promise.all([
              sealer.seal(ref, plaintext),
              sealer.hash(scope, plaintext),
              sealer.tokens(scope, plaintext),
            ])
          : [plaintext, hashContent(plaintext), null];
        const { rows: updated } = await query(
          `UPDATE ${TABLE}
           SET content = $2, content_hash = $3, sealed = $4, search_tokens = $5::integer[]
           WHERE id = $1 AND content = $6 AND sealed = $7
           RETURNING id`,
          [row.id, stored, hash, toSeal, tokens, row.content, !toSeal],
        );
        progress.updated += updated.length;
      }
      if (rows.length < batch) break;
    }
    return progress;
  }

  return {
    ensureSchema,
    syncFolder: createMirror(query, ensureSchema, sealer),
    save,
    recall,
    forget,
    rewrite,
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
