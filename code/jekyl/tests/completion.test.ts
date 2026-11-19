import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  contextAt,
  flexScore,
  shiftRange,
  symbolAround,
  symbolBefore,
  wordsIn,
} from "../lib/completion";

test("code is code", () => {
  const text = "(defun f () (g))";
  assert.equal(contextAt(text, 5), "code");
  assert.equal(contextAt(text, text.length), "code");
});

test("a string is a string until it closes", () => {
  const text = '(f "abc def") (g)';
  assert.equal(contextAt(text, 6), "string");
  assert.equal(contextAt(text, 11), "string");
  assert.equal(contextAt(text, 12), "code");
});

test("an escaped quote does not close a string", () => {
  const text = '(f "a\\"b c")';
  assert.equal(contextAt(text, 9), "string");
});

test("a line comment lasts to the end of the line", () => {
  const text = "(f) ; note (g\n(h)";
  assert.equal(contextAt(text, 8), "comment");
  assert.equal(contextAt(text, text.indexOf("(h") + 1), "code");
});

test("a semicolon in a string starts no comment", () => {
  const text = '(f "a ; b") (g)';
  assert.equal(contextAt(text, 7), "string");
  assert.equal(contextAt(text, 13), "code");
});

test("a block comment nests", () => {
  const text = "#| a #| b |# c |# (f)";
  assert.equal(contextAt(text, 3), "comment");
  assert.equal(contextAt(text, 12), "comment");
  assert.equal(contextAt(text, 19), "code");
});

test("a character literal hides its quote and parenthesis", () => {
  const text = '(list #\\" #\\( x)';
  assert.equal(contextAt(text, text.length - 1), "code");
});

test("symbolBefore finds what is typed", () => {
  const text = "(mvb";
  assert.deepEqual(symbolBefore(text, 4), { start: 1, end: 4, name: "mvb" });
  assert.equal(symbolBefore("(", 1), undefined);
  assert.equal(symbolBefore("(f ", 3), undefined);
});

test("symbolBefore keeps package and keyword colons", () => {
  assert.equal(symbolBefore("(slynk:cre", 10)?.name, "slynk:cre");
  assert.equal(symbolBefore("(f :ke", 6)?.name, ":ke");
});

test("symbolBefore leaves out quote, function and uninterned marks", () => {
  assert.equal(symbolBefore("'foo", 4)?.name, "foo");
  assert.equal(symbolBefore("#'foo", 5)?.name, "foo");
  assert.equal(symbolBefore("#:foo", 5)?.name, "foo");
  assert.equal(symbolBefore("`(,@foo", 7)?.name, "foo");
});

test("symbolAround spans both sides of the cursor", () => {
  const text = "(foo-bar baz)";
  assert.deepEqual(
    symbolAround(text, 3),
    { start: 1, end: 8, name: "foo-bar" },
  );
  assert.equal(symbolAround(text, 8)?.name, "foo-bar");
  assert.equal(symbolAround(text, 0)?.name, undefined);
});

test("an edit after a range leaves it, before it moves it", () => {
  const range = { start: 10, end: 20 };
  assert.deepEqual(shiftRange(range, { start: 30, end: 30, length: 5 }), range);
  assert.deepEqual(
    shiftRange(range, { start: 0, end: 0, length: 4 }),
    { start: 14, end: 24 },
  );
  assert.deepEqual(
    shiftRange(range, { start: 0, end: 5, length: 0 }),
    { start: 5, end: 15 },
  );
});

test("an edit that touches a range removes it", () => {
  const range = { start: 10, end: 20 };
  assert.equal(shiftRange(range, { start: 15, end: 15, length: 1 }), undefined);
  assert.equal(shiftRange(range, { start: 5, end: 12, length: 0 }), undefined);
});

test("an edit at the end of a range leaves it", () => {
  const range = { start: 10, end: 20 };
  assert.deepEqual(shiftRange(range, { start: 20, end: 20, length: 3 }), range);
});

test("wordsIn finds distinct symbol-like words, not numbers", () => {
  const words = wordsIn("(defun foo-bar (x) (foo-bar 12 3.5 #:baz))");
  assert.deepEqual(words.sort(), ["baz", "defun", "foo-bar"]);
});

test("flexScore needs every letter in order", () => {
  assert.equal(flexScore("mvb", "multiple-value-bind") !== undefined, true);
  assert.equal(flexScore("mvb", "member"), undefined);
  assert.equal(flexScore("bvm", "multiple-value-bind"), undefined);
});

test("flexScore prefers prefixes, runs and part starts", () => {
  const score = (pattern: string, label: string) =>
    flexScore(pattern, label) ?? -Infinity;
  assert.ok(score("mul", "multiple-value-bind") > score("mul", "simulate"));
  assert.ok(score("mvb", "multiple-value-bind") > score("mvb", "emvab"));
  assert.ok(score("foo", "foo") > score("foo", "foobar"));
});
