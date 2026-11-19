import { topLevelFormAt } from "./forms";

/** The call the cursor is in, found from the text alone. */
export interface CallContext {
  /** The operator as written, such as "cl:mapcar". */
  operator: string;
  /** The arguments written before the cursor's, as text. */
  before: string[];
  /** Zero-based position of the argument the cursor is in or at. */
  index: number;
}

/** One frame of the scan: a list that is still open. */
interface Frame {
  /** Start offsets of the items so far; the head comes first. */
  starts: number[];
  /** End offsets of the items, or undefined while one is open. */
  ends: (number | undefined)[];
  /** True inside quoted data, where no call is made. */
  quoted: boolean;
}

const SPACE = /\s/;
const BREAKS = new Set(["(", ")", '"', "'", ";", "`", ","]);

/** Return true when CHAR may be part of a symbol. */
function constituent(char: string): boolean {
  return !SPACE.test(char) && !BREAKS.has(char);
}

/** Return true when TOKEN can name an operator. */
function operatorName(token: string): boolean {
  return /^[^\d:#|'"`,.()][^\s()]*$/.test(token) || /^\|.+\|$/.test(token);
}

/**
 * Return the call the cursor at OFFSET is in: the operator of the
 * nearest enclosing list that is a call, and which argument the cursor
 * is at. Lists whose head is not a symbol, such as the bindings of a
 * let, defer to the list around them, and quoted data is no call. It
 * returns undefined in strings, comments and outside any list.
 */
export function callAt(text: string, offset: number): CallContext | undefined {
  const top = topLevelFormAt(text, offset);
  if (!top || top.start >= offset) return undefined;
  const frames: Frame[] = [];
  let i = top.start;
  const stop = Math.min(offset, text.length);

  /** Note that an item starts at START in the innermost frame. */
  const begin = (start: number): void => {
    const frame = frames[frames.length - 1];
    if (!frame) return;
    frame.starts.push(start);
    frame.ends.push(undefined);
  };
  /** Note that the item open in the innermost frame ends at END. */
  const finish = (end: number): void => {
    const frame = frames[frames.length - 1];
    if (!frame) return;
    frame.ends[frame.ends.length - 1] = end;
  };

  while (i < stop) {
    const char = text[i];
    if (SPACE.test(char)) {
      i++;
    } else if (char === ";") {
      const newline = text.indexOf("\n", i);
      if (newline < 0 || newline >= stop) return undefined;
      i = newline + 1;
    } else if (char === "#" && text[i + 1] === "|") {
      const close = text.indexOf("|#", i + 2);
      if (close < 0 || close + 2 > stop) return undefined;
      i = close + 2;
    } else if (char === '"') {
      begin(i);
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      if (j >= stop) return undefined;
      i = j + 1;
      finish(i);
    } else if (char === "(") {
      const before = text[i - 1];
      const parent = frames[frames.length - 1];
      begin(i);
      frames.push({
        starts: [],
        ends: [],
        quoted:
          (parent?.quoted ?? false) ||
          before === "`" ||
          (before === "'" && text[i - 2] !== "#") ||
          (before === "#" && text[i - 2] !== "'"),
      });
      i++;
    } else if (char === ")") {
      if (frames.length === 0) return undefined;
      frames.pop();
      finish(i + 1);
      i++;
    } else if (char === "'" || char === "`" || char === ",") {
      i++;
    } else {
      begin(i);
      let j = i;
      while (j < stop && (constituent(text[j]) || text[j] === "\\")) {
        j += text[j] === "\\" ? 2 : 1;
      }
      i = Math.min(Math.max(j, i + 1), stop);
      finish(i);
    }
  }

  // Walk outward from the innermost list to the nearest call.
  for (let depth = frames.length - 1; depth >= 0; depth--) {
    const frame = frames[depth];
    if (frame.quoted) return undefined;
    if (frame.starts.length === 0) continue;
    const last = frame.starts.length - 1;
    const inner = depth === frames.length - 1;
    const touching = inner && frame.ends[last] === stop;
    // The item the cursor is in, or the one it would start.
    const current = inner && !touching ? frame.starts.length : last;
    if (current === 0) {
      if (inner) return undefined;
      continue;
    }
    const head = text.slice(frame.starts[0], frame.ends[0] ?? stop);
    if (!operatorName(head)) continue;
    const before: string[] = [];
    for (let k = 1; k < current; k++) {
      before.push(text.slice(frame.starts[k], frame.ends[k] ?? stop));
    }
    return { operator: head, before, index: current - 1 };
  }
  return undefined;
}

/** What section of a lambda list a parameter belongs to. */
export type Section = "required" | "optional" | "key" | "rest" | "aux";

/** A parameter of a lambda list. */
export interface Parameter {
  /** Where it is in the lambda list text: start inclusive, end exclusive. */
  start: number;
  end: number;
  section: Section;
  /** The name that matters: the variable, or the keyword for a key. */
  name: string;
}

/**
 * Return the parameters of LAMBDA_LIST, a printed lambda list such as
 * "(A &OPTIONAL (B 1) &KEY C)", with where each is written. The lambda
 * list keywords are not parameters; they set the section of the ones
 * after them. Returns an empty list for text that is not a list.
 */
export function parseLambdaList(lambdaList: string): Parameter[] {
  const params: Parameter[] = [];
  const text = lambdaList;
  let i = text.indexOf("(");
  if (i < 0) return params;
  i++;
  let section: Section = "required";
  while (i < text.length && text[i] !== ")") {
    if (SPACE.test(text[i])) {
      i++;
      continue;
    }
    const start = i;
    if (text[i] === "(") {
      let depth = 0;
      do {
        if (text[i] === "(") depth++;
        else if (text[i] === ")") depth--;
        i++;
      } while (i < text.length && depth > 0);
    } else {
      while (i < text.length && !SPACE.test(text[i]) && text[i] !== ")") i++;
    }
    const item = text.slice(start, i);
    const lower = item.toLowerCase();
    if (lower === "&optional") section = "optional";
    else if (lower === "&key") section = "key";
    else if (lower === "&rest" || lower === "&body") section = "rest";
    else if (lower === "&aux") section = "aux";
    else if (lower.startsWith("&")) continue;
    else params.push({ start, end: i, section, name: parameterName(item) });
  }
  return params;
}

/** Return the name of the parameter written ITEM. */
function parameterName(item: string): string {
  const inner = item.replace(/^\(+\s*/, "");
  const keyword = /^:([^\s()]+)/.exec(inner);
  if (keyword) return keyword[1].toLowerCase();
  const atom = /^[^\s()]+/.exec(inner);
  return (atom ? atom[0] : item).toLowerCase();
}

/**
 * Return the index into PARAMS of the parameter the argument at INDEX
 * is for, or -1 when it is for none. BEFORE is the text of the
 * arguments written before it, which tell the keyword a key's value
 * follows.
 */
export function activeParameter(
  params: Parameter[],
  index: number,
  before: string[],
): number {
  const positional = params.filter(
    (p) => p.section === "required" || p.section === "optional",
  ).length;
  if (index < positional) return index;
  const rest = params.findIndex((p) => p.section === "rest");
  const firstKey = params.findIndex((p) => p.section === "key");
  if (firstKey >= 0) {
    const previous = before[index - 1] ?? "";
    if (previous.startsWith(":")) {
      const wanted = previous.slice(1).toLowerCase();
      const found = params.findIndex(
        (p) => p.section === "key" && p.name === wanted,
      );
      if (found >= 0) return found;
    }
  }
  return rest;
}

/** What VS Code needs to show a signature. */
export interface Signature {
  label: string;
  /** Start and end of each parameter in label. */
  ranges: [number, number][];
  /** Index into ranges of the active parameter, or -1. */
  active: number;
}

/**
 * Return LAMBDA_LIST without its first element when that is the name of
 * OPERATOR, as slynk prints it: "(MAPCAR FUNCTION LIST)". A package
 * prefix on OPERATOR, as written in the call, does not matter.
 */
export function withoutOperator(
  operator: string,
  lambdaList: string,
): string {
  const head = /^\s*\(\s*([^\s()]+)/.exec(lambdaList);
  const name = operator.replace(/^.*:/, "").toLowerCase();
  if (!head || head[1].replace(/^.*:/, "").toLowerCase() !== name) {
    return lambdaList;
  }
  return "(" + lambdaList.slice(head[0].length);
}

/**
 * Build the signature of OPERATOR with LAMBDA_LIST, which may start
 * with the operator's name, for the call at INDEX, with BEFORE the
 * arguments already written.
 */
export function signatureFor(
  operator: string,
  printed: string,
  index: number,
  before: string[],
): Signature {
  const lambdaList = withoutOperator(operator, printed);
  const params = parseLambdaList(lambdaList);
  const open = lambdaList.indexOf("(");
  if (open < 0) return { label: `(${operator})`, ranges: [], active: -1 };
  const close = lambdaList.lastIndexOf(")");
  const inner = lambdaList.slice(open + 1, close);
  const trimmedStart = open + 1 + inner.length - inner.trimStart().length;
  const prefix = inner.trim() ? `(${operator} ` : `(${operator}`;
  const shift = prefix.length - trimmedStart;
  const label = `${prefix}${inner.trim()})`;
  return {
    label,
    ranges: params.map((p) => [p.start + shift, p.end + shift]),
    active: activeParameter(params, index, before),
  };
}
