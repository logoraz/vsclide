const esbuild = require("esbuild");
const { globSync } = require("node:fs");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");
const tests = process.argv.includes("--tests");

/** Options shared by every bundle. */
const shared = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  logLevel: "info",
};

/**
 * Return the bundles to build: the extension host script, which keeps
 * vscode external, and the webview scripts of the REPL and the debugger panel, which run in the
 * browser context of the panel. With the tests flag, build only the
 * unit tests of code/jekyl/tests, which need no VS Code.
 */
function bundles() {
  if (tests) {
    return [{
      ...shared,
      entryPoints: globSync("code/jekyl/tests/*.test.ts"),
      format: "cjs",
      platform: "node",
      outdir: "out/tests",
      // Resolved at run time, since it locates its own wasm file.
      external: ["vscode-oniguruma"],
    }];
  }
  return [
    {
      ...shared,
      entryPoints: ["code/jekyl/extension.ts"],
      format: "cjs",
      platform: "node",
      outfile: "out/extension.js",
      external: ["vscode"],
    },
    {
      ...shared,
      entryPoints: ["code/jekyl/webview/repl.ts"],
      format: "iife",
      platform: "browser",
      outfile: "out/webview/repl.js",
    },
    {
      ...shared,
      entryPoints: ["code/jekyl/webview/debugger.ts"],
      format: "iife",
      platform: "browser",
      outfile: "out/webview/debugger.js",
    },
  ];
}

/**
 * Builds every bundle; with the watch flag, rebuilds on change. Types
 * are checked separately by tsc, since esbuild strips them unchecked.
 */
async function main() {
  const contexts = await Promise.all(bundles().map(esbuild.context));
  if (watch) {
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    return;
  }
  await Promise.all(contexts.map((ctx) => ctx.rebuild()));
  await Promise.all(contexts.map((ctx) => ctx.dispose()));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
