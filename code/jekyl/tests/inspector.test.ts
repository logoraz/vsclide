import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  Inspected,
  InspectorModel,
  parseInspected,
  parseRange,
  wholeLines,
} from "../base/inspector";

/** Return an inspected object titled TITLE. */
function object(title: string, more = false): Inspected {
  return { title, id: 1, parts: [], end: 10, more };
}

test("parseInspected reads the title and every kind of part", () => {
  const parsed = parseInspected({
    title: "A list",
    id: 4,
    end: 3,
    more: true,
    parts: [
      { kind: "label", text: "Length" },
      { kind: "text", text: ": " },
      { kind: "value", text: "3", index: 0 },
      { kind: "action", text: "remove", index: 1 },
    ],
  });
  assert.equal(parsed?.title, "A list");
  assert.equal(parsed?.more, true);
  assert.deepEqual(
    parsed?.parts.map((part) => part.kind),
    ["label", "text", "value", "action"],
  );
});

test("parseInspected gives undefined for no object", () => {
  assert.equal(parseInspected(null), undefined);
  assert.equal(parseInspected("x"), undefined);
});

test("parseRange reads the parts and the bounds", () => {
  const range = parseRange({
    parts: [{ kind: "text", text: "x" }],
    start: 0,
    end: 1,
    more: false,
  });
  assert.equal(range.parts.length, 1);
  assert.equal(range.end, 1);
  assert.equal(range.more, false);
});

test("descending and going back keep the history counts", () => {
  const model = new InspectorModel();
  model.start(object("a"));
  assert.equal(model.canGoBack, false);
  model.descend(object("b"));
  assert.equal(model.current?.title, "b");
  assert.equal(model.canGoBack, true);
  model.goBack(object("a"));
  assert.equal(model.canGoBack, false);
  assert.equal(model.canGoForward, true);
  model.goForward(object("b"));
  assert.equal(model.canGoForward, false);
});

test("descending after going back drops the forward history", () => {
  const model = new InspectorModel();
  model.start(object("a"));
  model.descend(object("b"));
  model.goBack(object("a"));
  model.descend(object("c"));
  assert.equal(model.canGoForward, false);
});

test("moving to no object changes nothing", () => {
  const model = new InspectorModel();
  model.start(object("a"));
  model.goBack(undefined);
  model.descend(undefined);
  assert.equal(model.current?.title, "a");
  assert.equal(model.canGoBack, false);
});

test("more parts are appended and the range moves on", () => {
  const model = new InspectorModel();
  model.start(object("a", true));
  model.extend({
    parts: [{ kind: "text", text: "x" }],
    start: 10,
    end: 20,
    more: false,
  });
  assert.equal(model.current?.parts.length, 1);
  assert.equal(model.current?.end, 20);
  assert.equal(model.current?.more, false);
});

test("clear forgets the object and the history", () => {
  const model = new InspectorModel();
  let changes = 0;
  model.onChange(() => (changes += 1));
  model.start(object("a"));
  model.descend(object("b"));
  model.clear();
  assert.equal(model.current, undefined);
  assert.equal(model.canGoBack, false);
  model.clear();
  assert.equal(changes, 3);
});

test("a page that ends mid-line is cut back to the last whole line", () => {
  const parts = [
    { kind: "label" as const, text: "0" },
    { kind: "text" as const, text: ": " },
    { kind: "value" as const, text: "NIL", index: 0 },
    { kind: "text" as const, text: "\n" },
    { kind: "label" as const, text: "1" },
    { kind: "text" as const, text: ": " },
  ];
  const whole = wholeLines(parts, 6, true);
  assert.equal(whole.parts.length, 4);
  assert.equal(whole.end, 4);
});

test("a page without more, or without a line end, is kept", () => {
  const parts = [{ kind: "label" as const, text: "0" }];
  assert.deepEqual(wholeLines(parts, 1, true), { parts, end: 1 });
  assert.deepEqual(wholeLines(parts, 1, false), { parts, end: 1 });
});

test("parseRange cuts a page that ends mid-line", () => {
  const range = parseRange({
    parts: [
      { kind: "text", text: "a\n" },
      { kind: "label", text: "1" },
    ],
    start: 0,
    end: 2,
    more: true,
  });
  assert.equal(range.parts.length, 1);
  assert.equal(range.end, 1);
  assert.equal(range.more, true);
});
