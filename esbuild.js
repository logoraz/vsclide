const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/**
 * Bundles code/jekyl/extension.ts into out/extension.js.
 * Minifies for production; otherwise emits source maps. Pass the
 * watch flag to rebuild on change. Types are checked separately by
 * tsc, since esbuild strips them unchecked.
 */
async function main() {
  const ctx = await esbuild.context({
    entryPoints: ["code/jekyl/extension.ts"],
    bundle: true,
    format: "cjs",
    platform: "node",
    outfile: "out/extension.js",
    external: ["vscode"],
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    logLevel: "info",
  });
  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});