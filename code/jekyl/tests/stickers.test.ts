import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseLevel } from "../base/debugger";
import {
  parsePlayhead,
  parseSticker,
  parseStickerCompile,
  parseStickers,
} from "../base/stickers";
import { scanForms } from "../lib/forms";
import {
  Placed,
  breakpointForm,
  instrument,
  levelOf,
  sexpAt,
  shiftItems,
  touchedBy,
  within,
} from "../lib/stickers";

/** Return the span of the first TEXT in SOURCE, with an id. */
function mark(source: string, text: string, id: number, extra = {}): Placed {
  const start = source.indexOf(text);
  assert.ok(start >= 0, text);
  return { id, start, end: start + text.length, ...extra };
}

test("instrument wraps each sticker in record", () => {
  const source = "(defun f (x) (* x 2))";
  const span = { start: 0, end: source.length };
  const result = instrument(source, span, [mark(source, "(* x 2)", 7)]);
  assert.equal(result, "(defun f (x) (slynk-stickers:record 7 (* x 2)))");
});

test("instrument nests stickers outer first", () => {
  const source = "(f (g x))";
  const span = { start: 0, end: source.length };
  const result = instrument(source, span, [
    mark(source, "x", 3),
    mark(source, "(g x)", 2),
    mark(source, "(f (g x))", 1),
  ]);
  assert.equal(
    result,
    "(slynk-stickers:record 1 (f (slynk-stickers:record 2 " +
      "(g (slynk-stickers:record 3 x)))))",
  );
});

test("instrument orders stickers that touch", () => {
  const source = "(a)(b)";
  const span = { start: 0, end: 6 };
  const result = instrument(source, span, [
    mark(source, "(a)", 1),
    mark(source, "(b)", 2),
  ]);
  assert.equal(
    result,
    "(slynk-stickers:record 1 (a))(slynk-stickers:record 2 (b))",
  );
});

test("instrument leaves out what is outside the span", () => {
  const source = "(a) (b)";
  const result = instrument(source, { start: 4, end: 7 }, [
    mark(source, "(a)", 1),
    mark(source, "(b)", 2),
  ]);
  assert.equal(result, "(slynk-stickers:record 2 (b))");
});

test("instrument makes a breakpoint stop before its form", () => {
  const source = "(f (g x))";
  const span = { start: 0, end: source.length };
  const plain = instrument(source, span, [
    mark(source, "(g x)", 4, { breakpoint: true }),
  ]);
  assert.equal(
    plain,
    "(f (slynk-stickers:record 4 (progn " +
      "(clide-image::break-here 4) (g x))))",
  );
  const guarded = instrument(source, span, [
    mark(source, "(g x)", 5, { breakpoint: true, condition: "(> x 1)" }),
  ]);
  assert.ok(
    guarded.includes("(when (> x 1) (clide-image::break-here 5))"),
  );
});

test("items move with edits and go when touched", () => {
  const items: Placed[] = [
    { id: 1, start: 10, end: 15 },
    { id: 2, start: 20, end: 25 },
  ];
  const moved = shiftItems(items, { start: 0, end: 0, length: 3 });
  assert.deepEqual(moved.map((i) => [i.id, i.start, i.end]), [
    [1, 13, 18],
    [2, 23, 28],
  ]);
  const inside = shiftItems(items, { start: 12, end: 13, length: 1 });
  assert.deepEqual(inside.map((i) => i.id), [2]);
  assert.deepEqual(
    touchedBy(items, { start: 12, end: 13, length: 1 }).map((i) => i.id),
    [1],
  );
  assert.deepEqual(
    shiftItems(items, { start: 15, end: 15, length: 2 }).map((i) => i.id),
    [1, 2],
  );
});

test("within and level of", () => {
  const items = [
    { start: 0, end: 20 },
    { start: 5, end: 10 },
    { start: 30, end: 40 },
  ];
  assert.equal(within(items, { start: 0, end: 25 }).length, 2);
  assert.equal(levelOf(items[1], items), 1);
  assert.equal(levelOf(items[0], items), 0);
  assert.equal(levelOf(items[2], items), 0);
});

test("sexp at finds the form at the cursor", () => {
  const text = "(foo (bar baz) 12)";
  const at = (offset: number) => {
    const range = sexpAt(text, offset);
    return range && text.slice(range.start, range.end);
  };
  assert.equal(at(7), "bar");
  assert.equal(at(9), "bar");
  assert.equal(at(10), "baz");
  assert.equal(at(14), "(bar baz)");
  assert.equal(at(1), "foo");
  assert.equal(at(18), "(foo (bar baz) 12)");
});

test("breakpoint form is the largest nested list on the line", () => {
  const text = [
    "(defun f (x)",
    "  (let ((a 1))",
    "    (g (h a))",
    "    x))",
  ].join("\n");
  const scan = scanForms(text);
  const lines = text.split("\n");
  const offsets: number[] = [];
  let at = 0;
  for (const line of lines) {
    offsets.push(at);
    at += line.length + 1;
  }
  const form = (n: number) => {
    const range = breakpointForm(
      text,
      offsets[n],
      offsets[n] + lines[n].length,
      scan,
    );
    return range && text.slice(range.start, range.end);
  };
  assert.equal(form(0), "(x)");
  assert.equal(form(1)?.startsWith("(let ((a 1))"), true);
  assert.equal(form(2), "(g (h a))");
  assert.equal(form(3), undefined);
});

test("sticker replies are parsed", () => {
  const sticker = parseSticker({
    id: 3,
    count: 2,
    recording: { id: 9, time: 2208988801, values: ["1", "2"], exited: false },
  });
  assert.equal(sticker.count, 2);
  assert.equal(sticker.recording?.time, 1000);
  assert.deepEqual(sticker.recording?.values, ["1", "2"]);
  assert.equal(
    parseSticker({ id: 4, count: 0, recording: null }).recording,
    null,
  );
  assert.deepEqual(parsePlayhead({ error: "none" }), { error: "none" });
  const head = parsePlayhead({ total: 5, index: 2, sticker: { id: 1 } });
  assert.ok(!("error" in head) && head.total === 5 && head.index === 2);
  assert.equal(
    parseStickerCompile({ stuck: true, result: null }).result,
    null,
  );
  assert.equal(parseStickers({ stickers: [{ id: 1 }, { id: 2 }] }).length, 2);
});

test("a debugger level says which sticker stopped it", () => {
  const level = parseLevel({
    threadId: 1,
    level: 1,
    condition: {
      message: "m",
      type: "t",
      sticker: { kind: "breakpoint", id: 8 },
    },
  });
  assert.deepEqual(level.condition.sticker, {
    kind: "breakpoint",
    id: 8,
    values: [],
  });
  const after = parseLevel({
    condition: {
      sticker: { kind: "after", id: 2, recording: { id: 1, values: ["7"] } },
    },
  });
  assert.deepEqual(after.condition.sticker?.values, ["7"]);
  assert.equal(parseLevel({ condition: {} }).condition.sticker, undefined);
});
