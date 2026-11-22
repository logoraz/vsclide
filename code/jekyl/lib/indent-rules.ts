/*
 * Indentation rules for Common Lisp operators.
 *
 * A rule, called a spec here, says how the lines of a call to one
 * operator are indented. The format is the one slynk sends for macros
 * it finds in the image, so the same interpreter serves the table
 * below and the rules that arrive from the running Lisp:
 *
 *   N                   the first N arguments hang 4 columns in; the
 *                       rest are a body, 2 columns in
 *   [e0, e1, ...]       element I rules argument I
 *   null                align like an ordinary call
 *   K                   indent K columns from the opening parenthesis
 *   "&lambda"           a lambda list, then the body
 *   "&body"             the rest are a body, 2 columns in
 *   "&rest"             the element after it rules all remaining ones
 *   ["&whole", K, ...]  the argument is a list; K indents the list, and
 *                       the elements after K rule the items inside it
 *   "tagbody" and kin   a named function in indent.ts
 *
 * Offsets are measured from the opening parenthesis of the innermost
 * list that holds the line being indented.
 */

/** One indentation spec; see the table above. */
export type Spec = number | string | null | Spec[];

/** What the running Lisp says about one symbol. */
export interface LiveRule {
  /** The symbol name, lower case, without a package prefix. */
  name: string;
  /** How its calls are indented. */
  spec: Spec;
  /** The packages that name the symbol. */
  packages: string[];
}

const DEFUN: Spec = [4, "&lambda", "&body"];
const DEFVAR: Spec = [4, 2, 2];
const CASE: Spec = [4, "&rest", ["&whole", 2, "&rest", 1]];
const FLET: Spec = [
  ["&whole", 4, "&rest", ["&whole", 1, 4, "&lambda", "&body"]],
  "&body",
];
const HANDLER_CASE: Spec = [4, "&rest", ["&whole", 2, "&lambda", "&body"]];
const LET: Spec = [["&whole", 4, "&rest", ["&whole", 1, 1, 2]], "&body"];
const DEFCLASS: Spec = [
  6,
  ["&whole", 4, "&rest", 1],
  ["&whole", 2, "&rest", 1],
  ["&whole", 2, "&rest", 1],
];
const MULTIPLE_VALUE_BIND: Spec = [["&whole", 6, "&rest", 1], 4, "&body"];
const DOLIST: Spec = [["&whole", 4, 2, 1], "&body"];

/** The rules for the standard operators, from Common Lisp style. */
export const STANDARD: ReadonlyMap<string, Spec> = new Map<string, Spec>([
  ["block", 1],
  ["case", CASE],
  ["ccase", CASE],
  ["ecase", CASE],
  ["typecase", CASE],
  ["ctypecase", CASE],
  ["etypecase", CASE],
  ["catch", 1],
  ["cond", ["&rest", ["&whole", 2, "&rest", null]]],
  [":constructor", [4, "&lambda"]],
  ["defvar", DEFVAR],
  ["defparameter", DEFVAR],
  ["defconstant", DEFVAR],
  ["defclass", DEFCLASS],
  ["define-condition", DEFCLASS],
  ["defun", DEFUN],
  ["defmacro", DEFUN],
  ["defgeneric", DEFUN],
  ["defsubst", DEFUN],
  ["deftype", DEFUN],
  ["define-modify-macro", DEFUN],
  ["define-compiler-macro", DEFUN],
  ["define-setf-expander", DEFUN],
  ["defmethod", "defmethod"],
  [":method", "defmethod"],
  ["defpackage", [4, 2]],
  [
    "defstruct",
    [
      ["&whole", 4, "&rest", ["&whole", 2, "&rest", 1]],
      "&rest",
      ["&whole", 2, "&rest", 1],
    ],
  ],
  ["destructuring-bind", ["&lambda", 4, "&body"]],
  ["do", "do"],
  ["do*", "do"],
  ["dolist", DOLIST],
  ["dotimes", DOLIST],
  ["eval-when", 1],
  ["flet", FLET],
  ["labels", FLET],
  ["macrolet", FLET],
  ["generic-flet", FLET],
  ["generic-labels", FLET],
  ["handler-case", HANDLER_CASE],
  ["restart-case", HANDLER_CASE],
  ["if", [4, 4, "&body"]],
  ["ignore-errors", 0],
  ["lambda", ["&lambda", "&body"]],
  ["named-lambda", [4, "&lambda", "&body"]],
  ["let", LET],
  ["let*", LET],
  ["handler-bind", LET],
  ["restart-bind", LET],
  ["symbol-macrolet", LET],
  ["locally", 1],
  ["loop", "loop"],
  ["multiple-value-bind", MULTIPLE_VALUE_BIND],
  ["multiple-value-call", [4, "&body"]],
  ["multiple-value-prog1", 1],
  ["multiple-value-setq", [4, 2]],
  ["pprint-logical-block", [4, 2]],
  ["print-unreadable-object", [["&whole", 4, 1, "&rest", 1], "&body"]],
  ["prog", ["&lambda", "&rest", "tagbody"]],
  ["prog*", ["&lambda", "&rest", "tagbody"]],
  ["prog1", 1],
  ["prog2", 2],
  ["progn", 0],
  ["progv", [4, 4, "&body"]],
  ["return", 0],
  ["return-from", [null, "&body"]],
  ["tagbody", "tagbody"],
  ["throw", 1],
  ["unless", 1],
  ["unwind-protect", [5, "&body"]],
  ["when", 1],
  ["with-slots", MULTIPLE_VALUE_BIND],
  ["with-accessors", MULTIPLE_VALUE_BIND],
  ["with-condition-restarts", MULTIPLE_VALUE_BIND],
  ["with-compilation-unit", [["&whole", 4, "&rest", 1], "&body"]],
  ["with-output-to-string", [4, 2]],
  ["with-standard-io-syntax", [2]],
]);

/**
 * Return the name of an operator as the rules know it: lower case and
 * without a package prefix, so cl:LOOP and loop are one operator.
 */
export function ruleName(written: string): string {
  const lower = written.toLowerCase();
  const colon = lower.lastIndexOf(":");
  return colon > 0 ? lower.slice(colon + 1) : lower;
}

/**
 * Return VALUE as a Spec, or undefined when it is not one. Strings are
 * lower-cased, since slynk sends lambda-list keywords in either case.
 */
export function toSpec(value: unknown): Spec | undefined {
  if (value === null || typeof value === "number") return value;
  if (typeof value === "string") return value.toLowerCase();
  if (!Array.isArray(value)) return undefined;
  const spec: Spec[] = [];
  for (const element of value) {
    const converted = toSpec(element);
    if (converted === undefined) return undefined;
    spec.push(converted);
  }
  return spec;
}

/**
 * Return the rules in VALUE, an array of {name, spec, packages} as
 * jekyl receives it from clide; entries that are malformed are dropped.
 */
export function toLiveRules(value: unknown): LiveRule[] {
  if (!Array.isArray(value)) return [];
  const rules: LiveRule[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const { name, spec, packages } = entry as Record<string, unknown>;
    const converted = toSpec(spec);
    if (typeof name !== "string" || converted === undefined) continue;
    rules.push({
      name: ruleName(name),
      spec: converted,
      packages: Array.isArray(packages)
        ? packages.filter((p): p is string => typeof p === "string")
        : [],
    });
  }
  return rules;
}

/**
 * The rules in force: what the running Lisp has told us, over the
 * standard table. The Lisp knows only symbols outside COMMON-LISP and
 * only those that are loaded, so a user's macros gain their rules when
 * their file is loaded and the table is refreshed.
 */
export class IndentRules {
  /** What each connection's Lisp has said, by connection id. */
  private readonly lives = new Map<number, Map<string, LiveRule[]>>();
  private selected = 0;

  /** The rules of the selected connection. */
  private get live(): Map<string, LiveRule[]> {
    return this.of(this.selected);
  }

  private of(id: number): Map<string, LiveRule[]> {
    let rules = this.lives.get(id);
    if (!rules) {
      rules = new Map();
      this.lives.set(id, rules);
    }
    return rules;
  }

  /**
   * CURRENT names the package of the file being indented, used to pick
   * between rules for one symbol that differ from package to package.
   */
  constructor(
    private readonly current: () => string | undefined = () => undefined,
  ) {}

  /**
   * Use the rules of connection ID from now on; undefined selects none,
   * so the table alone applies. A tool with a single image never calls
   * this, and its rules are those of id 0.
   */
  select(id: number | undefined): void {
    this.selected = id ?? -1;
  }

  /**
   * Take RULES from the Lisp of connection ID, the selected one if not
   * given; a symbol seen again is replaced.
   */
  update(rules: LiveRule[], id: number = this.selected): void {
    const live = this.of(id);
    for (const rule of rules) {
      const known = live.get(rule.name) ?? [];
      const same = known.findIndex(
        (other) => JSON.stringify(other.spec) === JSON.stringify(rule.spec),
      );
      if (same >= 0) {
        known[same] = rule;
      } else {
        known.push(rule);
      }
      live.set(rule.name, known);
    }
  }

  /**
   * Forget everything the Lisp of connection ID, the selected one if
   * not given, has said, for instance on reconnect.
   */
  clear(id: number = this.selected): void {
    this.lives.delete(id);
  }

  /** Return whether the Lisp has given a rule for NAME, as written. */
  hasLive(written: string): boolean {
    return this.live.has(ruleName(written));
  }

  /** Return how many symbols the Lisp has given rules for. */
  get size(): number {
    return this.live.size;
  }

  /**
   * Return the spec for the operator WRITTEN, or undefined when none is
   * known. The Lisp's word wins over the table; when it names several
   * rules, the one for the current package, else the most widely
   * visible one.
   */
  lookup(written: string): Spec | undefined {
    const name = ruleName(written);
    const known = this.live.get(name);
    if (known && known.length > 0) return this.choose(known);
    return STANDARD.get(name);
  }

  /** Pick the rule of KNOWN that suits the current package. */
  private choose(known: LiveRule[]): Spec {
    const first = known[0];
    if (known.length === 1) return first.spec;
    const current = this.current()?.toUpperCase();
    let best = first;
    for (const rule of known) {
      if (current && rule.packages.some((p) => p.toUpperCase() === current)) {
        return rule.spec;
      }
      if (rule.packages.length > best.packages.length) best = rule;
    }
    return best.spec;
  }
}
