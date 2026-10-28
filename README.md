# anviq-memory

Memory engine for Anviq Agents. It stores and recalls notes on Postgres, with no external service and no per-call cost.

## Namespaces

Every memory belongs to one namespace:

- `bot`: one agent
- `space`: one team workspace
- `org`: one organization (shared across its spaces)
- `history`: compacted conversation history of a bot, per generation

The caller decides which namespaces a request may read. `recall` only searches the namespaces it is given, and `forget` only deletes inside them.

## Use

```ts
import { createMemoryEngine } from "@anviq/memory-engine";

const memory = createMemoryEngine((sql, params) => pool.query(sql, params));

await memory.save({ namespace: { kind: "bot", id: botId }, spaceId, content: "Invoices are due on Friday" });
const found = await memory.recall({
  namespaces: [{ kind: "bot", id: botId }, { kind: "space", id: spaceId }],
  query: "when are invoices due",
  limit: 8,
});
```

The engine creates and migrates its own `anviq_memory` schema on first use. Any client that runs a single SQL statement with parameters works (`pg`, Prisma raw queries, PGlite).

Deleting a bot, space or organization must also call `purgeBot`, `purgeSpace` or `purgeOrg`, because the tables have no foreign keys into the host database.

## Markdown mirror

`syncFolder({ dir, mode })` keeps a folder of Markdown notes in step with the database, one note
per bot, space and organization memory. `export` writes notes from the database. `two-way` also
imports edited and new notes and deletes memories whose notes were removed. Host applications call
it on a timer.

Search uses Postgres full-text search with the `simple` configuration, so it works for any language without stemming.

## Sealed memory

Pass a `sealer` to keep memory encrypted at rest. The host owns the keys; the engine only stores what
the sealer returns:

```ts
const memory = createMemoryEngine(query, { sealer });
await memory.recall({ namespaces, spaceId, query: "invoices", limit: 8 });
```

A sealed row holds ciphertext in `content`, a keyed hash for deduplication and blind-index tokens for
search. Recall matches on the tokens and ranks by how many query terms a memory hits, then opens only
the rows it returns. Bot, space and history memory need the `spaceId` on recall, and org memory is keyed
by the organization. Rows written before sealing stay readable, and `rewrite({ mode: "seal" })` seals
them (`"unseal"` writes them back for a rollback). With `sealer.enabled` false, new memories are plaintext
and sealed ones still open. The Markdown mirror reads and writes through the sealer, so its folder is
plaintext by design.

## Develop

```
pnpm install
pnpm test
pnpm run check
pnpm run build
```

Tests run in process on PGlite and need no database server.
