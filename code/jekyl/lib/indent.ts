/*
 * Indentation of Common Lisp, in the manner of an Emacs Lisp mode: the
 * line is placed from the operator of the call it is in, by the rules
 * in indent-rules.ts, and from the lists around that call when the
 * operator has no say. Where no rule applies, arguments align under
 * the first argument, or under the operator when there is none yet.
 * The scan is in indent-text.ts and the rules for loop in
 * indent-loop.ts.
 */
import { loopIndent } from "./indent-loop";
import { IndentRules, Spec, ruleName } from "./indent-rules";
import {
  Frame,
  Item,
  columnOf,
  formEndAt,
  itemText,
  lineStartOf,
  parse,
  skipBlanks,
} from "./indent-text";

/** How many enclosing calls are consulted before giving up. */
const MAX_DEPTH = 6;

/** The rule def forms follow when their operator has no rule. */
const DEFUN: Spec[] = [4, "&lambda", "&body"];

/** The head of a do: the variables, then the end test. */
const DO_HEAD: Spec[] = [
  ["&whole", 4, "&rest", ["&whole", 1, 1, 2]],
  ["&whole", 4, "&rest", 1],
];

/** The columns a body is indented by. */
const BODY = 2;

/** One line to place: where it is, what is around it, which rules. */
interface Line {
  text: string;
  /** Offset of the first character that is not a blank. */
  point: number;
  /** The open lists around the line, innermost first. */
  chain: Frame[];
  rules: IndentRules;
}

/**
 * Pick the element of SPEC that rules argument INDEX. Return the
 * element and whether it was reached by &rest and is not the first
 * argument it rules, or undefined when SPEC has too few elements.
 */
function pick(
  spec: Spec[],
  index: number,
): { element: Spec; tail: boolean } | undefined {
  let remaining = index;
  for (let i = 0; i < spec.length; i++) {
    const element = spec[i];
    if (element === "&body") return { element, tail: false };
    if (element === "&rest") {
      return i + 1 < spec.length
        ? { element: spec[i + 1], tail: remaining > 0 }
        : undefined;
    }
    if (remaining === 0) return { element, tail: false };
    remaining--;
  }
  return undefined;
}

/** Return the name ITEM is when it can name an operator, else undefined. */
function operatorName(text: string, item: Item): string | undefined {
  if (item.feature) return undefined;
  return /^[^\s()"'`,;#]/.test(text.slice(item.start, item.end))
    ? itemText(text, item)
    : undefined;
}

/** The working of one indentation: the column for one line. */
class Calculation {
  private readonly text: string;
  private readonly point: number;
  private readonly chain: Frame[];
  private readonly rules: IndentRules;
  private readonly inner: Frame;
  /** Column of the opening parenthesis of the innermost list. */
  private readonly sexpColumn: number;
  /** Where the line goes unless a rule says otherwise. */
  private normal = 0;
  /** The level of the enclosing call being considered. */
  private level = 0;

  constructor(line: Line) {
    this.text = line.text;
    this.point = line.point;
    this.chain = line.chain;
    this.rules = line.rules;
    this.inner = line.chain[0];
    this.sexpColumn = columnOf(line.text, this.inner.open);
  }

  /** Return the column of the line. */
  run(): number {
    if (this.inner.items.length === 0) return this.sexpColumn + 1;
    this.normal = this.normalIndent();
    const path: number[] = [];
    let calculated: number | undefined;
    let tentative: number | undefined;

    for (
      this.level = 0;
      this.level < Math.min(MAX_DEPTH, this.chain.length) &&
      calculated === undefined;
      this.level++
    ) {
      const frame = this.chain[this.level];
      path.unshift(frame.items.length);
      const head = frame.items[0];
      const name = head && operatorName(this.text, head);
      let method = name === undefined ? undefined : this.rules.lookup(name);
      let guessDef = false;
      if (method === undefined && name !== undefined && path.length === 1) {
        const bare = ruleName(name);
        if (/^def/.test(bare) && !/^(default|definition|definer)/.test(bare)) {
          guessDef = true;
        } else if (/^(with|without|do)-/.test(bare)) {
          method = ["&lambda", "&body"];
        }
      }
      calculated = this.featureIndent() ?? calculated;

      const before = this.text[frame.open - 1];
      if (
        (before === "'" && this.text[frame.open - 2] !== "#") ||
        before === "#"
      ) {
        calculated = this.sexpColumn + 1; // quoted data and vectors
      } else if (method === undefined) {
        if (guessDef) {
          tentative = this.apply(DEFUN, path, 1);
          if (tentative !== undefined) this.normal = tentative;
        } else {
          calculated = this.keywordColumn() ?? calculated;
        }
      } else if (typeof method === "number") {
        calculated = this.counted(method, path);
      } else {
        calculated = this.method(method, path);
      }
    }
    return calculated ?? tentative ?? this.fallback() ?? this.normal;
  }

  /** Return the column a line goes to by default, from the call's items. */
  private normalIndent(): number {
    const { text } = this;
    const items = this.inner.items;
    const head = items[0];
    const last = items[items.length - 1];
    const column = (item: Item): number => columnOf(text, item.start);
    const sameLine = (a: Item, b: Item): boolean =>
      lineStartOf(text, a.start) === lineStartOf(text, b.start);
    if (text[head.start] === "(") return column(head);
    if (sameLine(head, last)) {
      return items.length === 1 ? column(head) : column(items[1]);
    }
    let k = items.length - 1;
    while (k > 0 && sameLine(items[k - 1], last)) k--;
    return column(items[k]);
  }

  /**
   * Return the column for a line that follows a feature expression:
   * under it, so that #+sbcl and the form it guards read as a pair.
   */
  private featureIndent(): number | undefined {
    const { text } = this;
    const items = this.inner.items;
    const last = items[items.length - 1];
    if (last.feature) return columnOf(text, last.start);
    const previous = items[items.length - 2];
    if (!previous?.feature) return undefined;
    let column = columnOf(text, previous.start);
    const line = lineStartOf(text, previous.start);
    for (let k = items.length - 4; k >= 0; k -= 2) {
      const item = items[k];
      if (!item.feature || lineStartOf(text, item.start) !== line) break;
      column = columnOf(text, item.start);
    }
    return column;
  }

  /**
   * Return the column of the first keyword of the keyword arguments
   * before a line that starts with a keyword, so that the pairs of a
   * call without a rule line up.
   */
  private keywordColumn(): number | undefined {
    const { text } = this;
    if (text[this.point] !== ":") return undefined;
    const items = this.inner.items;
    let found: number | undefined;
    for (let k = items.length - 2; k >= 0; k -= 2) {
      if (itemText(text, items[k]).startsWith(":")) {
        found = columnOf(text, items[k].start);
      }
    }
    return found;
  }

  /**
   * Apply a rule that is a number N: N arguments hang 4 columns in, the
   * first form after them is a body and starts 2 columns in, and the
   * rest line up under it.
   */
  private counted(count: number, path: number[]): number {
    if (path.length > 1) return this.normal;
    if (path[0] <= count) return this.sexpColumn + 4;
    if (path[0] === count + 1) return this.sexpColumn + BODY;
    return this.normal;
  }

  /** Apply a rule that is a list or the name of a function. */
  private method(method: Spec, path: number[]): number | undefined {
    if (Array.isArray(method)) return this.apply(method, path, 1);
    if (typeof method === "string") return this.named(method, path);
    return this.normal;
  }

  /**
   * Apply the rule SPEC to a line whose position among the lists around
   * it is PATH, outermost list first. The first number of PATH counts
   * the items before the line in the call, whose operator is item 0
   * when OFFSET is 1; for a list inside an argument it counts from 0.
   */
  private apply(
    spec: Spec[],
    path: number[],
    offset: 0 | 1,
  ): number | undefined {
    const picked = pick(spec, path[0] - offset);
    if (!picked) return this.normal;
    return this.element(picked.element, picked.tail, path);
  }

  /** Apply ELEMENT, a part of a rule, to the line at PATH. */
  private element(
    element: Spec,
    tail: boolean,
    path: number[],
  ): number | undefined {
    const deeper = path.slice(1);
    if (element === null) return this.normal;
    if (typeof element === "number") {
      return deeper.length === 0 ? this.sexpColumn + element : this.normal;
    }
    if (element === "&body") {
      return deeper.length === 0 ? this.sexpColumn + BODY : this.normal;
    }
    if (element === "&lambda") return this.lambda(deeper);
    if (typeof element === "string") return this.named(element, path);

    const whole = element[0] === "&whole";
    const base = whole ? element[1] : null;
    const inside = whole ? element.slice(2) : element;
    if (deeper.length > 0) return this.apply(inside, deeper, 0);
    if (typeof base !== "number") return this.normal;
    if (!tail) return this.sexpColumn + base;
    return /\w/.test(this.text[this.point] ?? "")
      ? this.sexpColumn + base
      : this.normal;
  }

  /**
   * Place a line at the lambda list of a call: a list hangs 4 columns
   * in, anything else is a body, and inside the list the parameters
   * align by the lambda list rules.
   */
  private lambda(deeper: number[]): number {
    if (deeper.length === 0) {
      const end = formEndAt(this.text, this.point);
      const list = end !== undefined && this.text[end - 1] === ")";
      return this.sexpColumn + (list ? 4 : BODY);
    }
    return deeper.length === 1 ? this.lambdaList() : this.normal;
  }

  /**
   * Place a line inside a lambda list: under the first parameter, a
   * lambda list keyword when the line starts with one, and 2 columns in
   * from the last keyword otherwise.
   */
  private lambdaList(): number {
    const { text } = this;
    const frame = this.chain[this.level - 1];
    const start = columnOf(text, frame.open) + 1;
    if (text[this.point] === "&") return start;
    for (let k = frame.items.length - 1; k >= 0; k--) {
      const item = frame.items[k];
      if (text[item.start] === "&") return columnOf(text, item.start) + 2;
    }
    return start;
  }

  /** Apply the rule that is named by NAME to the line at PATH. */
  private named(name: string, path: number[]): number | undefined {
    const frame = this.chain[this.level];
    switch (name) {
      case "tagbody":
        return this.tagbody(path, 3);
      case "do":
        return path[0] >= 3
          ? this.tagbody(path, 2)
          : this.apply(DO_HEAD, path, 1);
      case "defmethod":
        return this.apply(this.methodRule(frame), path, 1);
      case "loop":
        return path.length > 1
          ? this.normal
          : loopIndent(this.text, frame, this.point);
      case "defun":
        return this.apply(DEFUN, path, 1);
      default:
        return this.normal;
    }
  }

  /**
   * Place a line in a tagbody: tags 1 column in, and the forms between
   * them BODY_INDENT columns in.
   */
  private tagbody(path: number[], bodyIndent: number): number {
    if (path.length > 1) return this.normal;
    const tag = /[^\s()"';`,#]/.test(this.text[this.point] ?? "");
    return this.sexpColumn + (tag ? 1 : bodyIndent);
  }

  /**
   * Return the rule for a defmethod: the name and each qualifier hang 4
   * columns in, then comes the lambda list and the body.
   */
  private methodRule(frame: Frame): Spec[] {
    const { text } = this;
    const method = itemText(text, frame.items[0]).toLowerCase() === ":method";
    let skip = method ? 0 : 1;
    for (let k = method ? 1 : 2; k < frame.items.length; k++) {
      if (text[frame.items[k].start] === "(") break;
      skip++;
    }
    return [...Array<Spec>(skip).fill(4), "&lambda", "&body"];
  }

  /**
   * Place a line that no rule has placed, for the cases the usual
   * alignment gets wrong: nothing but a comment after the parenthesis,
   * and a comment after the operator.
   */
  private fallback(): number | undefined {
    const { text } = this;
    const inner = this.inner;
    const open = columnOf(text, inner.open);
    const after = skipBlanks(text, inner.open + 1);
    if (after >= text.length || text[after] === "\n" || text[after] === ";") {
      return open + 1;
    }
    if (inner.items.length >= 2) return columnOf(text, inner.items[1].start);
    const head = inner.items[0];
    const end = skipBlanks(text, head.end);
    return text[end] === ";" ? columnOf(text, head.end) + 1 : undefined;
  }
}

/**
 * Return the column the line that starts at offset LINE_START of TEXT
 * should be indented to, or undefined when it should be left alone,
 * inside a string or a block comment. Lines of ;;; go to the first
 * column, as in Emacs.
 */
export function indentLine(
  text: string,
  lineStart: number,
  rules: IndentRules,
): number | undefined {
  const parsed = parse(text, lineStart);
  if (parsed.inside) return undefined;
  const point = skipBlanks(text, lineStart);
  if (text.startsWith(";;;", point)) return 0;
  if (parsed.chain.length === 0) return 0;
  return new Calculation({ text, point, chain: parsed.chain, rules }).run();
}

/** A line to move to a column. */
export interface LineIndent {
  /** Zero-based line number. */
  line: number;
  /** The number of spaces the line should start with. */
  column: number;
}

/**
 * Return the indentation of lines FIRST to LAST of TEXT, in order, for
 * the lines that need to change. Each line is placed with the lines
 * before it already moved, as an Emacs indent-region does. Lines inside
 * strings are left alone, and so are blank lines unless BLANK is true,
 * as it is for the line a cursor is on: a new line after a form goes to
 * the column where the next form starts.
 */
export function indentRegion(
  text: string,
  first: number,
  last: number,
  rules: IndentRules,
  blank = false,
): LineIndent[] {
  const lines = text.split("\n");
  let working = text;
  let offset = 0;
  for (let n = 0; n < first && n < lines.length; n++) {
    offset += lines[n].length + 1;
  }
  const changes: LineIndent[] = [];
  for (let n = first; n <= last && n < lines.length; n++) {
    const line = lines[n];
    const leading = /^[ \t]*/.exec(line)?.[0].length ?? 0;
    let length = line.length;
    if (blank || line.trim() !== "") {
      const column = indentLine(working, offset, rules);
      if (column !== undefined && !isIndent(line, leading, column)) {
        working =
          working.slice(0, offset) +
          " ".repeat(column) +
          working.slice(offset + leading);
        length += column - leading;
        changes.push({ line: n, column });
      }
    }
    offset += length + 1;
  }
  return changes;
}

/** Return true when the first LEADING characters of LINE are COLUMN spaces. */
function isIndent(line: string, leading: number, column: number): boolean {
  return leading === column && line.slice(0, leading) === " ".repeat(column);
}
