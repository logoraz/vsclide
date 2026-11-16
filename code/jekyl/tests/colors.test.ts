import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  colors,
  DEFAULT_COLOR,
  GRAMMAR,
  load,
  Loaded,
  MANIFEST,
} from "./textmate";

/** Load the grammar with the manifest's color rules applied, once. */
const loaded: Promise<Loaded> = load(true);

/**
 * Assert that TEXT in SOURCE is drawn in COLOR.
 *
 * Neighbors drawn in the same color merge into one token, so a token
 * matches when it contains TEXT.
 */
async function expectColor(
  source: string,
  text: string,
  color: string,
): Promise<void> {
  const tokens = colors(await loaded, source);
  const token = tokens.find((candidate) => candidate.text.includes(text));
  assert.ok(token, `no token ${JSON.stringify(text)} in ${source}`);
  assert.equal(token.color.toLowerCase(), color, `${text} in ${source}`);
}

test("the manifest colors are valid and set no background", () => {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const defaults = manifest.contributes.configurationDefaults;
  const rules = defaults["editor.tokenColorCustomizations"].textMateRules;
  assert.ok(rules.length > 0);
  assert.equal(manifest.contributes.themes, undefined);
  for (const rule of rules) {
    assert.match(rule.settings.foreground, /^#[0-9a-f]{6}$/);
    assert.equal(rule.settings.background, undefined);
  }
});

/** Collect every scope name in a grammar's JSON, at any depth. */
function scopeNames(node: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    node.forEach((child) => scopeNames(child, found));
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "name" && typeof value === "string") {
        found.add(value);
      }
      scopeNames(value, found);
    }
  }
  return found;
}

test("every color rule names a scope the grammar emits", () => {
  // A shorter scope loses to a theme's longer one, so rules must use
  // the exact scopes of the grammar.
  const names = scopeNames(JSON.parse(readFileSync(GRAMMAR, "utf8")));
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const defaults = manifest.contributes.configurationDefaults;
  const rules = defaults["editor.tokenColorCustomizations"].textMateRules;
  for (const rule of rules) {
    assert.ok(names.has(rule.scope), `${rule.scope} is not in the grammar`);
  }
});

test("definers and special forms are lavender", async () => {
  for (const word of ["defun", "let", "lambda", "in-package"]) {
    await expectColor(`(${word} a)`, word, "#e0a8e8");
  }
});

test("defined names are steel blue", async () => {
  await expectColor("(defun foo (x) x)", "foo", "#80a8c8");
  await expectColor("(defvar *x* 1)", "*x*", "#80a8c8");
  await expectColor("(defpackage #:cloak)", "#:cloak", "#80a8c8");
});

test("the defpackage keyword name is gold", async () => {
  await expectColor("(defpackage :clide)", ":clide", "#f8d078");
});

test("keywords and uninterned symbols differ", async () => {
  await expectColor("(:use :cl)", ":use", "#b8d0f8");
  await expectColor("(:import-from #:gtk)", "#:gtk", "#b0c8f0");
  await expectColor("(in-package :clide)", ":clide", "#b8d0f8");
});

test("strings, comments and lambda list keywords", async () => {
  await expectColor('(f "s")', "s", "#b0c870");
  await expectColor("(f) ; note", "; note", "#707070");
  await expectColor("(a &rest b)", "&rest", "#e8b068");
});

test("the colors win over a stock theme's rules", async () => {
  await expectColor("(defun foo (x) x)", "foo", "#80a8c8");
  await expectColor("(defclass thing () ())", "thing", "#80a8c8");
  await expectColor("(f :k)", ":k", "#b8d0f8");
  await expectColor("(f 12)", "12", "#e8b068");
  await expectColor("(f) ; note", "; note", "#707070");
});

test("plain symbols are left to the active theme", async () => {
  await expectColor("(register-method server)", "server", DEFAULT_COLOR);
});
