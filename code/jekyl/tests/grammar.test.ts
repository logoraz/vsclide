import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as textmate from "vscode-textmate";
import { load } from "./textmate";

/** A token: the text it covers and the scopes below the root scope. */
interface Token {
  text: string;
  scopes: string[];
}

/** Load the grammar once; the oniguruma engine is shared. */
const grammar: Promise<textmate.IGrammar> = load().then((l) => l.grammar);

/** Tokenize SOURCE, which may span lines, into a flat list of tokens. */
async function tokenize(source: string): Promise<Token[]> {
  const g = await grammar;
  let state = textmate.INITIAL;
  const tokens: Token[] = [];
  for (const line of source.split("\n")) {
    const result = g.tokenizeLine(line, state);
    state = result.ruleStack;
    for (const token of result.tokens) {
      tokens.push({
        text: line.slice(token.startIndex, token.endIndex),
        scopes: token.scopes.slice(1),
      });
    }
  }
  return tokens;
}

/** Assert that TEXT in SOURCE gets a scope that starts with SCOPE. */
async function expectScope(
  source: string,
  text: string,
  scope: string,
): Promise<void> {
  const tokens = await tokenize(source);
  const token = tokens.find((candidate) => candidate.text === text);
  assert.ok(token, `no token ${JSON.stringify(text)} in ${source}`);
  const found = token.scopes.some((s) => s.startsWith(scope));
  assert.ok(found, `${text}: wanted ${scope}, got ${token.scopes.join(" ")}`);
}

test("comments: line and nested block", async () => {
  await expectScope("(a) ; note", "; note", "comment.line");
  const tokens = await tokenize("#| a #| b |# c |# (x)");
  const inside = tokens.filter((t) => t.text.trim() && t.text !== "(x)");
  assert.ok(
    inside
      .filter((t) => ["a", "b", "c"].includes(t.text.trim()))
      .every((t) => t.scopes[0] === "comment.block.commonlisp"),
  );
  await expectScope("#| a |# (foo)", "(", "punctuation.section.expression");
});

test("strings keep escapes and hide parentheses", async () => {
  await expectScope('"a \\" ( b"', '\\"', "constant.character.escape");
  await expectScope('"a ( b"', "a ( b", "string");
});

test("definers and the names they define", async () => {
  await expectScope("(defun foo (x) x)", "defun", "storage.type.function");
  await expectScope("(defun foo (x) x)", "foo", "entity.name.function");
  await expectScope("(defmethod (setf name) (v o) v)", "(setf name)",
    "entity.name.function");
  await expectScope("(defvar *x* 1)", "*x*", "entity.name.variable");
  await expectScope("(defclass thing () ())", "thing", "entity.name.type");
  await expectScope("(defpackage :my-pkg)", ":my-pkg", "entity.name.namespace");
});

test("special operators and macros", async () => {
  await expectScope("(if a b c)", "if", "keyword.control");
  await expectScope("(let ((a 1)) a)", "let", "keyword.control");
  await expectScope("(cl:when a b)", "cl:when", "keyword.control");
  await expectScope("(loop for i below 3)", "loop", "keyword.control");
});

test("symbols: keywords, specials, constants, packages", async () => {
  await expectScope("(f :ok)", ":ok", "constant.other.keyword");
  await expectScope("(f *special*)", "*special*", "variable.other.special");
  await expectScope("(f +const+)", "+const+", "constant.other");
  await expectScope("(f nil)", "nil", "constant.language");
  await expectScope("(f pkg:sym)", "pkg", "entity.name.namespace");
  await expectScope("(f |odd sym|)", "|odd sym|", "variable.other");
});

test("numbers and characters", async () => {
  await expectScope("(f 42)", "42", "constant.numeric");
  await expectScope("(f 1.5e3)", "1.5e3", "constant.numeric");
  await expectScope("(f 1/2)", "1/2", "constant.numeric");
  await expectScope("(f #x1F)", "#x1F", "constant.numeric");
  await expectScope("(f #\\Space)", "#\\Space", "constant.character");
  await expectScope("(f #\\()", "#\\(", "constant.character");
});

test("lambda list keywords and reader macros", async () => {
  await expectScope("(a &optional b)", "&optional", "storage.modifier");
  await expectScope("(f #'g)", "#'", "keyword.operator.function");
  await expectScope("(f 'a)", "'", "keyword.operator.quote");
  await expectScope("#+sbcl (a)", "#+", "keyword.control.conditional");
});

test("parameters are not colored as function calls", async () => {
  const tokens = await tokenize("(defun f (x y) x)");
  const calls = tokens.filter((t) =>
    t.scopes.some((s) => s.startsWith("support.function")),
  );
  assert.deepEqual(calls, []);
});

test("package names: defined, keyword and uninterned", async () => {
  const defined = "entity.name.namespace.defined";
  await expectScope("(defpackage :a)", ":a", `${defined}.keyword`);
  await expectScope("(defpackage #:a)", "#:a", `${defined}.uninterned`);
  await expectScope("(uiop:define-package :a)", ":a", `${defined}.keyword`);
  await expectScope("(in-package :a)", ":a", "constant.other.keyword");
  await expectScope("(in-package #:a)", "#:a", "constant.other.uninterned");
  await expectScope("(in-package :a)", "in-package", "keyword.control");
});

test("uninterned symbols are one token", async () => {
  await expectScope("(f #:make-server)", "#:make-server",
    "constant.other.uninterned");
  await expectScope("(:use :cl)", ":use", "constant.other.keyword");
});

test("feature expressions and more reader syntax", async () => {
  await expectScope("#+sbcl (a)", "sbcl", "constant.other.feature");
  await expectScope("#-(or sbcl ccl) a", "or", "keyword.control.conditional");
  await expectScope("#-(or sbcl ccl) a", "ccl", "constant.other.feature");
  await expectScope("(f #S(point :x 1))", "#S", "keyword.operator");
  await expectScope("(f '#1=(a . #1#))", "#1=", "keyword.operator");
});
