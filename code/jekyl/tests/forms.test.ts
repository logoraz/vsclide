import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  Range,
  formBefore,
  packageAt,
  scanForms,
  topLevelFormAt,
} from "../lib/forms";

/** Return the text a range covers, or undefined for no range. */
function slice(text: string, range: Range | undefined): string | undefined {
  return range && text.slice(range.start, range.end);
}

/** Return the top-level forms of TEXT as strings. */
function tops(text: string): string[] {
  return scanForms(text).top.map((range) => text.slice(range.start, range.end));
}

test("scan finds top-level forms and skips comments", () => {
  const text = "(a b) ; (c)\n(d) #| (e) |# f";
  assert.deepEqual(tops(text), ["(a b)", "(d)", "f"]);
});

test("scan ignores parentheses in strings", () => {
  const text = '(print "a ) \\" (") (next)';
  assert.deepEqual(tops(text), ['(print "a ) \\" (")', "(next)"]);
});

test("scan knows character literals", () => {
  const text = "(list #\\( #\\) #\\Space #\;) (b)";
  assert.deepEqual(tops(text), ["(list #\\( #\\) #\\Space #\;)", "(b)"]);
});

test("scan knows |symbols| and nested block comments", () => {
  const text = "(a |b ) c| d) #| x #| y |# z |# (e)";
  assert.deepEqual(tops(text), ["(a |b ) c| d)", "(e)"]);
});

test("a reader macro belongs to the form it precedes", () => {
  assert.deepEqual(tops("'(a b) `(c ,d ,@e) #'f #(1 2)"), [
    "'(a b)",
    "`(c ,d ,@e)",
    "#'f",
    "#(1 2)",
  ]);
});

test("feature expressions cover the form they guard", () => {
  assert.deepEqual(tops("#+sbcl (foo) #-(or ecl ccl) (bar) (baz)"), [
    "#+sbcl (foo)",
    "#-(or ecl ccl) (bar)",
    "(baz)",
  ]);
});

test("other dispatch forms", () => {
  assert.deepEqual(tops('#P"a/b" #.(+ 1 2) #xFF #:sym #2A((1 2))'), [
    '#P"a/b"',
    "#.(+ 1 2)",
    "#xFF",
    "#:sym",
    "#2A((1 2))",
  ]);
});

test("an open list ends at the end of the text", () => {
  assert.deepEqual(tops("(a (b c"), ["(a (b c"]);
  assert.deepEqual(tops('(a "open'), ['(a "open']);
});

test("a stray close parenthesis is skipped", () => {
  assert.deepEqual(tops("(a)) (b)"), ["(a)", "(b)"]);
});

test("empty and blank text have no forms", () => {
  assert.deepEqual(tops(""), []);
  assert.deepEqual(tops("  ; just a comment\n"), []);
});

const SOURCE = "(defun a ()\n  1)\n\n(defun b ()\n  (a))\n";

test("top-level form: inside", () => {
  const offset = SOURCE.indexOf("(a))") + 1;
  assert.equal(
    slice(SOURCE, topLevelFormAt(SOURCE, offset)),
    "(defun b ()\n  (a))",
  );
});

test("top-level form: just after the closing parenthesis", () => {
  const offset = SOURCE.indexOf("1)") + 2;
  assert.equal(
    slice(SOURCE, topLevelFormAt(SOURCE, offset)),
    "(defun a ()\n  1)",
  );
});

test("top-level form: at the start of the next form", () => {
  const offset = SOURCE.indexOf("(defun b");
  assert.equal(
    slice(SOURCE, topLevelFormAt(SOURCE, offset)),
    "(defun b ()\n  (a))",
  );
});

test("top-level form: between forms prefers the one before", () => {
  const offset = SOURCE.indexOf("\n\n(defun b") + 1;
  assert.equal(
    slice(SOURCE, topLevelFormAt(SOURCE, offset)),
    "(defun a ()\n  1)",
  );
});

test("top-level form: before the first form takes the first", () => {
  const text = "; header\n(a)";
  assert.equal(slice(text, topLevelFormAt(text, 2)), "(a)");
});

test("top-level form: none in empty text", () => {
  assert.equal(topLevelFormAt("", 0), undefined);
});

test("form before: after an inner list", () => {
  const text = "(+ 1 (* 2 3)) (x)";
  const offset = text.indexOf("(* 2 3)") + "(* 2 3)".length;
  assert.equal(slice(text, formBefore(text, offset)), "(* 2 3)");
});

test("form before: after the outer close takes the whole list", () => {
  const text = "(+ 1 (* 2 3)) (x)";
  const offset = text.indexOf(") (x)") + 1;
  assert.equal(slice(text, formBefore(text, offset)), "(+ 1 (* 2 3))");
});

test("form before: after an atom, with space between", () => {
  const text = "(f alpha  )";
  const offset = text.indexOf("alpha") + "alpha".length + 2;
  assert.equal(slice(text, formBefore(text, offset)), "alpha");
});

test("form before: a quote belongs to the form", () => {
  const text = "(list '(a b))";
  const offset = text.indexOf("(a b)") + "(a b)".length;
  assert.equal(slice(text, formBefore(text, offset)), "'(a b)");
});

test("form before: nothing before the first form", () => {
  assert.equal(formBefore("  (a)", 1), undefined);
});

test("package: symbol, keyword, uninterned and string designators", () => {
  const forms: [string, string][] = [
    ["(in-package :my-pkg)", "MY-PKG"],
    ["(in-package #:other)", "OTHER"],
    ["(in-package cl-user)", "CL-USER"],
    ['(in-package "Mixed")', "Mixed"],
    ["(cl:in-package :qualified)", "QUALIFIED"],
    ["(IN-PACKAGE :Shouting)", "SHOUTING"],
  ];
  for (const [form, name] of forms) {
    const text = `${form}\n(foo)`;
    assert.equal(packageAt(text, text.length), name, form);
  }
});

test("package: the last one before the cursor wins", () => {
  const text = "(in-package :one)\n(a)\n(in-package :two)\n(b)";
  assert.equal(packageAt(text, text.indexOf("(a)")), "ONE");
  assert.equal(packageAt(text, text.indexOf("(b)")), "TWO");
});

test("package: none before the first in-package or in other forms", () => {
  const text = "(foo (in-package :nested))\n(in-package :late)";
  assert.equal(packageAt(text, text.indexOf("(in-package :late)")), undefined);
  assert.equal(packageAt("", 0), undefined);
});
