/*
 * What to colour in Common Lisp text beyond the grammar.
 *
 * A scan finds two kinds of span. A macro span is the operator of a
 * call to a macro the running Lisp has loaded, which the grammar cannot
 * know. A suppressed span is a form that `#+` or `#-` removes, with its
 * reader macro and feature expression, judged against the features of
 * the image, which is drawn like a comment.
 */

import { Features } from "./features";
import { blockEnd, isDelimiter, stringEnd, tokenEnd } from "./indent-text";
import { ruleName } from "./indent-rules";

/** A stretch of text to colour. */
export interface Span {
  start: number;
  end: number;
  kind: "macro" | "suppressed";
}

/** A span on one line, in line and character coordinates. */
export interface LineSpan {
  line: number;
  char: number;
  length: number;
  kind: Span["kind"];
}

/** Return whether NAME, as written, is a macro to colour. */
export type IsMacro = (name: string) => boolean;

/** Reads a text once, collecting spans. */
class Scanner {
  readonly spans: Span[] = [];
  private readonly n: number;

  constructor(
    private readonly text: string,
    private readonly isMacro: IsMacro,
    private readonly features: Features,
  ) {
    this.n = text.length;
  }

  /** Return the first position at or after I that is not blank. */
  skip(i: number): number {
    const { text, n } = this;
    let j = i;
    while (j < n) {
      const c = text[j];
      if (c === ";") {
        const eol = text.indexOf("\n", j);
        j = eol < 0 ? n : eol;
      } else if (c === "#" && text[j + 1] === "|") {
        const end = blockEnd(text, j, n);
        j = end < 0 ? n : end;
      } else if (/\s/.test(c)) {
        j++;
      } else {
        return j;
      }
    }
    return n;
  }

  /**
   * Read the form at I, which is not blank, and return where it ends.
   * QUOTED is true inside data, where operators are not calls; LIVE is
   * false inside a form that is suppressed, which is coloured whole.
   */
  form(i: number, quoted: boolean, live: boolean): number {
    const { text, n } = this;
    const c = text[i];
    if (c === "(") return this.list(i, quoted, live);
    if (c === ")") return i + 1;
    if (c === '"') {
      const end = stringEnd(text, i, n);
      return end < 0 ? n : end;
    }
    if (c === "'") return this.next(i + 1, true, live);
    if (c === "`") return this.next(i + 1, false, live);
    if (c === ",") {
      return this.next(text[i + 1] === "@" ? i + 2 : i + 1, false, live);
    }
    if (c === "#") return this.dispatch(i, quoted, live);
    const end = tokenEnd(text, i, n);
    return Math.max(end < 0 ? n : end, i + 1);
  }

  /** Read the form after a prefix that ended at I. */
  private next(i: number, quoted: boolean, live: boolean): number {
    const j = this.skip(i);
    return j >= this.n ? this.n : this.form(j, quoted, live);
  }

  /** Read the list that opens at I. */
  private list(i: number, quoted: boolean, live: boolean): number {
    const { text, n } = this;
    let j = i + 1;
    let head = true;
    for (;;) {
      j = this.skip(j);
      if (j >= n) return n;
      if (text[j] === ")") return j + 1;
      if (head && live && !quoted) this.operator(j);
      head = false;
      j = this.form(j, quoted, live);
    }
  }

  /** Record the symbol at I as a macro span when it names one. */
  private operator(i: number): void {
    const { text, n } = this;
    if (/["'`,#()]/.test(text[i])) return;
    const end = tokenEnd(text, i, n);
    if (end < 0) return;
    const name = text.slice(i, end);
    if (this.isMacro(ruleName(name))) {
      this.spans.push({ start: i, end, kind: "macro" });
    }
  }

  /** Read the form that starts with `#` at I. */
  private dispatch(i: number, quoted: boolean, live: boolean): number {
    const { text, n } = this;
    const c = text[i + 1];
    if (c === "|") {
      const end = blockEnd(text, i, n);
      return end < 0 ? n : end;
    }
    if (c === "+" || c === "-") return this.conditional(i, quoted, live);
    if (c === "\\") {
      let j = Math.min(i + 3, n);
      while (j < n && !isDelimiter(text[j])) j++;
      return j;
    }
    if (c === "'") return this.next(i + 2, false, live);
    if (c === ".") return this.next(i + 2, false, live);
    let j = i + 1;
    while (j < n && /[0-9]/.test(text[j])) j++;
    const d = text[j];
    if (d === "=") return this.next(j + 1, quoted, live);
    if (d === "#" || d === undefined) return Math.min(j + 1, n);
    if (d === "(") return this.form(j, true, live);
    j++;
    if (text[j] === "(") return this.form(j, true, live);
    if (j >= n || isDelimiter(text[j]) || /\s/.test(text[j])) return j;
    return this.form(j, true, live);
  }

  /**
   * Read `#+` or `#-` at I with the expression and form after it. The
   * form is suppressed when the expression says so.
   */
  private conditional(i: number, quoted: boolean, live: boolean): number {
    const { text, n } = this;
    const start = this.skip(i + 2);
    if (start >= n) return n;
    const expressionEnd = this.form(start, true, false);
    const formStart = this.skip(expressionEnd);
    if (formStart >= n) return n;
    const truth = live
      ? this.features.test(text.slice(start, expressionEnd))
      : undefined;
    const plus = text[i + 1] === "+";
    const hidden =
      truth !== undefined && (plus ? truth === false : truth === true);
    const end = this.form(formStart, quoted, live && !hidden);
    if (hidden) this.spans.push({ start: i, end, kind: "suppressed" });
    return end;
  }

  /** Read every top level form of the text. */
  run(): Span[] {
    let i = this.skip(0);
    while (i < this.n) {
      i = this.skip(this.form(i, false, true));
    }
    return this.spans;
  }
}

/**
 * Scan TEXT for macro calls that ISMACRO accepts and for forms that
 * FEATURES suppress. Spans arrive in text order.
 */
export function scan(
  text: string,
  isMacro: IsMacro,
  features: Features,
): Span[] {
  return new Scanner(text, isMacro, features)
    .run()
    .sort((a, b) => a.start - b.start);
}

/**
 * Split SPANS of TEXT so that none crosses a line, since semantic
 * tokens cannot; blank pieces and line ends are left out.
 */
export function byLine(text: string, spans: Span[]): LineSpan[] {
  const starts = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) {
    starts.push(i + 1);
  }
  const lineOf = (offset: number): number => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid] <= offset) low = mid;
      else high = mid - 1;
    }
    return low;
  };
  const pieces: LineSpan[] = [];
  for (const span of spans) {
    for (let line = lineOf(span.start); line < starts.length; line++) {
      if (starts[line] >= span.end) break;
      const from = Math.max(span.start, starts[line]);
      let to = Math.min(span.end, starts[line + 1] ?? text.length + 1);
      to = Math.min(to, text.length);
      while (to > from && (text[to - 1] === "\n" || text[to - 1] === "\r")) {
        to--;
      }
      if (to > from) {
        pieces.push({
          line,
          char: from - starts[line],
          length: to - from,
          kind: span.kind,
        });
      }
    }
  }
  return pieces;
}
