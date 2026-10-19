export const SCHEMA = "anviq_memory";

// One statement per entry: pg pools, Prisma raw queries and PGlite all accept a single statement.
export const MIGRATIONS: readonly (readonly string[])[] = [
  [
    `CREATE TABLE IF NOT EXISTS ${SCHEMA}.memories (
      id text PRIMARY KEY,
      kind text NOT NULL CHECK (kind IN ('org', 'space', 'bot', 'history')),
      owner_id text NOT NULL,
      generation integer,
      space_id text,
      bot_id text,
      content text NOT NULL,
      content_hash text NOT NULL,
      origin text NOT NULL DEFAULT 'bot' CHECK (origin IN ('bot', 'file')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      search tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
      CHECK ((kind = 'history') = (generation IS NOT NULL))
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS memories_dedupe
      ON ${SCHEMA}.memories (kind, owner_id, COALESCE(generation, -1), content_hash)`,
    `CREATE INDEX IF NOT EXISTS memories_search ON ${SCHEMA}.memories USING gin (search)`,
    `CREATE INDEX IF NOT EXISTS memories_space ON ${SCHEMA}.memories (space_id)`,
    `CREATE INDEX IF NOT EXISTS memories_bot ON ${SCHEMA}.memories (bot_id)`,
  ],
  [
    `ALTER TABLE ${SCHEMA}.memories ADD COLUMN IF NOT EXISTS file_path text`,
    `ALTER TABLE ${SCHEMA}.memories ADD COLUMN IF NOT EXISTS synced_hash text`,
    `CREATE UNIQUE INDEX IF NOT EXISTS memories_file_path
      ON ${SCHEMA}.memories (file_path) WHERE file_path IS NOT NULL`,
  ],
];
