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
  query: string;
  limit: number;
}

export interface ForgetRequest {
  id: string;
  namespaces: Namespace[];
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
