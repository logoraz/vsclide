import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { activeKeymap } from "../lib/keymap";
import { MANIFEST } from "./textmate";

interface Binding {
  command: string;
  key: string;
  when: string;
}

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const bindings: Binding[] = manifest.contributes.keybindings;
const commands = new Set<string>(
  manifest.contributes.commands.map((c: { command: string }) => c.command),
);

/** Return the bindings of the key map NAME. */
function keymap(name: string): Binding[] {
  return bindings.filter((b) => b.when.includes(`vsclide.activeKeymap == '${name}'`));
}

test("every binding belongs to exactly one key map", () => {
  for (const binding of bindings) {
    const maps = ["vscode", "emacs"].filter((name) =>
      binding.when.includes(`vsclide.activeKeymap == '${name}'`),
    );
    assert.equal(maps.length, 1, `${binding.key} ${binding.command}`);
  }
});

test("bindings run contributed commands", () => {
  for (const binding of bindings) {
    assert.ok(
      commands.has(binding.command) ||
        binding.command === "editor.action.triggerSuggest",
      binding.command,
    );
  }
});

test("a key map has no key twice for the same condition", () => {
  for (const name of ["vscode", "emacs"]) {
    const seen = new Set<string>();
    for (const binding of keymap(name)) {
      const id = `${binding.key} | ${binding.when}`;
      assert.ok(!seen.has(id), `${name}: ${id}`);
      seen.add(id);
    }
  }
});

test("no key of a key map hides a chord of the same one", () => {
  for (const name of ["vscode", "emacs"]) {
    const keys = new Set(keymap(name).map((b) => b.key));
    for (const key of keys) {
      for (const other of keys) {
        assert.ok(
          !other.startsWith(key + " "),
          `${name}: ${key} is the start of ${other}`,
        );
      }
    }
  }
});

test("the key maps bind the same commands", () => {
  const commandsOf = (name: string) =>
    new Set(keymap(name).map((b) => b.command));
  const vscode = commandsOf("vscode");
  const emacs = commandsOf("emacs");
  // Ctrl+Space is the editor's own in the VS Code set.
  emacs.delete("editor.action.triggerSuggest");
  assert.deepEqual([...vscode].sort(), [...emacs].sort());
});

test("the keymap setting offers auto, both sets, and defaults to auto", () => {
  const setting = manifest.contributes.configuration.properties[
    "vsclide.keymap"
  ];
  assert.deepEqual(setting.enum, ["auto", "vscode", "emacs"]);
  assert.equal(setting.default, "auto");
});

test("auto picks emacs only when Awesome Emacs Keymap is present", () => {
  assert.equal(activeKeymap("auto", true), "emacs");
  assert.equal(activeKeymap("auto", false), "vscode");
});

test("an explicit keymap setting wins over detection", () => {
  assert.equal(activeKeymap("vscode", true), "vscode");
  assert.equal(activeKeymap("emacs", false), "emacs");
});

test("an unknown keymap setting falls back to auto", () => {
  assert.equal(activeKeymap("bogus", true), "emacs");
  assert.equal(activeKeymap(undefined, false), "vscode");
});
