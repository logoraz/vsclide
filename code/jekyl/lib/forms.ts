/** A span of text: START is inclusive, END exclusive, both offsets. */
export interface Range {
  start: number;
  end: number;
}

/** What a scan finds in a text. */
export interface Scan {
  /** Forms not nested in another form, in order. */
  top: Range[];
  /** Every form, nested ones too, in the order they were completed. */
  all: Range[];
}

/*
 * A scanner for the outline of Common Lisp text: where forms start and
 * end, and nothing about what they mean. It knows strings, comments,
 * block comments, |symbols|, character literals and the reader macros
 * that attach to the form after them. This stands in for the reader of
 * the future editing arm (see docs/architecture.md) and is meant to
 * keep working on text that is unbalanced while it is being typed: an
 * open list ends at the end of the text, and a stray close is skipped.
 */

const DELIMITERS = new Set(["(", ")", '"', "'", ";", "`", ","]);

function isSpace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r" ||
    char === "\f";
}

function isDelimiter(char: string): boolean {
  return isSpace(char) || DELIMITERS.has(char);
}

class Scanner {
  readonly all: Range[] = [];
  private i = 0;

  constructor(private readonly text: string) {}

  /** Scan the whole text. */
  run(): Scan {
    const top: Range[] = [];
    for (;;) {
      const form = this.readForm();
      if (form) {
        top.push(form);
        continue;
      }
      this.skipTrivia();
      if (this.i >= this.text.length) break;
      this.i++; // a close parenthesis with nothing to close
    }
    return { top, all: this.all };
  }

  /** Advance past whitespace and comments. */
  private skipTrivia(): void {
    const text = this.text;
    while (this.i < text.length) {
      const char = text[this.i];
      if (isSpace(char)) {
        this.i++;
      } else if (char === ";") {
        const newline = text.indexOf("\n", this.i);
        this.i = newline < 0 ? text.length : newline + 1;
      } else if (char === "#" && text[this.i + 1] === "|") {
        this.skipBlockComment();
      } else {
        return;
      }
    }
  }

  /** Advance past a #| ... |# comment, which may nest. */
  private skipBlockComment(): void {
    const text = this.text;
    let depth = 0;
    while (this.i < text.length) {
      const pair = text.slice(this.i, this.i + 2);
      if (pair === "#|") {
        depth++;
        this.i += 2;
      } else if (pair === "|#") {
        depth--;
        this.i += 2;
        if (depth === 0) return;
      } else {
        this.i++;
      }
    }
  }

  /**
   * Read one form and return its range, or undefined at the end of the
   * text or at a close parenthesis, which is left for the caller.
   */
  private readForm(): Range | undefined {
    this.skipTrivia();
    const text = this.text;
    const start = this.i;
    if (start >= text.length) return undefined;
    const char = text[start];
    if (char === ")") return undefined;

    if (char === "(") {
      this.i++;
      this.readListBody();
    } else if (char === '"') {
      this.i++;
      this.skipString();
    } else if (char === "'" || char === "`") {
      this.i++;
      this.readForm();
    } else if (char === ",") {
      this.i++;
      if (text[this.i] === "@") this.i++;
      this.readForm();
    } else if (char === "#") {
      this.readDispatch();
    } else {
      this.skipToken();
    }
    return this.record(start);
  }

  /** Record the form that began at START and ended at the cursor. */
  private record(start: number): Range {
    const range = { start, end: this.i };
    this.all.push(range);
    return range;
  }

  /** Read forms up to and including the matching close parenthesis. */
  private readListBody(): void {
    for (;;) {
      if (this.readForm()) continue;
      this.skipTrivia();
      if (this.text[this.i] === ")") this.i++;
      return;
    }
  }

  /** Advance past the rest of a string; the opening quote is behind. */
  private skipString(): void {
    const text = this.text;
    while (this.i < text.length) {
      const char = text[this.i++];
      if (char === "\\") this.i++;
      else if (char === '"') return;
    }
    this.i = text.length;
  }

  /** Advance past a symbol or number, with | | and \ escapes. */
  private skipToken(): void {
    const text = this.text;
    while (this.i < text.length && !isDelimiter(text[this.i])) {
      const char = text[this.i++];
      if (char === "\\") {
        this.i++;
      } else if (char === "|") {
        const close = text.indexOf("|", this.i);
        this.i = close < 0 ? text.length : close + 1;
      }
    }
    if (this.i > text.length) this.i = text.length;
  }

  /** Read a form that starts with #, the cursor on the #. */
  private readDispatch(): void {
    const text = this.text;
    this.i++; // the #
    while (/[0-9]/.test(text[this.i] ?? "")) this.i++;
    const char = text[this.i];
    if (char === undefined) return;
    if (char === "\\") {
      // A character: the next character whatever it is, then any more
      // constituents, as in #\Space.
      this.i += 2;
      this.skipToken();
    } else if (char === "(") {
      this.i++;
      this.readListBody();
    } else if (char === "+" || char === "-") {
      this.i++;
      this.readForm(); // the feature expression
      this.readForm(); // the form it guards
    } else {
      this.i++; // the dispatch character
      const next = text[this.i];
      if (next === "(" || next === '"' || next === "'" || next === "#" ||
          next === "`" || next === ",") {
        this.readForm();
      } else {
        this.skipToken();
      }
    }
    if (this.i > text.length) this.i = text.length;
  }
}

/** Find the forms in TEXT. */
export function scanForms(text: string): Scan {
  return new Scanner(text).run();
}

/**
 * Return the top-level form for the cursor at OFFSET: the form that
 * contains it, else the nearest one before it, else the first one
 * after. A cursor just after the closing parenthesis counts as inside.
 */
export function topLevelFormAt(
  text: string,
  offset: number,
  scan: Scan = scanForms(text),
): Range | undefined {
  const { top } = scan;
  const inside =
    top.find((range) => range.start <= offset && offset < range.end) ??
    top.find((range) => range.start <= offset && offset <= range.end);
  if (inside) return inside;
  const before = top.filter((range) => range.end <= offset);
  if (before.length > 0) return before[before.length - 1];
  return top.find((range) => range.start >= offset);
}

/**
 * Return the form that ends last at or before OFFSET, as Emacs does
 * for the expression before point. Of several forms ending at the same
 * place, such as 'x and x, the largest wins.
 */
export function formBefore(
  text: string,
  offset: number,
  scan: Scan = scanForms(text),
): Range | undefined {
  let best: Range | undefined;
  for (const range of scan.all) {
    if (range.end > offset) continue;
    if (
      !best ||
      range.end > best.end ||
      (range.end === best.end && range.start < best.start)
    ) {
      best = range;
    }
  }
  return best;
}

const IN_PACKAGE = new RegExp(
  String.raw`^\(\s*(?:(?:cl|common-lisp):)?in-package\s+` +
    String.raw`(?:#?:)?("(?:[^"\\]|\\.)*"|[^\s()"]+)\s*\)$`,
  "i",
);

/**
 * Return the name of the package the last in-package form before OFFSET
 * selects, or undefined when there is none. A symbol designator is
 * upcased as the reader would; a string is taken as written.
 */
export function packageAt(
  text: string,
  offset: number,
  scan: Scan = scanForms(text),
): string | undefined {
  let name: string | undefined;
  for (const range of scan.top) {
    if (range.start >= offset) break;
    const match = IN_PACKAGE.exec(text.slice(range.start, range.end));
    if (!match) continue;
    const designator = match[1];
    name = designator.startsWith('"')
      ? designator.slice(1, -1).replace(/\\(.)/g, "$1")
      : designator.toUpperCase();
  }
  return name;
}
