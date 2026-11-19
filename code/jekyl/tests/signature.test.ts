import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  activeParameter,
  callAt,
  parseLambdaList,
  signatureFor,
} from "../lib/signature";

/** Return the call at the | in TEXT, with the | removed. */
function at(text: string) {
  const offset = text.indexOf("|");
  return callAt(text.replace("|", ""), offset);
}

test("call at finds the operator and argument index", () => {
  assert.deepEqual(at("(foo a |"), {
    operator: "foo",
    before: ["a"],
    index: 1,
  });
  assert.equal(at("(foo |")?.index, 0);
  assert.equal(at("(foo a b|")?.index, 1);
  assert.deepEqual(at("(foo a b |")?.before, ["a", "b"]);
});

test("call at is nothing on the operator or outside a list", () => {
  assert.equal(at("(fo|o a)"), undefined);
  assert.equal(at("(foo)| x"), undefined);
  assert.equal(at("foo |"), undefined);
});

test("call at skips lists that are not calls", () => {
  assert.equal(at("(let ((a 1) (|")?.operator, "let");
  assert.equal(at("(let ((a 1) (|")?.index, 0);
  assert.equal(at("(foo '(a b |")?.operator, undefined);
  assert.equal(at("(foo #'(lambda (x) |")?.operator, "lambda");
});

test("call at counts a nested call as one argument", () => {
  const call = at("(foo (bar 1 2) |");
  assert.equal(call?.operator, "foo");
  assert.equal(call?.index, 1);
  assert.equal(at("(foo (bar 1 2) (baz |")?.operator, "baz");
});

test("call at ignores strings and comments", () => {
  assert.equal(at('(foo "a b |'), undefined);
  assert.equal(at("(foo ; bar |"), undefined);
  assert.equal(at('(foo "a (b" |')?.index, 1);
  assert.equal(at("(foo #| ( |# |")?.index, 0);
});

test("lambda list parameters have sections and names", () => {
  const params = parseLambdaList("(A &OPTIONAL (B 1) &KEY C ((:d e)) &REST R)");
  assert.deepEqual(
    params.map((p) => [p.section, p.name]),
    [
      ["required", "a"],
      ["optional", "b"],
      ["key", "c"],
      ["key", "d"],
      ["rest", "r"],
    ],
  );
  assert.deepEqual(parseLambdaList("nothing"), []);
});

test("active parameter follows positions, keys and rest", () => {
  const params = parseLambdaList("(A &OPTIONAL B &KEY C D)");
  assert.equal(activeParameter(params, 0, []), 0);
  assert.equal(activeParameter(params, 1, ["x"]), 1);
  assert.equal(activeParameter(params, 3, ["x", "y", ":d"]), 3);
  assert.equal(activeParameter(params, 2, ["x", "y"]), -1);
  const rest = parseLambdaList("(A &REST R)");
  assert.equal(activeParameter(rest, 4, []), 1);
});

test("signature label and ranges line up", () => {
  const shape = signatureFor("foo", "(A &OPTIONAL B)", 1, ["x"]);
  assert.equal(shape.label, "(foo A &OPTIONAL B)");
  const [start, end] = shape.ranges[shape.active];
  assert.equal(shape.label.slice(start, end), "B");
  assert.equal(signatureFor("bar", "NIL", 0, []).label, "(bar)");
  assert.equal(signatureFor("bar", "()", 0, []).label, "(bar)");
});

test("signature drops the operator slynk puts first", () => {
  const shape = signatureFor(
    "cl:mapcar",
    "(MAPCAR FUNCTION LIST &REST MORE-LISTS)",
    0,
    [],
  );
  assert.equal(shape.label, "(cl:mapcar FUNCTION LIST &REST MORE-LISTS)");
  const [start, end] = shape.ranges[shape.active];
  assert.equal(shape.label.slice(start, end), "FUNCTION");
  assert.equal(signatureFor("foo", "(FOO)", 0, []).label, "(foo)");
  assert.equal(signatureFor("foo", "(A B)", 0, []).label, "(foo A B)");
});
