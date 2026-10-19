import { createHash } from "node:crypto";

export const MAX_CONTENT_LENGTH = 16_000;

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
