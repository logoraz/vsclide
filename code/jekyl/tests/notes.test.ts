import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Note } from "../base/language";
import { markNotes } from "../lib/notes";

const form = "(defun f ()\n  (g x))";

/** Return a note at the character POSITION, counted from 1, or none. */
function note(position: number | null, severity = "warning"): Note {
  return {
    severity,
    message: "message",
    context: null,
    location:
      position === null
        ? null
        : {
            file: null,
            buffer: "/a.lisp",
            position,
            line: null,
            column: null,
            snippet: null,
            error: null,
          },
  };
}

test("a note is put at the form it points to", () => {
  const [mark] = markNotes(form, [note(15)], { start: 0, end: form.length });
  assert.equal(form.slice(mark.start, mark.end), "(g x)");
  assert.equal(mark.severity, "warning");
  assert.equal(mark.code, "warning");
});

test("a note at a symbol covers the symbol", () => {
  const [mark] = markNotes(form, [note(8)], { start: 0, end: form.length });
  assert.equal(form.slice(mark.start, mark.end), "f");
});

test("a note with no location covers what was compiled", () => {
  const [mark] = markNotes(form, [note(null)], { start: 0, end: form.length });
  assert.deepEqual([mark.start, mark.end], [0, form.length]);
});

test("a note stays inside what was compiled", () => {
  const text = "(a)\n(b)\n(c)";
  const within = { start: 4, end: 7 };
  const [early, late] = markNotes(text, [note(1), note(11)], within);
  assert.ok(early.start >= within.start && early.end <= within.end);
  assert.ok(late.start <= within.end && late.end <= within.end);
});

test("a form's notes are about the offset it starts at", () => {
  const text = "(a)\n(defun f () x)";
  const within = { start: 4, end: text.length };
  // As ide/compile reports: the form's start counted from 1, plus how far
  // into it the problem is.
  const [mark] = markNotes(text, [note(4 + 1 + 12)], within);
  assert.equal(text.slice(mark.start, mark.end), "x");
});
