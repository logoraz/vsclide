import { readFileSync } from "node:fs";
import * as path from "node:path";
import * as oniguruma from "vscode-oniguruma";
import * as textmate from "vscode-textmate";

/** The repository root, two levels above the compiled tests. */
export const ROOT = path.resolve(__dirname, "..", "..");

/** Path of the Common Lisp grammar. */
export const GRAMMAR = path.join(
  ROOT,
  "data",
  "syntax",
  "commonlisp.tmLanguage.json",
);

/** Path of the extension manifest, which holds the default colors. */
export const MANIFEST = path.join(ROOT, "package.json");

/**
 * Rules like those of a stock dark theme, which the manifest colors
 * have to beat: they use the same or longer scopes.
 */
export const COMPETING = [
  { scope: "entity.name.function", settings: { foreground: "#dcdcaa" } },
  { scope: "entity.name.type", settings: { foreground: "#4ec9b0" } },
  { scope: "storage.type", settings: { foreground: "#569cd6" } },
  { scope: "keyword.control", settings: { foreground: "#c586c0" } },
  { scope: "constant.other", settings: { foreground: "#4fc1ff" } },
  { scope: "constant.numeric", settings: { foreground: "#b5cea8" } },
  { scope: "string", settings: { foreground: "#ce9178" } },
  { scope: "comment", settings: { foreground: "#6a9955" } },
];

/** The color a token gets when no rule applies to it. */
export const DEFAULT_COLOR = "#c0c0c0";

/** A grammar registry together with the grammar loaded from it. */
export interface Loaded {
  registry: textmate.Registry;
  grammar: textmate.IGrammar;
}

/**
 * Load the Common Lisp grammar with the oniguruma engine.
 *
 * With COLORED, the token color rules that the manifest contributes
 * as configuration defaults are applied to the registry after the
 * COMPETING rules, so that colors can be resolved for tokens.
 */
export async function load(colored = false): Promise<Loaded> {
  const wasm = readFileSync(
    require.resolve("vscode-oniguruma/release/onig.wasm"),
  ).buffer as ArrayBuffer;
  await oniguruma.loadWASM(wasm);
  const registry = new textmate.Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (sources) => new oniguruma.OnigScanner(sources),
      createOnigString: (text) => new oniguruma.OnigString(text),
    }),
    loadGrammar: async () =>
      textmate.parseRawGrammar(readFileSync(GRAMMAR, "utf8"), GRAMMAR),
  });
  if (colored) {
    const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
    const rules =
      manifest.contributes.configurationDefaults[
        "editor.tokenColorCustomizations"
      ].textMateRules;
    registry.setTheme({
      name: "manifest",
      settings: [
        { settings: { foreground: DEFAULT_COLOR } },
        ...COMPETING,
        ...rules,
      ],
    });
  }
  const grammar = await registry.loadGrammar("source.commonlisp");
  if (!grammar) {
    throw new Error("the commonlisp grammar did not load");
  }
  return { registry, grammar };
}

/** Bits of a token's metadata that hold its foreground color id. */
const FOREGROUND_MASK = 0x00ff8000;

/** How far the foreground bits sit from the low end. */
const FOREGROUND_SHIFT = 15;

/** A token with the color the theme gives it. */
export interface Colored {
  text: string;
  color: string;
}

/**
 * Tokenize SOURCE, which may span lines, resolving colors with the
 * rules the registry in LOADED was given.
 */
export function colors(loaded: Loaded, source: string): Colored[] {
  const map = loaded.registry.getColorMap();
  let state = textmate.INITIAL;
  const out: Colored[] = [];
  for (const line of source.split("\n")) {
    const result = loaded.grammar.tokenizeLine2(line, state);
    state = result.ruleStack;
    const tokens = result.tokens;
    for (let i = 0; i < tokens.length; i += 2) {
      const start = tokens[i];
      const end = i + 2 < tokens.length ? tokens[i + 2] : line.length;
      const meta = tokens[i + 1];
      const id = (meta & FOREGROUND_MASK) >>> FOREGROUND_SHIFT;
      out.push({ text: line.slice(start, end), color: map[id] });
    }
  }
  return out;
}
