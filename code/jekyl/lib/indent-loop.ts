import { Frame, Item, columnOf, lineStartOf, skipBlanks } from "./indent-text";

/** Keywords that begin a clause. */
const CLAUSES = new Set([
  "named", "with", "for", "as", "repeat", "while", "until", "always",
  "never", "thereis", "return", "collect", "collecting", "append",
  "appending", "nconc", "nconcing", "sum", "summing", "count", "counting",
  "maximize", "maximizing", "minimize", "minimizing", "initially",
  "finally", "do", "doing",
]);

/** Keywords after which forms make up a body. */
const BODIES = new Set(["do", "doing", "initially", "finally"]);

/** Keywords of a conditional clause. */
const CONDITIONS = new Set(["when", "if", "unless", "else"]);

/** Keywords that belong to the clause before them. */
const PARTS = new Set([
  "upfrom", "downfrom", "upto", "downto", "below", "above", "into", "in",
  "on", "by", "from", "to", "across", "being", "each", "the", "then",
  "hash-key", "hash-keys", "hash-value", "hash-values", "present-symbol",
  "present-symbols", "external-symbol", "external-symbols", "using",
  "symbol", "symbols", "float", "fixnum", "of-type", "of", "=",
]);

/** Return the loop keyword ITEM is, lower case, or "" for any other. */
function word(text: string, item: Item): string {
  const token = text.slice(item.start, item.end).toLowerCase();
  return /^(#?:)?[a-z=*-]+$/.test(token) ? token.replace(/^#?:/, "") : "";
}

/** Return true when ITEM is the first thing on its line. */
function startsLine(text: string, item: Item): boolean {
  const start = lineStartOf(text, item.start);
  return skipBlanks(text, start) === item.start;
}

/** Return the index of the last item of ITEMS whose word is in SETS. */
function lastWord(
  text: string,
  items: Item[],
  ...sets: Set<string>[]
): number {
  for (let i = items.length - 1; i >= 1; i--) {
    const w = word(text, items[i]);
    if (sets.some((set) => set.has(w))) return i;
  }
  return -1;
}

/**
 * Return the column for the line at POINT inside the loop FRAME.
 *
 * A loop whose first clause is a form is simple: its forms align under
 * each other. An extended loop aligns clause keywords with the first
 * clause; the parts of a clause (in, below, then, =) hang 2 columns in
 * from their clause, and so does the clause a when, if, unless or else
 * governs when it begins on the next line. Forms after do, finally and
 * initially align under the first of them, or 3 columns in from the
 * keyword when none follows it on its line. and aligns with the clause
 * on the line before.
 */
export function loopIndent(
  text: string,
  frame: Frame,
  point: number,
): number {
  const open = columnOf(text, frame.open);
  const items = frame.items;
  const first = items[1];
  if (first === undefined) return open + 2;
  const sameLine =
    lineStartOf(text, first.start) === lineStartOf(text, frame.open);
  if (text[first.start] === "(") {
    return sameLine ? columnOf(text, first.start) : open + 2;
  }
  const base = sameLine ? columnOf(text, first.start) : open + 2;

  if (text[point] === "(") return formColumn(text, items, base);
  const here = word(text, {
    start: point,
    end: point + (text.slice(point).search(/[\s()]|$/) || 1),
    feature: false,
  });
  if (here === "and") return andColumn(text, items, base);
  if (PARTS.has(here)) {
    const clause = lastWord(text, items, CLAUSES, CONDITIONS);
    return (clause < 0 ? base : columnOf(text, items[clause].start)) + 2;
  }
  return clauseColumn(text, items, base);
}

/** Return the column of a form on a line of its own in a loop. */
function formColumn(text: string, items: Item[], base: number): number {
  const keyword = lastWord(text, items, CLAUSES, CONDITIONS, PARTS);
  if (keyword < 0) return base + 2;
  const item = items[keyword];
  if (!BODIES.has(word(text, item))) return columnOf(text, item.start) + 2;
  const after = items[keyword + 1];
  return after
    ? columnOf(text, after.start)
    : columnOf(text, item.start) + 3;
}

/** Return the column of an and: under the clause it continues. */
function andColumn(text: string, items: Item[], base: number): number {
  for (let i = items.length - 1; i >= 1; i--) {
    const item = items[i];
    const w = word(text, item);
    if (!startsLine(text, item)) continue;
    if (!CLAUSES.has(w) && !CONDITIONS.has(w)) continue;
    const next = items[i + 1];
    return w === "else" && next
      ? columnOf(text, next.start)
      : columnOf(text, item.start);
  }
  return base;
}

/** Return the column of a clause keyword: the base, or 2 in a pending
 * conditional. */
function clauseColumn(text: string, items: Item[], base: number): number {
  const keyword = lastWord(text, items, CLAUSES, CONDITIONS);
  if (keyword >= 0 && CONDITIONS.has(word(text, items[keyword]))) {
    return columnOf(text, items[keyword].start) + 2;
  }
  return base;
}
