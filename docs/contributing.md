# Contributing

How to build vsclide and what a change should meet. The contribution
process is still taking shape; for now, open an issue before starting
anything large. See [architecture.md](architecture.md) for the design.

## Prerequisites

- Linux
- Node.js and npm
- SBCL, with [ocicl](https://github.com/ocicl/ocicl) set up
- slynk loadable by ASDF in your Lisp (the ASDF system `slynk`)

## Build and run

```sh
npm install
npm run compile
(cd code/clide && ocicl install)
```

- Press F5 in VS Code ("Run Extension" in `.vscode/launch.json`) to open
  an Extension Development Host; reload that window to pick up a rebuild
- `npm run watch` rebuilds `out/extension.js` on change
- The `allow-scripts` warnings for `esbuild` and `keytar` are harmless

### npm scripts

- `check-types`: `tsc --noEmit` for `code/jekyl` and its `webview`
- `test`: bundle `code/jekyl/tests` and run them with `node --test`
- `compile`: type-check, then bundle with source maps
- `watch`: esbuild in watch mode, without a type-check
- `bundle`: type-check, then a minified production bundle
- `package`: `vsce package`

`out/` and `node_modules/` are git-ignored.

## The Lisp side

- Work live in a REPL, loading clide through ASDF
- Run the implementation from `code/clide` or a directory beneath it:
  ocicl starts at the working directory and walks up the parents looking
  for `ocicl.csv`, and never searches downward
  - It caches the result on the first system lookup, so changing the
    directory later in a session changes nothing
  - `clide.asd` must be in the working directory for ASDF to find it
- Run the tests: `(asdf:test-system "clide")`; they start a real server
  on an ephemeral port and drive it over a socket
- Run the server by hand:
  `CLIDE_TOKEN=secret sbcl --eval '(asdf:load-system "clide")'
  --eval '(clide:main)'`; it prints `{"port":N}` and then blocks
- Dependencies come from ocicl, pinned by `ocicl.csv`

## Before you send a change

All of these pass:

- `npm run check-types`
- `npm test`
- `(asdf:test-system "clide")`

## Conventions

- Add tests with the change
- Lines stay within 80 columns; every function and definition has a
  docstring
- Directories are named by role; there is no `src` directory
- Commit messages are one line: `type (scope): description`, for example
  `feat (stickers): add source-line breakpoints`
- The extension must not write to the user's settings

## Packaging

`npm run package` builds the VSIX. The extension only starts clide from a
checkout for now, so the VSIX is not usable on its own yet.

## License

Contributions are under the project's [MIT license](../LICENSE).
