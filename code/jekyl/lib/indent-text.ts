/*
 * The text side of indentation: the list structure that holds a given
 * line, and measuring in columns. Like forms.ts it knows where forms
 * start and end and nothing about what they mean, and it copes with
 * text that is unbalanced while it is being typed.
 */

/** One element of a list: the span it covers, offsets, END exclusive. */
export interface Item {
  start: number;
  end: number;
  /** True for a #+ or #- feature expression, not the form it guards. */
  feature: boolean;
}

/** A list that is still open at the point being indented. */
export interface Frame {
  /** Offset of the opening parenthesis. */
  open: number;
  /** Offset of the form, which includes reader macro characters. */
  start: number;
  /** True when a feature expression, as for Item. */
  feature: boolean;
  /** The elements that are complete; the head comes first. */
  items: Item[];
}

/** What a scan of the text before a line finds. */
export interface Parsed {
  /** The open lists, innermost first; empty at top level. */
  chain: Frame[];
  /** True when the line starts inside a string or a block comment. */
  inside: boolean;
}

/** Return true when CHAR is whitespace. */
export function isSpace(char: string | undefined): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r" ||
    char === "\f";
}

const DELIMITERS = new Set(["(", ")", '"', ";", "`", ","]);

/** Return true when CHAR ends a token. */
function isDelimiter(char: string): boolean {
  return isSpace(char) || DELIMITERS.has(char);
}

/** Return the offset where the line holding POS starts. */
export function lineStartOf(text: string, pos: number): number {
  return pos <= 0 ? 0 : text.lastIndexOf("\n", pos - 1) + 1;
}

/** Return the column of offset POS. */
export function columnOf(text: string, pos: number): number {
  return pos - lineStartOf(text, pos);
}

/** Return the offset of the first character after blanks from POS. */
export function skipBlanks(text: string, pos: number): number {
  let i = pos;
  while (text[i] === " " || text[i] === "\t") i++;
  return i;
}

/** Return the offset where the line holding POS ends. */
export function lineEndOf(text: string, pos: number): number {
  const end = text.indexOf("\n", pos);
  return end < 0 ? text.length : end;
}

/**
 * Return the offset to scan from for a line at TO: the last line before
 * it that starts with an opening parenthesis, which starts a top-level
 * form. The line itself does not count; it is the one being placed.
 */
function formStart(text: string, to: number): number {
  if (to <= 1) return 0;
  const found = text.lastIndexOf("\n(", to - 2);
  return found < 0 ? 0 : found + 1;
}

/** Return the end of the string from I, or -1 if it is open at TO. */
function stringEnd(text: string, i: number, to: number): number {
  let j = i + 1;
  while (j < to) {
    if (text[j] === "\\") {
      j += 2;
    } else if (text[j] === '"') {
      return j + 1;
    } else {
      j++;
    }
  }
  return -1;
}

/** Return the end of the block comment from I, or -1 if open at TO. */
function blockEnd(text: string, i: number, to: number): number {
  let depth = 0;
  let j = i;
  while (j < to) {
    const pair = text.slice(j, j + 2);
    if (pair === "#|") {
      depth++;
      j += 2;
    } else if (pair === "|#") {
      depth--;
      j += 2;
      if (depth === 0) return j;
    } else {
      j++;
    }
  }
  return -1;
}

/** Return the end of the token from I, or -1 if a |symbol| is open. */
function tokenEnd(text: string, i: number, to: number): number {
  let j = i;
  while (j < to && !isDelimiter(text[j])) {
    if (text[j] === "|") {
      const close = text.indexOf("|", j + 1);
      if (close < 0 || close >= to) return -1;
      j = close + 1;
    } else if (text[j] === "\\") {
      j += 2;
    } else {
      j++;
    }
  }
  return Math.min(j, to);
}

/**
 * Scan the text before offset TO, the start of a line, and return the
 * lists that are open there, and whether TO is inside a string or a
 * block comment, where nothing should be indented.
 */
export function parse(text: string, to: number): Parsed {
  const stack: Frame[] = [];
  const result = (inside: boolean): Parsed => ({
    chain: stack.slice().reverse(),
    inside,
  });
  const complete = (start: number, end: number, feature: boolean): void => {
    stack[stack.length - 1]?.items.push({ start, end, feature });
  };
  let prefix = -1;
  let feature = false;
  const open = (at: number, start: number): void => {
    stack.push({ open: at, start, feature, items: [] });
    prefix = -1;
    feature = false;
  };
  const startAt = (i: number): number => (prefix >= 0 ? prefix : i);
  let i = formStart(text, to);

  while (i < to) {
    const char = text[i];
    const next = text[i + 1];
    if (isSpace(char)) {
      i++;
    } else if (char === ";") {
      const end = text.indexOf("\n", i);
      i = end < 0 || end >= to ? to : end + 1;
    } else if (char === "#" && next === "|") {
      const end = blockEnd(text, i, to);
      if (end < 0) return result(true);
      i = end;
    } else if (char === '"') {
      const end = stringEnd(text, i, to);
      if (end < 0) return result(true);
      complete(startAt(i), end, feature);
      prefix = -1;
      feature = false;
      i = end;
    } else if (char === "(") {
      open(i, startAt(i));
      i++;
    } else if (char === ")") {
      const frame = stack.pop();
      if (frame) complete(frame.start, i + 1, frame.feature);
      i++;
    } else if (char === "'" || char === "`") {
      if (prefix < 0) prefix = i;
      i++;
    } else if (char === ",") {
      if (prefix < 0) prefix = i;
      i += next === "@" ? 2 : 1;
    } else if (char === "#" && (next === "+" || next === "-")) {
      if (prefix < 0) prefix = i;
      feature = true;
      i += 2;
    } else if (char === "#" && (next === "'" || next === ".")) {
      if (prefix < 0) prefix = i;
      i += 2;
    } else if (char === "#" && next === "\\") {
      const end = tokenEnd(text, i + 3, to);
      complete(startAt(i), Math.max(end, i + 3), false);
      prefix = -1;
      i = Math.max(end, i + 3);
    } else if (char === "#" && dispatchOpen(text, i)) {
      const at = dispatchOpen(text, i) as number;
      open(at, startAt(i));
      i = at + 1;
    } else if (char === "#" && dispatchString(text, i)) {
      if (prefix < 0) prefix = i;
      i = dispatchString(text, i) as number;
    } else {
      const end = tokenEnd(text, i, to);
      if (end < 0) return result(true);
      complete(startAt(i), Math.max(end, i + 1), feature);
      prefix = -1;
      feature = false;
      i = Math.max(end, i + 1);
    }
  }
  return result(false);
}

/**
 * Return the offset of the "(" of a #( or #2A( form at I, or undefined
 * when I starts no such form.
 */
function dispatchOpen(text: string, i: number): number | undefined {
  let j = i + 1;
  while (/[0-9]/.test(text[j] ?? "")) j++;
  if (j > i + 1 && /[a-z]/i.test(text[j] ?? "")) j++;
  return text[j] === "(" ? j : undefined;
}

/**
 * Return the offset of the quote of a #P"..." form at I, or undefined
 * when I starts no such form.
 */
function dispatchString(text: string, i: number): number | undefined {
  return /^#[0-9]*[a-z]"/i.test(text.slice(i, i + 8))
    ? text.indexOf('"', i)
    : undefined;
}

/** Return the text of ITEM. */
export function itemText(text: string, item: Item): string {
  return text.slice(item.start, item.end);
}

/**
 * Return the end of the first form that starts at or after POS on its
 * line, or undefined when the rest of the text holds none. This is the
 * form on the line being indented.
 */
export function formEndAt(text: string, pos: number): number | undefined {
  const start = skipBlanks(text, pos);
  const char = text[start];
  if (char === undefined || char === "\n" || char === ";") return undefined;
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const c = text[i];
    if (c === "(") {
      depth++;
    } else if (c === ")") {
      depth--;
      if (depth <= 0) return i + 1;
    } else if (c === '"') {
      const end = stringEnd(text, i, text.length);
      if (end < 0) return undefined;
      i = end;
      if (depth === 0) return i;
      continue;
    } else if (depth === 0 && isDelimiter(c)) {
      return i;
    } else if (c === ";") {
      i = lineEndOf(text, i);
      continue;
    }
    i++;
  }
  return depth === 0 ? i : undefined;
}
