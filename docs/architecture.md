# vsclide: Architecture

A full-powered Common Lisp IDE for VS Code. Display name `:VSCLIDE`,
MIT licensed, hosted on Codeberg.

## Goals

- No bundled image: the user supplies any Common Lisp implementation
  - SBCL is the primary target
  - EGCL (Evergreen Common Lisp) is supported as experimental
  - Both are kept in mind during development; other implementations later
- Uniform experience through pinned sources, not shared binaries
- Built in two arms, in this order:
  1. Slynk-based REPL and IDE features
  2. Later, a Climacs-style design for Lisp-side editing support, as a
     Lisp-side server for configurability and extensibility; it is
     crucial to the extension and is built on eclector (see below)

## Repository layout

```
vsclide/
├── .gitignore
├── .vscodeignore
├── .vscode/
│   └── settings.json
├── LICENSE
├── README.md
├── package.json              main -> out/extension.js
├── code/
│   ├── clide/                Common Lisp side (one ASDF system)
│   │   ├── clide.asd         subsystems: clide/tests, clide/docs planned
│   │   ├── clide.lisp        entry point: main
│   │   ├── version.sexp
│   │   ├── base/             server, slynk-client, ide, debugger,
│   │   │                     inspector
│   │   ├── lib/              ansi-color, jsonrpc, slynk-wire
│   │   └── tests/
│   └── jekyl/                TypeScript side (extension host)
│       ├── tsconfig.json     type-check only (noEmit)
│       ├── extension.ts      activation and wiring
│       ├── base/             process, session, launch, ide, debugger,
│       │                     inspector, panel
│       ├── lib/              jsonrpc, forms, source-location
│       ├── interface/        commands, results, status, repl,
│       │                     debug-panel
│       ├── webview/          REPL and debugger page scripts (own
│       │                     tsconfig, DOM)
│       └── tests/
├── data/
│   └── graphics/
│       └── lisp-icon-sm.svg  icon source; PNG for marketplace later
└── docs/
```

- Directories are named by role; no `src` convention
- Both languages live in one repo, as SLIME does with swank
- `.vscodeignore` excludes tests, docs, `code/jekyl`, `.vscode`

## Runtime

- The extension spawns and supervises the user's Lisp implementation
- Two separate processes:
  - A slynk server for the IDE
  - A plain REPL for the terminal, via a terminal profile
- Hermetic by default:
  - Init files not loaded unless a setting opts in
  - Slynk listens on an ephemeral loopback port
- Implementation path is a setting; SBCL is primary, EGCL experimental
- Implementation-specific code is guarded with `#+sbcl` and `#+egcl`;
  for example the terminal check in `ansi-color.lisp` uses
  `sb-unix:unix-isatty` on SBCL and `isatty` through `egcl-ffi` on EGCL
- First step: get slynk serving on SBCL, then bring EGCL along

## EGCL notes (experimental)

- EGCL maintains forks of libraries, installed through ocicl Git sources
  (`git+URL@branch`) and pinned by commit
- The SLY fork (`atgreen/sly`, branch `egcl`) has a slynk backend; it is
  single-threaded (communication style NIL)
- Its `slynk.asd` does not register the backend, so
  `(asdf:load-system :slynk)` fails with "GRAY-PACKAGE-NAME not implemented"
- `slynk/run-egcl-slynk.sh` loads the files explicitly, in order, and
  slynk then serves on a port
- Verified: with `sly-contribs` set to nil, a SLY client connects to
  the fork's slynk on EGCL and evaluates `(+ 1 2)`
- With `sly-fancy` contribs the connection failed; the log shows ASDF
  loading the Guix `cl-slynk` over the fork (likely cause, not confirmed)
- Contribs load through ASDF, so on EGCL they would need explicit loading
- The fork stubs `slynk-gray`, so mrepl may not work (untested)
- Untested on EGCL: mrepl, stickers, inspector, completion, arglists
- The slynk launch path differs per implementation: SBCL loads slynk
  through ASDF; EGCL uses the fork's explicit load sequence
- The swank fork is registered in `swank.asd` and loads through ASDF
- `interactive-stream-p` is always true for standard streams on EGCL, so
  the tty check uses `isatty` through the FFI

## Lisp side (clide)

- clide speaks slynk; jekyl talks to clide
- clide stays modular: its own process, separate from the slynk server
- jekyl and clide communicate over JSON-RPC 2.0 on a loopback socket
  - Chosen to support multiple clients and reconnects, as groundwork
    for the Climacs-style arm
  - clide listens on an ephemeral 127.0.0.1 port; jekyl connects
  - Stdout carries one JSON line announcing the port; stderr carries
    log output

### JSON-RPC server

- Framing is LSP-style: a `Content-Length` header, a blank line, then a
  UTF-8 JSON body; the length counts bytes
- Handshake and token:
  - jekyl generates a per-session token and passes it to clide in the
    `CLIDE_TOKEN` environment variable, never on the command line,
    where `ps` would show it
  - clide prints `{"port":N}` on stdout once it is listening
  - The first message on every connection must be `initialize` with the
    token in its params; anything else gets error `-32001`
    (unauthorized) and the connection closes
  - Tokens are compared in constant time
- Concurrency: one thread per connection (bordeaux-threads)
  - The method table is filled before the server starts, so it needs no
    lock; the connection registry has a lock
  - EGCL threading is unproven; SBCL is the reference
- Methods are plain functions of the params registered by name; the
  built-in method is `ping`, which returns `"pong"`
- Errors: protocol failures use the standard JSON-RPC codes; a handler
  that signals gets `-32603`; unknown methods get `-32601`
- Code layout:
  - `lib/jsonrpc.lisp`: framing, message constructors, error codes
  - `base/server.lisp`: server struct, dispatch, handshake, lifecycle
  - `clide.lisp`: `main`, built-in methods
- The server is a struct with named functions and no special variables;
  the server is passed explicitly and its log function is a slot

### Editing arm (deferred)

- The Climacs-style arm needs a Lisp reader that tolerates incomplete
  and erroneous source; eclector is the intended basis
- It is deferred, not dropped: `eclector` and `base/tokenizer.lisp` are
  out of the ASDF system for now and return when that arm starts
- ocicl currently fails to extract eclector ("file name contained an
  unexpected NUL byte"); resolve this before the arm starts

- Slynk is the ASDF system `slynk` (`cl-slynk` is only the Guix name)
- Contribs are separate systems (`slynk/mrepl`, `slynk/stickers`, ...)
- Contribs load on demand, as SLY does:
  - The client keeps a list of enabled contribs
  - Default is `sly-fancy` only
  - On connect it calls `slynk-add-load-paths`, then `slynk-require`
    for the modules the server has not loaded yet
  - Modules already loaded are skipped

### Slynk connection and the ide methods

- clide is a slynk client; `base/slynk-client.lisp` owns the socket
  - Wire codec in `lib/slynk-wire.lisp`: a safe reader that never
    interns or evaluates; foreign symbols stay structs
  - Prompts slynk sends (`:y-or-n-p` and kin) are answered with nil
    so no request hangs; `:debug` opens the debugger (below)
    and is auto-aborted only when no handler is registered
- jekyl starts the slynk server itself with
  `slynk:create-server :port 0 :dont-close t`, not `start-server`
  (which enables Emacs-only output redirection)
- `base/ide.lisp` registers `ide/*` methods and turns slynk events
  into notifications; the header comment lists all of them
- Error codes: -32002 not connected, -32003 slynk failure
- Evaluation binds `slynk::*echo-number-alist*` to nil so values are
  plain; REPL text is kept verbatim, with slynk's number decoration
- REPLs use `slynk/mrepl`, one channel per REPL; the next input is
  sent only after the prompt, to avoid slynk dropping it
- Notifications for a REPL can precede the reply that names it
- EGCL is untested with slynk-gray and mrepl

## First-launch build

- On activation, check for a build matching clide version and
  implementation; build it if missing
- Run the implementation headless, load clide through ASDF, optionally
  save a core
- Store results in `context.globalStorageUri`, not the install directory
- Cache key: clide version plus implementation and its version
- Show progress with `vscode.window.withProgress`; full output goes to
  an output channel
- Lock file prevents concurrent builds from multiple windows
- The build saves a core with clide preloaded; the IDE starts from it
- If saving the core fails, fall back to the ASDF FASL cache, with
  slower startup
- Failures matter most: errors must name the failing step
- Dependencies are fetched with ocicl by default, pinned by `ocicl.csv`
  - A setting lets the user override the acquisition method

## Extension side (jekyl)

- Logic is segregated into `base/` and `lib/`, mirroring clide
- Responsibilities to place within them: process supervision, command
  registration, settings, views
- Entry point `code/jekyl/extension.ts` wires the pieces together
  - `base/ide.ts` is the controller; it knows nothing of VS Code
  - `interface/` holds everything that touches the VS Code API
  - `lib/forms.ts` finds forms in text (top level, before cursor,
    in-package); a stand-in for the future editing arm
- Build follows the official bundling guidance, adapted to our layout:
  - esbuild bundles `code/jekyl/extension.ts` into `out/extension.js`
    and the two page scripts `webview/repl.ts` and
    `webview/debugger.ts` into `out/webview/`
  - `main` in `package.json` still points at `./out/extension.js`
  - `tsc --noEmit` only type-checks; esbuild strips types unchecked
  - `vscode` is external; output is CommonJS for Node
  - Production bundles are minified; development builds have source maps
  - Tests are compiled separately, never bundled
- The official layout (`src/`, `dist/`) is a sample, not a requirement
- Build scripts in `package.json`:
  - `check-types`, `compile`, `watch`
  - `bundle` (production), run by `vscode:prepublish`
  - `package` runs `vsce package`
- `esbuild.js` at the repo root is the build script
- Slynk was chosen over swank for mrepl, stickers and richer features
  - Cost: sparse protocol docs and few non-Emacs clients to compare with

## REPL UI

- A panel view container (`viewsContainers.panel`, titled mREPL) with
  a webview view; the tab list on the right appears with two REPLs
  - Enter sends, Shift+Enter adds a line, Up and Down recall history
  - Interrupt button and Ctrl+C
  - `view/title` buttons: new, clear, close
- The panel opens empty, as the terminal does; `VSCLIDE: Open mREPL`
  focuses it and opens a first REPL
- A new mREPL starts with a Sylvester banner
  - SLY's art and quips are GPL, so nothing is bundled
  - clide reads `sylvesters.txt` from the user's slynk install
    (`ide/sylvesters`); words of encouragement are original
  - Without the file only the words of encouragement are shown
- Plain TypeScript in the webview; no React needed
- Mimics a slynk mrepl: one REPL per channel
- A list on the right of the panel, like the terminal tabs list
  - The native list is internal to VS Code, so we build our own
- The REPL tab shows when a process starts, via a `when` context flag

## Debugger and inspector

- One webview panel beside the editor with two tabs, Debugger and
  Inspector; the bottom mREPL stays for the REPL only
- clide: `base/debugger.lisp` and `base/inspector.lisp` register
  their `ide/debug/*` and `ide/inspect/*` methods through
  `register-ide-method`, and their slynk event handlers through
  `register-event-handler`; `base/ide.lisp` holds the tables
  - `:debug` becomes `ide/debug/open`; `:debug-activate`,
    `:debug-return` and `:debug-condition` follow
  - Debug requests go to the debugging thread by its id
  - Restart, abort, step and kin are fire and forget: slynk answers
    them with events, not replies
  - `ide/eval` takes `debug: true`, so errors in evaluated code open
    the debugger and the call returns when it is left; REPL errors
    open it too
  - Frame disassembly is left out; the SBCL backend lacks it
  - Inspector state lives in slynk, one inspector per connection;
    `more` is true when the next part is beyond the range loaded
- jekyl: `base/debugger.ts` and `base/inspector.ts` hold models that
  only follow events and replies; `base/panel.ts` builds the state
  the page draws; `interface/debug-panel.ts` owns the webview
  - The page keeps no state of its own; it gets the whole state after
    each change and draws it; inputs persist across redraws
  - Digit keys 0 to 9 invoke restarts, as in SLY
  - Frame source: `lib/source-location.ts` maps the slynk location
    to an offset; a snippet wins over a position that has gone stale
  - Context key `vsclide.debugging` and the status bar follow the
    open levels
- Deferred: stickers, source line breakpoints

## Syntax highlighting

- vsclide contributes its own `commonlisp` language, so no other
  extension is needed for it
  - `data/syntax/commonlisp.tmLanguage.json`: the TextMate grammar
  - `data/syntax/language-configuration.json`: comments, brackets,
    auto-closing pairs and the word pattern
- Layers, from first to last
  - Static: the TextMate grammar; no Lisp process needed
  - Structural: the climacs-like arm, immediate and Lisp-free
  - Dynamic: the slynk arm, as semantic tokens over the layers below
- The grammar scopes definers, special operators, standard macros,
  keywords, specials, constants, packages, numbers, characters and
  reader macros
- It does not scope ordinary calls; telling a function from a variable
  needs the semantic layer, and guessing colors parameters wrongly
- Package names get three scopes
  - `:name` in `defpackage`: `entity.name.namespace.defined.keyword`
  - `#:name` in `defpackage`: `entity.name.namespace.defined.uninterned`
  - elsewhere: `constant.other.keyword` and `constant.other.uninterned`
- Colors ship as `configurationDefaults` in `package.json`
  - They set `editor.tokenColorCustomizations` rules only
  - No theme is contributed, so the user's theme, background and
    window colors stay as they are
  - Rules use the exact scopes the grammar emits, so they touch only
    Lisp and outrank a theme's shorter scopes (the longest scope wins)
  - The palette follows the maintainer's Lem setup
  - A user's own `editor.tokenColorCustomizations` takes precedence
- Tests tokenize samples with vscode-textmate and resolve theme colors
  (`tests/grammar.test.ts`, `tests/colors.test.ts`, `tests/textmate.ts`)

## Packaging and distribution

- Launch target: Linux only, for now
- One universal VSIX; no platform-specific images
- Publish to Open VSX and the Microsoft marketplace (`vsce`, `ovsx`)
- Pin dependency versions; ship license notices for anything vendored
- `code/clide` ships inside the VSIX; the first-launch build loads it
- `.vscodeignore` also excludes `esbuild.js`, `package-lock.json`,
  `node_modules/**` and `**/tsconfig.json`

## Prior art

- Alive: TypeScript extension plus `alive-lsp` in Lisp; own LSP
  protocol, no swank; Unlicense
- OLIVE: a SLIME-style Common Lisp IDE for VS Code (not yet studied)

## Open questions

None at present.
