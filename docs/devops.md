# vsclide: Development Workflow

How to build and check the system while adding features. See
`architecture.md` for the design.

## Overview

Development is two loops that meet at the Extension Development Host:

- jekyl (TypeScript): bundle, launch, reload
- clide (Common Lisp): REPL-driven, with fiveam tests
- Integration: the dev host spawns clide

## jekyl loop

- `npm install` once; the `allow-scripts` warnings for `esbuild` and
  `keytar` are harmless for now
- `npm run watch` rebuilds `out/extension.js` on change
- F5 uses `.vscode/launch.json` ("Run Extension") to open an Extension
  Development Host
- Reload the host window to pick up a rebuilt bundle
- `npm run compile` is a one-shot type-check plus bundle

### Scripts

- `check-types`: `tsc --noEmit` for `code/jekyl` and its `webview`
- `test`: bundle `code/jekyl/tests` and run them with `node --test`
- `compile`: type-check, then bundle with source maps
- `watch`: esbuild in watch mode (no type-check)
- `bundle`: type-check, then minified production bundle
- `vscode:prepublish`: runs `bundle`
- `package`: `vsce package`

### Files

- `esbuild.js` at the repo root bundles `code/jekyl/extension.ts` into
  `out/extension.js` and the REPL page script into `out/webview/repl.js`
- `code/jekyl/tsconfig.json` is for type-checking only (`noEmit`)
- `out/` and `node_modules/` are git-ignored

## clide loop

- SBCL is the primary target; EGCL is supported as experimental, and
  both are kept in mind during development
- Work live in a REPL, loading the system through ASDF
- Run the implementation from `code/clide` (or a directory beneath it):
  the ocicl runtime starts at the working directory and walks up the
  parents looking for `ocicl.csv`; it never searches downward, so from
  the repo root it finds nothing and would try to install into a new
  `ocicl/` there
  - The result is cached on the first system lookup, so changing the
    directory later in a session does not change it
  - The setup snippet's `(:directory (uiop:getcwd))` source-registry
    entry is also non-recursive, so `clide.asd` must be in the working
    directory for ASDF to find `clide`
- Slynk on EGCL: fetch the fork with
  `ocicl install git+https://github.com/atgreen/sly@egcl`, then run
  `bash ocicl/sly-<rev>/slynk/run-egcl-slynk.sh 4005`
- Connect with `M-x sly-connect` to `127.0.0.1` port `4005`, with
  `(setq sly-contribs nil)` set first; contribs do not work on EGCL yet
- `(asdf:test-system "clide")` runs the fiveam suite (`clide/tests`)
  - `lib` tests cover framing (round trip, multibyte, EOF, bad header,
    bad JSON, truncated body)
  - `base` tests start a real server on an ephemeral port and drive it
    over a socket: handshake, wrong token, unknown method, concurrency
- Run the server by hand from `code/clide`:
  `CLIDE_TOKEN=secret sbcl --eval '(asdf:load-system "clide")'
  --eval '(clide:main)'`; it prints `{"port":N}` and then blocks
- Dependencies come from ocicl, pinned by `ocicl.csv`

## Integration

- In production, jekyl runs a first-launch build and starts clide from a
  saved core (see Architecture)
- In development, the host should load clide from the repo checkout
  (`code/clide`, which must be the working directory of the spawned
  process, for ocicl) and skip the build
- jekyl and clide talk JSON-RPC over a loopback socket
- jekyl sets `CLIDE_TOKEN` in the child's environment, reads the
  `{"port":N}` line from stdout, connects, sends `initialize` with the
  token, then `ping`
- Not yet designed: how jekyl is told to use the checkout in dev mode

## Combined check

A single `check` script is possible as a convenience on top of the loops:

- `check-types`
- Lisp tests on SBCL: `sbcl --non-interactive --eval
  '(asdf:test-system "clide")'`
- Lisp tests on EGCL: `egcl --eval '(asdf:test-system "clide")'`; `--eval`
  evaluates the form and exits
- jekyl tests, once they exist

The Lisp side cannot produce a shipped artifact at package time, because
clide is built on the user's machine at first launch. A Lisp step in the
build only verifies that clide loads and passes its tests.

## Packaging

- `.vscodeignore` keeps tests, docs, `code/jekyl`, build tooling and
  `node_modules` out of the VSIX
- `code/clide` ships inside the VSIX; the first-launch build loads it
- `npm run package` produces the VSIX via `vsce`
