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

## Develop

```
pnpm install
pnpm test
pnpm run check
pnpm run build
```

Tests run in process on PGlite and need no database server.
