import type { Range } from "./forms";

/** Where in Lisp text a position is. */
export type Context = "code" | "string" | "comment";

/** A symbol in text: where it is, and its name as the reader sees it. */
export interface SymbolSpan {
  start: number;
  end: number;
  name: string;
}

/** Characters that end a symbol; the same as the word pattern's. */
const ENDS = new Set([
  " ", "\t", "\n", "\r", "\f", "(", ")", "'", '"', "`", ",", ";", "|",
]);

function constituent(char: string): boolean {
  return !ENDS.has(char);
}

/**
 * Return what kind of text OFFSET is in: a string, a comment (line or
 * block) or code. It reads TEXT from its start, so it knows strings
 * and comments that run over many lines.
 */
export function contextAt(text: string, offset: number): Context {
  const end = Math.min(offset, text.length);
  let depth = 0; // nesting of #| |# comments
  let i = 0;
  while (i < end) {
    const char = text[i];
    if (depth > 0) {
      if (char === "|" && text[i + 1] === "#") {
        depth -= 1;
        i += 2;
      } else if (char === "#" && text[i + 1] === "|") {
        depth += 1;
        i += 2;
      } else {
        i += 1;
      }
    } else if (char === "#" && text[i + 1] === "|") {
      depth = 1;
      i += 2;
    } else if (char === "#" && text[i + 1] === "\\") {
      i += 3; // a character such as #\( or #\"
    } else if (char === ";") {
      const newline = text.indexOf("\n", i);
      if (newline < 0 || newline >= end) return "comment";
      i = newline + 1;
    } else if (char === '"') {
      i += 1;
      while (i < end && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      if (i >= end) return "string";
      i += 1;
    } else if (char === "|") {
      i += 1;
      while (i < end && text[i] !== "|") i += text[i] === "\\" ? 2 : 1;
      i += 1;
    } else {
      i += 1;
    }
  }
  return depth > 0 ? "comment" : "code";
}

/**
 * Return where the name begins in the symbol that spans START to END
 * of TEXT, leaving out what is not part of it: the #: of an uninterned
 * symbol, and the @ of ,@ .
 */
function nameStart(text: string, start: number, end: number): number {
  if (text.startsWith("#:", start)) return start + 2;
  if (text[start] === "@" && text[start - 1] === "," && start < end) {
    return start + 1;
  }
  return start;
}

/**
 * Return the symbol that ends at OFFSET, what is typed of one, or
 * undefined when nothing is.
 */
export function symbolBefore(
  text: string,
  offset: number,
): SymbolSpan | undefined {
  let start = offset;
  while (start > 0 && constituent(text[start - 1])) start -= 1;
  const first = nameStart(text, start, offset);
  if (first >= offset) return undefined;
  return { start: first, end: offset, name: text.slice(first, offset) };
}

/**
 * Return the symbol that OFFSET is in or at the end of, or undefined
 * when it is in none.
 */
export function symbolAround(
  text: string,
  offset: number,
): SymbolSpan | undefined {
  let start = offset;
  while (start > 0 && constituent(text[start - 1])) start -= 1;
  let end = offset;
  while (end < text.length && constituent(text[end])) end += 1;
  const first = nameStart(text, start, end);
  if (first >= end) return undefined;
  return { start: first, end, name: text.slice(first, end) };
}

/** A change to a text: START to END was replaced by LENGTH characters. */
export interface Edit {
  start: number;
  end: number;
  length: number;
}

/**
 * Return RANGE moved to where it is after EDIT, or undefined when the
 * edit touches it, as then it no longer describes the text.
 */
export function shiftRange(range: Range, edit: Edit): Range | undefined {
  if (range.end <= edit.start) return range;
  if (range.start >= edit.end) {
    const delta = edit.length - (edit.end - edit.start);
    return { start: range.start + delta, end: range.end + delta };
  }
  return undefined;
}

/**
 * Return the distinct words of TEXT that look like symbols: two
 * characters or more, numbers left out. Comments and strings are not
 * skipped; it is a light stand-in for a reader.
 */
export function wordsIn(text: string): string[] {
  const words = new Set<string>();
  const pattern = /[^\s()'"`,;|]{2,}/g;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const word = match[0].replace(/^#:/, "");
    if (/^[-+]?[0-9.]+$/.test(word)) continue;
    if (word.length >= 2) words.add(word);
  }
  return [...words];
}

/**
 * Return how well PATTERN matches LABEL, higher for better, or
 * undefined when it does not. Every letter of the pattern must occur in
 * the label in order, case aside, the way slynk's flex matching has it;
 * a run of letters together, a letter at the start of a part between
 * hyphens and an early start all score more.
 */
export function flexScore(
  pattern: string,
  label: string,
): number | undefined {
  const want = pattern.toLowerCase();
  const have = label.toLowerCase();
  let score = 0;
  let at = 0;
  let previous = -2;
  for (const letter of want) {
    const found = have.indexOf(letter, at);
    if (found < 0) return undefined;
    if (found === previous + 1) score += 3;
    if (found === 0 || "-:*+/.".includes(have[found - 1])) score += 4;
    score -= (found - at) / 5; // letters skipped
    previous = found;
    at = found + 1;
  }
  if (have.startsWith(want)) score += 10;
  return score - (have.length - want.length) / 100;
}
