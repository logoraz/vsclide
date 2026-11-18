import { strict as assert } from "node:assert";
import { test } from "node:test";
import { SourceLocation } from "../base/debugger";
import { locationOffset } from "../lib/source-location";

/** Return a location with FIELDS over an empty one. */
function location(fields: Partial<SourceLocation>): SourceLocation {
  return {
    file: "/a.lisp",
    position: null,
    line: null,
    column: null,
    snippet: null,
    error: null,
    ...fields,
  };
}

const text = "(defun a ()\n  1)\n\n(defun b ()\n  (foo))\n";

test("a position counts from 1", () => {
  assert.equal(locationOffset(text, location({ position: 1 })), 0);
  assert.equal(locationOffset(text, location({ position: 8 })), 7);
});

test("a position past the end stops at the end", () => {
  assert.equal(
    locationOffset(text, location({ position: 9999 })),
    text.length,
  );
});

test("a snippet wins when the file moved on", () => {
  const found = locationOffset(
    text,
    location({ position: 1, snippet: "(defun b" }),
  );
  assert.equal(found, text.indexOf("(defun b"));
});

test("a snippet that is nowhere keeps the position", () => {
  assert.equal(
    locationOffset(text, location({ position: 5, snippet: "(zzz)" })),
    4,
  );
});

test("the nearest of two snippets wins", () => {
  const twice = "(foo)\n(bar)\n(foo)\n";
  const second = twice.lastIndexOf("(foo)");
  assert.equal(
    locationOffset(twice, location({ position: second, snippet: "(foo)" })),
    second,
  );
});

test("a line and column are used without a position", () => {
  assert.equal(
    locationOffset(text, location({ line: 4, column: 2 })),
    text.indexOf("(defun b") + 1,
  );
});

test("a line past the end and no place give undefined", () => {
  assert.equal(locationOffset(text, location({ line: 99 })), undefined);
  assert.equal(locationOffset(text, location({})), undefined);
});
