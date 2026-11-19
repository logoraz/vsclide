import { strict as assert } from "node:assert";
import { test } from "node:test";
import { locationFile, parseLocation } from "../base/debugger";
import {
  atLeast,
  noteSeverity,
  parseCompileResult,
  parseCompletions,
  parseDefinitions,
  summarize,
  tidyDocumentation,
} from "../base/language";

test("parseCompletions reads items and chunks", () => {
  const items = parseCompletions({
    items: [
      {
        label: "multiple-value-bind",
        score: 12.5,
        kind: "macro",
        chunks: [{ start: 0, text: "m" }, { start: 9, text: "v" }],
      },
    ],
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].label, "multiple-value-bind");
  assert.equal(items[0].kind, "macro");
  assert.deepEqual(items[0].chunks[1], { start: 9, text: "v" });
});

test("parseCompletions tolerates missing fields", () => {
  assert.deepEqual(parseCompletions({}), []);
  assert.deepEqual(parseCompletions(undefined), []);
  assert.equal(parseCompletions({ items: [{}] })[0].label, "");
});

test("parseDefinitions reads names and locations", () => {
  const definitions = parseDefinitions({
    definitions: [
      {
        name: "(DEFUN FOO)",
        location: { file: "/a.lisp", position: 7, snippet: "(defun foo" },
      },
      { name: "(DEFVAR FOO)", location: null },
    ],
  });
  assert.equal(definitions.length, 2);
  assert.equal(definitions[0].name, "(DEFUN FOO)");
  assert.equal(definitions[0].location?.position, 7);
  assert.equal(definitions[1].location, null);
});

test("a location's file is its file, or a buffer that names one", () => {
  const base = parseLocation({});
  assert.ok(base);
  assert.equal(locationFile({ ...base, file: "/a.lisp" }), "/a.lisp");
  assert.equal(locationFile({ ...base, buffer: "/b.lisp" }), "/b.lisp");
  assert.equal(locationFile({ ...base, buffer: "C:\\b.lisp" }), "C:\\b.lisp");
  assert.equal(locationFile({ ...base, buffer: "untitled" }), null);
  assert.equal(locationFile(base), null);
});

test("parseCompileResult reads the verdict and the notes", () => {
  const result = parseCompileResult({
    ok: false,
    aborted: false,
    seconds: 0.25,
    fasl: null,
    notes: [
      {
        severity: "warning",
        message: "undefined variable: X",
        context: "in: DEFUN F",
        location: { buffer: "/a.lisp", position: 12 },
      },
    ],
  });
  assert.equal(result.ok, false);
  assert.equal(result.seconds, 0.25);
  assert.equal(result.fasl, null);
  assert.equal(result.notes[0].severity, "warning");
  assert.equal(result.notes[0].context, "in: DEFUN F");
  assert.equal(result.notes[0].location?.position, 12);
});

test("notes are as serious as the compiler's word says", () => {
  assert.equal(noteSeverity("error"), "error");
  assert.equal(noteSeverity("read-error"), "error");
  assert.equal(noteSeverity("warning"), "warning");
  assert.equal(noteSeverity("style-warning"), "warning");
  assert.equal(noteSeverity("note"), "information");
  assert.equal(noteSeverity("redefinition"), "hint");
});

test("atLeast compares severities, most serious first", () => {
  assert.equal(atLeast("error", "warning"), true);
  assert.equal(atLeast("warning", "warning"), true);
  assert.equal(atLeast("information", "warning"), false);
  assert.equal(atLeast("hint", "hint"), true);
});

test("summarize counts what the compiler found", () => {
  const note = (severity: string) => ({
    severity,
    message: "",
    context: null,
    location: null,
  });
  const result = (severities: string[], aborted = false) => ({
    ok: true,
    aborted,
    seconds: 0.5,
    fasl: null,
    notes: severities.map(note),
  });
  assert.equal(summarize(result([])), "compiled in 0.50s");
  assert.equal(
    summarize(result(["warning", "style-warning", "note", "error"])),
    "compiled with 1 error, 2 warnings, 1 note in 0.50s",
  );
  assert.equal(summarize(result([], true)), "compilation aborted");
});

test("tidyDocumentation drops the arglist lines", () => {
  const text = "Function:\n Arglist: (LIST)\n\n Return the first.\n\n\n\nMore.";
  assert.equal(
    tidyDocumentation(text),
    "Function:\n\n Return the first.\n\nMore.",
  );
});
