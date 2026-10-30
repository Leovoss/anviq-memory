import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { hashContent, MAX_CONTENT_LENGTH } from "./content.js";
import { SCHEMA } from "./migrations.js";
import type { MemorySealer, Query } from "./types.js";

export type MirrorMode = "export" | "two-way";

export interface MirrorOptions {
  dir: string;
  mode: MirrorMode;
  /** Finds the space of a bot that has no memories yet, for notes created in its folder. */
  resolveSpaceId?: (botId: string) => Promise<string | undefined>;
}

export interface MirrorResult {
  exported: number;
  imported: number;
  created: number;
  deleted: number;
  skipped: number;
}

type Kind = "org" | "space" | "bot";

const KINDS: readonly Kind[] = ["org", "space", "bot"];
const TABLE = `${SCHEMA}.memories`;
const MIN_DELETIONS_TO_GUARD = 3;

interface Row extends Record<string, unknown> {
  id: string;
  kind: Kind;
  owner_id: string;
  space_id: string | null;
  content: string;
  content_hash: string;
  sealed: boolean;
  updated_at: Date | string;
  file_path: string | null;
  synced_hash: string | null;
}

interface MirrorFile {
  rel: string;
  kind: Kind;
  ownerId: string;
  id?: string;
  body: string;
  mtime: number;
  extra: string[];
}

function parseNote(text: string): { id?: string; body: string; extra: string[] } {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  const front = match ? match[1]!.split(/\r?\n/) : [];
  const body = (match ? text.slice(match[0].length) : text).trim();
  const idLine = front.find((line) => /^id:\s*\S/.test(line));
  return {
    id: idLine?.replace(/^id:\s*/, "").trim(),
    body,
    extra: front.filter((line) => line.trim() !== "" && !/^id:/.test(line)),
  };
}

function renderNote(id: string, content: string, extra: string[] = []): string {
  return `---\nid: ${id}\n${extra.map((line) => `${line}\n`).join("")}---\n\n${content}\n`;
}

function fileNameFor(row: Row, text: string): string {
  const firstLine = text.split(/\r?\n/).find((line) => line.trim() !== "") ?? "";
  const slug = firstLine
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return `${slug || "note"}-${row.id.slice(0, 8)}.md`;
}

async function writeAtomic(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.tmp`);
  await writeFile(temporary, text, "utf8");
  await rename(temporary, file);
}

async function walk(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const found: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name.includes(".sync-conflict")) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(full)));
    else if (entry.isFile() && entry.name.endsWith(".md")) found.push(full);
  }
  return found;
}

async function scan(root: string): Promise<MirrorFile[]> {
  const files: MirrorFile[] = [];
  for (const full of await walk(root)) {
    const rel = path.relative(root, full).split(path.sep).join("/");
    const [kind, ownerId] = rel.split("/");
    if (!KINDS.includes(kind as Kind) || !ownerId || rel.split("/").length < 3) continue;
    const text = await readFile(full, "utf8");
    const note = parseNote(text);
    files.push({
      rel,
      kind: kind as Kind,
      ownerId,
      id: note.id,
      body: note.body,
      mtime: (await stat(full)).mtimeMs,
      extra: note.extra,
    });
  }
  return files;
}

interface Stored {
  content: string;
  hash: string;
  sealed: boolean;
  tokens: number[] | null;
}

export function createMirror(
  query: Query,
  ensureSchema: () => Promise<void>,
  sealer?: MemorySealer,
) {
  const scopeOf = (kind: Kind, ownerId: string, spaceId: string | null) =>
    kind === "org" ? ownerId : spaceId;

  async function plainOf(row: Row): Promise<string> {
    if (!row.sealed) return row.content;
    const scope = scopeOf(row.kind, row.owner_id, row.space_id);
    if (!sealer || !scope) throw new Error("This memory is sealed and cannot be opened here");
    return sealer.open({ id: row.id, kind: row.kind, scope, owner: row.owner_id }, row.content);
  }

  /** The hash a row of this kind keeps for a body, so a file is compared the way the row is. */
  async function hashFor(row: Row, body: string): Promise<string> {
    if (!row.sealed) return hashContent(body);
    const scope = scopeOf(row.kind, row.owner_id, row.space_id);
    if (!sealer || !scope) throw new Error("This memory is sealed and cannot be opened here");
    return sealer.hash(scope, body);
  }

  async function storedFor(
    ref: { id: string; kind: Kind; ownerId: string; spaceId: string | null },
    body: string,
  ): Promise<Stored> {
    const scope = scopeOf(ref.kind, ref.ownerId, ref.spaceId);
    if (sealer?.enabled && scope) {
      const [content, hash, tokens] = await Promise.all([
        sealer.seal({ id: ref.id, kind: ref.kind, scope, owner: ref.ownerId }, body),
        sealer.hash(scope, body),
        sealer.tokens(scope, body),
      ]);
      return { content, hash, sealed: true, tokens };
    }
    return { content: body, hash: hashContent(body), sealed: false, tokens: null };
  }

  async function setSyncState(id: string, filePath: string, hash: string): Promise<void> {
    await query(`UPDATE ${TABLE} SET file_path = $2, synced_hash = $3 WHERE id = $1`, [
      id,
      filePath,
      hash,
    ]);
  }

  async function spaceFor(
    kind: Kind,
    ownerId: string,
    options: MirrorOptions,
  ): Promise<string | null | undefined> {
    if (kind === "org") return null;
    if (kind === "space") return ownerId;
    const known = await query(`SELECT space_id FROM ${TABLE} WHERE bot_id = $1 LIMIT 1`, [ownerId]);
    const existing = known.rows[0]?.space_id;
    return typeof existing === "string" ? existing : options.resolveSpaceId?.(ownerId);
  }

  return async function syncFolder(options: MirrorOptions): Promise<MirrorResult> {
    await ensureSchema();
    const result: MirrorResult = { exported: 0, imported: 0, created: 0, deleted: 0, skipped: 0 };
    const twoWay = options.mode === "two-way";
    await mkdir(options.dir, { recursive: true });
    const absolute = (rel: string) => path.join(options.dir, ...rel.split("/"));

    const { rows } = (await query(
      `SELECT id, kind, owner_id, space_id, content, content_hash, sealed, updated_at, file_path,
              synced_hash
       FROM ${TABLE} WHERE kind <> 'history'`,
    )) as { rows: Row[] };
    const files = await scan(options.dir);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const byPath = new Map(rows.flatMap((row) => (row.file_path ? [[row.file_path, row]] : [])));
    const matched = new Set<string>();

    for (const file of files) {
      const row = (file.id ? byId.get(file.id) : undefined) ?? byPath.get(file.rel);
      if (!row) {
        if (file.id) {
          await rm(absolute(file.rel), { force: true });
          result.deleted += 1;
        } else if (twoWay) {
          await createFromFile(file, options, result);
        }
        continue;
      }
      if (matched.has(row.id) || row.kind !== file.kind || row.owner_id !== file.ownerId) {
        result.skipped += 1;
        continue;
      }
      matched.add(row.id);
      const fileHash = await hashFor(row, file.body);
      if (fileHash === row.content_hash) {
        if (row.synced_hash !== fileHash || row.file_path !== file.rel) {
          await setSyncState(row.id, file.rel, fileHash);
        }
        continue;
      }
      const rowChanged = row.synced_hash !== row.content_hash;
      const fileChanged = fileHash !== row.synced_hash;
      const fileWins =
        twoWay && fileChanged && (!rowChanged || file.mtime > new Date(row.updated_at).getTime());
      if (fileWins) {
        if (!file.body || file.body.length > MAX_CONTENT_LENGTH) {
          result.skipped += 1;
          continue;
        }
        try {
          const next = await storedFor(
            { id: row.id, kind: row.kind, ownerId: row.owner_id, spaceId: row.space_id },
            file.body,
          );
          await query(
            `UPDATE ${TABLE}
             SET content = $2, content_hash = $3, synced_hash = $3, file_path = $4,
                 origin = 'file', updated_at = now(), sealed = $5, search_tokens = $6::integer[]
             WHERE id = $1`,
            [row.id, next.content, next.hash, file.rel, next.sealed, next.tokens],
          );
        } catch {
          result.skipped += 1;
          continue;
        }
        if (!file.id)
          await writeAtomic(absolute(file.rel), renderNote(row.id, file.body, file.extra));
        result.imported += 1;
      } else {
        await writeAtomic(absolute(file.rel), renderNote(row.id, await plainOf(row), file.extra));
        await setSyncState(row.id, file.rel, row.content_hash);
        result.exported += 1;
      }
    }

    const unmatched = rows.filter((row) => !matched.has(row.id));
    const exportedBefore = rows.filter((row) => row.file_path !== null).length;
    const vanished = unmatched.filter((row) => row.file_path !== null);
    const guardDeletions =
      twoWay &&
      vanished.length > 0 &&
      (files.length === 0 ||
        (vanished.length > MIN_DELETIONS_TO_GUARD && vanished.length > exportedBefore / 2));

    for (const row of unmatched) {
      if (row.file_path !== null && twoWay) {
        if (guardDeletions) {
          result.skipped += 1;
        } else {
          await query(`DELETE FROM ${TABLE} WHERE id = $1`, [row.id]);
          result.deleted += 1;
        }
        continue;
      }
      const text = await plainOf(row);
      const rel = row.file_path ?? `${row.kind}/${row.owner_id}/${fileNameFor(row, text)}`;
      await writeAtomic(absolute(rel), renderNote(row.id, text));
      await setSyncState(row.id, rel, row.content_hash);
      result.exported += 1;
    }
    return result;
  };

  async function createFromFile(
    file: MirrorFile,
    options: MirrorOptions,
    result: MirrorResult,
  ): Promise<void> {
    if (!file.body || file.body.length > MAX_CONTENT_LENGTH) {
      result.skipped += 1;
      return;
    }
    const spaceId = await spaceFor(file.kind, file.ownerId, options);
    if (spaceId === undefined) {
      result.skipped += 1;
      return;
    }
    const id = randomUUID();
    const next = await storedFor(
      { id, kind: file.kind, ownerId: file.ownerId, spaceId },
      file.body,
    );
    const { rows } = await query(
      `INSERT INTO ${TABLE}
         (id, kind, owner_id, space_id, bot_id, content, content_hash, synced_hash, file_path, origin,
          sealed, search_tokens)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, 'file', $9, $10::integer[])
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        id,
        file.kind,
        file.ownerId,
        spaceId,
        file.kind === "bot" ? file.ownerId : null,
        next.content,
        next.hash,
        file.rel,
        next.sealed,
        next.tokens,
      ],
    );
    if (rows.length === 0) {
      result.skipped += 1;
      return;
    }
    await writeAtomic(
      path.join(options.dir, ...file.rel.split("/")),
      renderNote(id, file.body, file.extra),
    );
    result.created += 1;
  }
}
