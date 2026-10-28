export type Query = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: Record<string, unknown>[] }>;

export type Namespace =
  | { kind: "org"; id: string }
  | { kind: "space"; id: string }
  | { kind: "bot"; id: string }
  | { kind: "history"; id: string; generation: number };

export interface SaveRequest {
  namespace: Namespace;
  /** Required for every namespace except org. */
  spaceId?: string;
  content: string;
  origin?: "bot" | "file";
}

export interface RecallRequest {
  namespaces: Namespace[];
  /** The space the bot and history namespaces belong to. Required when memory is sealed. */
  spaceId?: string;
  query: string;
  limit: number;
}

export interface ForgetRequest {
  id: string;
  namespaces: Namespace[];
}

/** The row a sealed value belongs to, so a value moved to another row fails to open. */
export interface SealedRowRef {
  id: string;
  kind: Namespace["kind"];
  /** The space, or the organisation for org memory. It picks the key. */
  scope: string;
  /** The bot, space, organisation or history owner. */
  owner: string;
}

/**
 * Supplied by the host, which owns the keys. The engine stores what it returns and never sees a key.
 * `open` returns plaintext values as given, so rows from before sealing keep reading.
 */
export interface MemorySealer {
  /** False stores new memories as plaintext while still opening sealed ones. */
  enabled: boolean;
  seal(row: SealedRowRef, text: string): Promise<string>;
  open(row: SealedRowRef, stored: string): Promise<string>;
  /** A keyed hash, so equal texts dedupe without the hash confirming a guess. */
  hash(scope: string, text: string): Promise<string>;
  /** Blind-index tokens for the words of a stored text. */
  tokens(scope: string, text: string): Promise<number[]>;
  /** One token list per query term, covering every key a stored row may use. */
  queryTokens(scope: string, query: string): Promise<number[][]>;
}

export interface Memory {
  id: string;
  namespace: Namespace;
  content: string;
  origin: "bot" | "file";
  updatedAt: string;
}

export interface RecalledMemory extends Memory {
  /** 0 to 1, higher is a closer match. */
  score: number;
}
