import { strict as assert } from "node:assert";
import { test } from "node:test";
import { problemText } from "../lib/problem";

test("problemText names the first line and where the rest is", () => {
  const text = problemText(new Error("sbcl exited with 1\n; backtrace"));
  assert.equal(
    text,
    "Could not start Lisp: sbcl exited with 1 " +
      "See the VSCLIDE output for details.",
  );
});

test("problemText cuts a long first line", () => {
  const text = problemText(new Error("x".repeat(300)));
  assert.ok(text.includes(`${"x".repeat(100)}...`));
  assert.ok(!text.includes("x".repeat(101)));
});

test("problemText copes with an empty message and a non-error", () => {
  assert.ok(problemText(new Error("")).includes("unknown error"));
  assert.ok(problemText("plain text").includes("plain text"));
});
