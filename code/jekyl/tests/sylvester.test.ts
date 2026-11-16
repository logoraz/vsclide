import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  WORDS_OF_ENCOURAGEMENT,
  banner,
  parseSylvesters,
} from "../lib/sylvester";

const ART = " /\\_/\\   @@@@\n( o.o )\n\n   (^.^)\n  @@@@\n\n";

test("pieces are split on blank lines and trimmed", () => {
  const pieces = parseSylvesters(ART);
  assert.equal(pieces.length, 2);
  assert.equal(pieces[0], " /\\_/\\   @@@@\n( o.o )");
  assert.equal(pieces[1], "   (^.^)\n  @@@@");
});

test("blank and CRLF input are handled", () => {
  assert.deepEqual(parseSylvesters(""), []);
  assert.deepEqual(parseSylvesters("\n\n\n\n"), []);
  assert.equal(parseSylvesters("a\r\n\r\nb").length, 2);
});

test("the banner is commented and has words in place of @@@@", () => {
  const text = banner(ART, () => 0);
  assert.ok(text.endsWith("\n"));
  assert.ok(!text.includes("@@@@"));
  assert.ok(text.includes(WORDS_OF_ENCOURAGEMENT[0]));
  for (const line of text.trimEnd().split("\n")) {
    assert.ok(line.startsWith(";"), line);
  }
});

test("without art the banner is the words alone", () => {
  assert.equal(banner(undefined, () => 0), `; ${WORDS_OF_ENCOURAGEMENT[0]}\n`);
  assert.equal(banner("", () => 0), `; ${WORDS_OF_ENCOURAGEMENT[0]}\n`);
});

test("random values at the top of the range stay in bounds", () => {
  assert.ok(banner(ART, () => 0.999999).length > 0);
});
