import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  Runner,
  findSlynk,
  installDependencies,
  needsInstall,
  pinStamp,
  slynkSystemPath,
} from "../base/setup";
import { slynkArgs } from "../base/launch";

const CSV =
  "alexandria, ghcr.io/a@sha256:1, alexandria-1/alexandria.asd\n" +
  "slynk, ghcr.io/s@sha256:2, sly-1/slynk/slynk.asd\n";

/** Return a clide directory holding CSV, to hand to BODY. */
async function withDirectory(
  body: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "locutus-"));
  try {
    await fs.writeFile(path.join(directory, "ocicl.csv"), CSV);
    await body(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("the slynk system comes from the pin file", () => {
  assert.equal(
    slynkSystemPath("/x/clide", CSV),
    path.join("/x/clide", "ocicl", "sly-1/slynk/slynk.asd"),
  );
  assert.equal(slynkSystemPath("/x/clide", "alexandria, a, b\n"), undefined);
});

test("pin stamps differ when the pins differ", () => {
  assert.notEqual(pinStamp(CSV), pinStamp(CSV + "x, y, z\n"));
  assert.equal(pinStamp(CSV), pinStamp(CSV));
});

test("install runs ocicl once and again only when the pins change", () =>
  withDirectory(async (directory) => {
    const calls: string[][] = [];
    const run: Runner = async (command, args, cwd) => {
      calls.push([command, ...args, cwd]);
    };
    const options = { directory, command: "ocicl", log: () => {}, run };
    assert.equal(await needsInstall(directory), true);
    assert.equal(await installDependencies(options), true);
    assert.deepEqual(calls, [["ocicl", "install", directory]]);
    assert.equal(await installDependencies(options), false);
    assert.equal(calls.length, 1);
    await fs.writeFile(path.join(directory, "ocicl.csv"), CSV + "z, y, x\n");
    assert.equal(await installDependencies(options), true);
    assert.equal(calls.length, 2);
  }));

test("a failed install leaves no stamp, so it is tried again", () =>
  withDirectory(async (directory) => {
    const run: Runner = async () => {
      throw new Error("ocicl was not found");
    };
    await assert.rejects(
      installDependencies({ directory, command: "ocicl", log: () => {}, run }),
      /not found/,
    );
    assert.equal(await needsInstall(directory), true);
  }));

test("slynk is found only once it is installed", () =>
  withDirectory(async (directory) => {
    assert.equal(await findSlynk(directory), undefined);
    const file = path.join(directory, "ocicl", "sly-1", "slynk", "slynk.asd");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "");
    assert.equal(await findSlynk(directory), file);
  }));

test("slynk launches with the pinned system when there is one", () => {
  const plain = slynkArgs();
  assert.ok(!plain.some((arg) => arg.includes("load-asd")));
  const pinned = slynkArgs("/x/clide/ocicl/sly-1/slynk/slynk.asd");
  const asd = pinned.findIndex((arg) => arg.includes("load-asd"));
  const load = pinned.findIndex((arg) => arg.includes("load-system"));
  assert.ok(asd >= 0 && asd < load);
  assert.ok(pinned[asd].includes('"/x/clide/ocicl/sly-1/slynk/slynk.asd"'));
});
