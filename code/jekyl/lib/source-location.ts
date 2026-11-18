import type { SourceLocation } from "../base/debugger";

/** How far from the reported position a snippet may be found. */
const SNIPPET_REACH = 2000;

/**
 * Return the offset in TEXT that LOCATION points at, or undefined when
 * it points nowhere. Positions are counted from 1, as Emacs does. When
 * the location carries a snippet of the code, the nearest occurrence of
 * it within reach wins over the position, since the position counts
 * characters of the file as it was compiled and the file may have
 * changed since. Without a position, the line and column are used.
 */
export function locationOffset(
  text: string,
  location: SourceLocation,
): number | undefined {
  if (location.position !== null) {
    const position = Math.min(Math.max(location.position - 1, 0), text.length);
    if (location.snippet) return nearest(text, location.snippet, position);
    return position;
  }
  if (location.line !== null) {
    let offset = 0;
    for (let line = 1; line < location.line; line += 1) {
      const next = text.indexOf("\n", offset);
      if (next < 0) return undefined;
      offset = next + 1;
    }
    const column = Math.max((location.column ?? 1) - 1, 0);
    return Math.min(offset + column, text.length);
  }
  return undefined;
}

/**
 * Return the offset of SNIPPET in TEXT nearest to AROUND and within
 * reach of it, or AROUND when it is nowhere near.
 */
function nearest(text: string, snippet: string, around: number): number {
  const after = text.indexOf(snippet, around);
  const before = text.lastIndexOf(snippet, around);
  const candidates = [after, before].filter(
    (found) => found >= 0 && Math.abs(found - around) <= SNIPPET_REACH,
  );
  if (candidates.length === 0) return around;
  return candidates.reduce((best, found) =>
    Math.abs(found - around) < Math.abs(best - around) ? found : best,
  );
}
