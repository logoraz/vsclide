import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseNotification } from "../base/ide";
import { Features } from "../lib/features";
import { byLine, scan } from "../lib/highlight";

/** Return the text of each span that SCAN finds in TEXT. */
function found(
  text: string,
  macros: string[],
  features = new Features(),
): string[] {
  return scan(text, (name) => macros.includes(name), features).map(
    (span) => `${span.kind}:${text.slice(span.start, span.end)}`,
  );
}

test("a loaded macro is found at the head of a call", () => {
  assert.deepEqual(found("(my-with (x) (my-with y))", ["my-with"]), [
    "macro:my-with",
    "macro:my-with",
  ]);
});

test("a package prefix does not hide a macro", () => {
  assert.deepEqual(found("(pkg:my-with x)", ["my-with"]), [
    "macro:pkg:my-with",
  ]);
});

test("quoted data, strings and comments hold no calls", () => {
  const text = `'(my-with x) "(my-with)" ; (my-with)\n#| (my-with) |#`;
  assert.deepEqual(found(text, ["my-with"]), []);
});

test("a macro that is not at the head is not a call", () => {
  assert.deepEqual(found("(f my-with)", ["my-with"]), []);
});

test("backquoted code is still code", () => {
  assert.deepEqual(found("`(progn ,(my-with x))", ["my-with"]), [
    "macro:my-with",
  ]);
});

test("features come from the image", () => {
  const features = new Features();
  features.set(["sbcl", "x86-64", "common-lisp"]);
  assert.deepEqual(found("#+sbcl (a) #-sbcl (b)", [], features), [
    "suppressed:#-sbcl (b)",
  ]);
  assert.deepEqual(found("#+(and sbcl ccl) a #+(or ccl ecl) b", [], features), [
    "suppressed:#+(and sbcl ccl) a",
    "suppressed:#+(or ccl ecl) b",
  ]);
  assert.deepEqual(found("#+(not sbcl) (a)", [], features), [
    "suppressed:#+(not sbcl) (a)",
  ]);
});

test("without an image only what is certain is suppressed", () => {
  assert.deepEqual(found("#+nil (a) #+sbcl (b) #-sbcl (c)", []), [
    "suppressed:#+nil (a)",
  ]);
  assert.deepEqual(found("#+(or) (a) #-(and) (b) #-common-lisp (c)", []), [
    "suppressed:#+(or) (a)",
    "suppressed:#-(and) (b)",
    "suppressed:#-common-lisp (c)",
  ]);
  assert.deepEqual(found("#+(and nil sbcl) (a)", []), [
    "suppressed:#+(and nil sbcl) (a)",
  ]);
});

test("a suppressed form hides the macros inside it", () => {
  assert.deepEqual(found("#+nil (my-with (my-with x))", ["my-with"]), [
    "suppressed:#+nil (my-with (my-with x))",
  ]);
});

test("reader syntax does not confuse the scan", () => {
  const text = `#\\( #\; #'foo #(1 2) #S(point x 1) #1=(a) #p"x" (my-with)`;
  assert.deepEqual(found(text, ["my-with", "point"]), ["macro:my-with"]);
});

test("spans are split at line ends", () => {
  const text = "ab\n#+nil (a\n  b)\nc";
  const spans = scan(text, () => false, new Features());
  assert.deepEqual(byLine(text, spans), [
    { line: 1, char: 0, length: 8, kind: "suppressed" },
    { line: 2, char: 0, length: 4, kind: "suppressed" },
  ]);
});

test("carriage returns are not coloured", () => {
  const text = "#+nil (a\r\n b)";
  const pieces = byLine(text, scan(text, () => false, new Features()));
  assert.deepEqual(
    pieces.map((p) => p.length),
    [8, 3],
  );
});

test("an unfinished form does not hang the scan", () => {
  assert.deepEqual(found("(my-with (a", ["my-with"]), ["macro:my-with"]);
  assert.deepEqual(found('#+nil "open', []), ["suppressed:#+nil \"open"]);
  assert.deepEqual(found("#+", []), []);
});

test("the image's features arrive as an event", () => {
  assert.deepEqual(
    parseNotification("ide/features", {
      connectionId: 2,
      features: ["sbcl", 3, "ansi-cl"],
    }),
    { type: "features", connectionId: 2, features: ["sbcl", "ansi-cl"] },
  );
});
