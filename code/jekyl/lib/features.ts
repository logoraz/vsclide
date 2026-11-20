/*
 * Reader feature expressions, as `#+` and `#-` read them.
 *
 * The truth of a feature comes from the running Lisp: its *features*
 * list, which slynk reports on connecting and again when it changes.
 * With no Lisp to ask, a few features are known and the rest are not;
 * an expression that cannot be decided has no truth value, and nothing
 * it guards is suppressed.
 */

/** True, false, or undefined when it cannot be known. */
export type Truth = boolean | undefined;

/** Features every conforming implementation has. */
const FALLBACK = new Set(["common-lisp", "ansi-cl"]);

/** Return NAME lower-cased, without a leading colon or package. */
function featureName(name: string): string {
  const lower = name.toLowerCase();
  const colon = lower.lastIndexOf(":");
  return colon >= 0 ? lower.slice(colon + 1) : lower;
}

/** Split TEXT into parentheses and atoms. */
function tokens(text: string): string[] {
  return text.match(/[()]|[^\s()]+/g) ?? [];
}

/** The features of a Lisp image, and a way to test expressions. */
export class Features {
  private names: Set<string> | undefined;

  /** Take NAMES as the features of the image now connected. */
  set(names: string[]): void {
    this.names = new Set(names.map(featureName));
  }

  /** Forget the image; the fallback applies again. */
  clear(): void {
    this.names = undefined;
  }

  /** Return whether an image has reported its features. */
  get known(): boolean {
    return this.names !== undefined;
  }

  /** Return the truth of the feature NAME. */
  has(name: string): Truth {
    const n = featureName(name);
    if (this.names) return this.names.has(n);
    if (n === "nil") return false;
    return FALLBACK.has(n) ? true : undefined;
  }

  /**
   * Return the truth of EXPRESSION, the text of a feature expression:
   * a name, or a list headed by and, or, or not. A form that is not
   * one has no truth value.
   */
  test(expression: string): Truth {
    const list = tokens(expression);
    const [value, next] = this.read(list, 0);
    return next === list.length ? value : undefined;
  }

  /** Evaluate the expression of LIST at I; return its truth and end. */
  private read(list: string[], i: number): [Truth, number] {
    const token = list[i];
    if (token === undefined || token === ")") return [undefined, i + 1];
    if (token !== "(") return [this.has(token), i + 1];
    const operator = featureName(list[i + 1] ?? "");
    const values: Truth[] = [];
    let j = i + 2;
    while (j < list.length && list[j] !== ")") {
      const [value, end] = this.read(list, j);
      values.push(value);
      j = end;
    }
    return [this.combine(operator, values), j + 1];
  }

  /** Apply the operator OP to VALUES, in three-valued logic. */
  private combine(op: string, values: Truth[]): Truth {
    if (op === "not") {
      return values.length === 1 && values[0] !== undefined
        ? !values[0]
        : undefined;
    }
    if (op === "and") {
      if (values.includes(false)) return false;
      return values.includes(undefined) ? undefined : true;
    }
    if (op === "or") {
      if (values.includes(true)) return true;
      return values.includes(undefined) ? undefined : false;
    }
    return undefined;
  }
}
