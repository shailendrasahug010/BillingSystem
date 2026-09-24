import { badRequest } from "./errors.js";

/**
 * Keyset pagination: the cursor carries the last row's sort value and id, so
 * page 500 costs the same as page 1 (no OFFSET scans on large tables).
 */
export interface CursorValue {
  v: string | number | null;
  id: string;
}

export function encodeCursor(value: CursorValue): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function decodeCursor(cursor: string | undefined): CursorValue | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as CursorValue;
    if (typeof parsed.id !== "string") throw new Error("bad cursor");
    return parsed;
  } catch {
    throw badRequest("INVALID_CURSOR", {}, "cursor");
  }
}

export function page<T>(rows: T[], limit: number, cursorOf: (row: T) => CursorValue): { data: T[]; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data.at(-1);
  return { data, nextCursor: hasMore && last ? encodeCursor(cursorOf(last)) : null };
}
