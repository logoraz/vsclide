import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseNotification } from "../base/ide";
import { indentLine, indentRegion } from "../lib/indent";
import { IndentRules, toLiveRules } from "../lib/indent-rules";

/**
 * Return TEXT with every line moved to the indentation the rules give
 * it, starting from none at all.
 */
function reindent(text: string, rules = new IndentRules()): string {
  const lines = text.split("\n").map((line) => line.trimStart());
  const flat = lines.join("\n");
  const out = flat.split("\n");
  for (const { line, column } of indentRegion(
    flat,
    0,
    out.length - 1,
    rules,
  )) {
    out[line] = " ".repeat(column) + out[line];
  }
  return out.join("\n");
}

/** Assert that CODE is already indented the way the rules would. */
function stable(code: string, rules?: IndentRules): void {
  assert.equal(reindent(code, rules), code);
}

test("a defun body is indented 2", () => {
  stable(`(defun foo (x)
  (bar x)
  (baz x))`);
});

test("let bindings line up and the body is indented 2", () => {
  stable(`(let ((a 1)
      (b 2))
  (+ a b))`);
});

test("if hangs the then clause 4 and the else clause 2", () => {
  stable(`(defun f (x)
  (if (> x 0)
      (pos x)
    (neg x)))`);
});

test("when and unless take a body", () => {
  stable(`(when ok
  (do-it)
  (more))
(unless ok
  (fail))`);
});

test("cond clauses line up", () => {
  stable(`(cond ((a) 1)
      ((b)
       2)
      (t 3))`);
});

test("arguments align under the first argument", () => {
  stable(`(foo a
     b
     c)`);
});

test("arguments on following lines align under the operator", () => {
  stable(`(foo
 a
 b)`);
});

test("keyword arguments line up under the first keyword", () => {
  stable(`(make-thing :a 1
            :b 2
            :c 3)`);
});

test("handler-case clauses and their bodies", () => {
  stable(`(handler-case (foo)
  (error (e)
    (bar e)))`);
});

test("defmethod counts its qualifiers", () => {
  stable(`(defmethod area :around ((s shape))
  (call-next-method))`);
});

test("quoted lists align under their first element", () => {
  stable(`(foo '(a
       b))`);
});

test("defclass slots and options", () => {
  stable(`(defclass foo (bar)
  ((x :initarg :x)
   (y :initarg :y))
  (:documentation "d"))`);
});

test("flet functions", () => {
  stable(`(flet ((helper (x)
         (1+ x)))
  (helper 1))`);
});

test("do has its own head and body", () => {
  stable(`(do ((i 0 (1+ i)))
    ((= i 3))
  (print i))`);
});

test("lambda lists hang parameters from their keywords", () => {
  stable(`(defun foo (a &optional b
                c
            &key d)
  nil)`);
});

test("with- and do- forms without a rule take a lambda and a body", () => {
  stable(`(with-open-file (s "f")
  (read s))
(do-things (x xs)
  (print x))`);
});

test("def forms without a rule are indented like defun", () => {
  stable(`(deftest foo ()
  (check 1))`);
});

test("a line after a feature expression lines up under it", () => {
  stable(`(defun f ()
  #+sbcl
  (foo)
  (bar))`);
});

test("lines of three semicolons go to the first column", () => {
  assert.equal(
    reindent(`(defun f ()
;;; note
  nil)`),
    `(defun f ()
;;; note
  nil)`,
  );
});

test("loop aligns its clauses with the first", () => {
  stable(`(defun f (xs)
  (loop for x in xs
        when (foo x)
          collect x
        finally (return 1)))`);
});

test("loop parts hang under their clause", () => {
  stable(`(loop for i = 0
        then (1+ i)
      while (< i 10))`);
});

test("loop body forms line up under the first", () => {
  stable(`(loop for x in xs
      do (foo x)
         (bar x)
      finally (return 1))`);
});

test("loop and aligns with the clause it continues", () => {
  stable(`(loop for a in as
      and b in bs
      collect (list a b))`);
});

test("a simple loop is indented like a call", () => {
  stable(`(loop (foo)
      (bar))`);
});

test("lines inside strings and block comments are left alone", () => {
  const code = `(defun f ()
  "doc
   more"
  #| a
 b |#
  nil)`;
  assert.deepEqual(
    indentRegion(code, 0, code.split("\n").length - 1, new IndentRules()),
    [],
  );
  const start = code.indexOf("   more");
  assert.equal(indentLine(code, start, new IndentRules()), undefined);
});

test("text after an unfinished form still indents", () => {
  const code = "(defun f (x)\n  (let ((y 1))\n";
  assert.equal(indentLine(code, code.length, new IndentRules()), 4);
});

test("top-level forms start in the first column", () => {
  assert.equal(indentLine("(a)\n", 4, new IndentRules()), 0);
});

test("rules from the image apply to macros the table lacks", () => {
  const rules = new IndentRules();
  rules.update(
    toLiveRules([{ name: "with-widget", spec: 1, packages: ["APP"] }]),
  );
  stable(`(with-widget (w 1)
  (draw w))`, rules);
  assert.equal(rules.size, 1);
});

test("the image's rule beats the table's", () => {
  const rules = new IndentRules();
  rules.update(toLiveRules([{ name: "when", spec: 3, packages: ["APP"] }]));
  assert.equal(
    reindent("(when a b\nc)", rules),
    "(when a b\n    c)",
  );
});

test("a symbol with several rules uses the current package's", () => {
  let current = "ONE";
  const rules = new IndentRules(() => current);
  rules.update(
    toLiveRules([
      { name: "frob", spec: 1, packages: ["ONE"] },
      { name: "frob", spec: [4, "&body"], packages: ["TWO"] },
    ]),
  );
  assert.equal(reindent("(frob a\nb)", rules), "(frob a\n  b)");
  current = "TWO";
  assert.equal(reindent("(frob a\nb)", rules), "(frob a\n  b)");
});

test("lisp rules in lower or upper case and with prefixes", () => {
  const rules = new IndentRules();
  rules.update(
    toLiveRules([{ name: "App:With-Thing", spec: ["&BODY"], packages: [] }]),
  );
  assert.equal(reindent("(with-thing\nx)", rules), "(with-thing\n  x)");
});

test("malformed rules are dropped", () => {
  assert.deepEqual(toLiveRules("x"), []);
  assert.deepEqual(
    toLiveRules([{ name: 1, spec: 1 }, { name: "a", spec: { b: 1 } }]),
    [],
  );
});

test("clide's indentation notification becomes an event", () => {
  const event = parseNotification("ide/indentation", {
    rules: [
      {
        name: "with-lock-held",
        spec: [["&whole", 4, 1, "&rest", 1], "&body"],
        packages: ["BT2"],
      },
      { name: "broken", spec: { no: 1 }, packages: [] },
    ],
  });
  assert.deepEqual(event, {
    type: "indentation",
    rules: [
      {
        name: "with-lock-held",
        spec: [["&whole", 4, 1, "&rest", 1], "&body"],
        packages: ["BT2"],
      },
    ],
  });
});

test("a spec from slynk with a destructuring head indents", () => {
  const rules = new IndentRules();
  rules.update(
    toLiveRules([
      {
        name: "with-lock-held",
        spec: [["&whole", 4, 1, "&rest", 1], "&body"],
        packages: ["BT2"],
      },
    ]),
  );
  stable(`(with-lock-held (lock)
  (work)
  (more))`, rules);
});

test("a blank line is placed when asked, as after Enter", () => {
  const rules = new IndentRules();
  assert.deepEqual(indentRegion("(if test\n  ", 1, 1, rules, true), [
    { line: 1, column: 4 },
  ]);
  assert.deepEqual(indentRegion("(a (b))\n  ", 1, 1, rules, true), [
    { line: 1, column: 0 },
  ]);
  assert.deepEqual(indentRegion("(if test\n  ", 1, 1, rules), []);
});
