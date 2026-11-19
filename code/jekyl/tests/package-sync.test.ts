import { test } from "node:test";
import assert from "node:assert/strict";
import { needsPackageSync } from "../lib/package-sync";
import { parseReferences } from "../base/language";

const here = { name: "COMMON-LISP-USER", nickname: "CL-USER" };

test("sync when the file is in another package", () => {
  assert.equal(needsPackageSync(here, "locutus", false), true);
});

test("no sync in the same package, by name or nickname", () => {
  assert.equal(needsPackageSync(here, "common-lisp-user", false), false);
  assert.equal(needsPackageSync(here, "cl-user", false), false);
  assert.equal(needsPackageSync(here, "#:CL-USER", false), false);
});

test("no sync without a file package, a prompt or while busy", () => {
  assert.equal(needsPackageSync(here, undefined, false), false);
  assert.equal(needsPackageSync(here, "", false), false);
  assert.equal(needsPackageSync(undefined, "locutus", false), false);
  assert.equal(needsPackageSync(here, "locutus", true), false);
});

test("references parse with name, kind and location", () => {
  const references = parseReferences({
    references: [
      {
        name: "(DEFUN LOCUTUS)",
        kind: "calls",
        location: { file: "/tmp/a.lisp", position: 7, error: null },
      },
    ],
  });
  assert.equal(references.length, 1);
  assert.equal(references[0].kind, "calls");
  assert.equal(references[0].location?.position, 7);
  assert.deepEqual(parseReferences(undefined), []);
});
