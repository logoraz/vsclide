# vsclide: Architecture

A full-powered Common Lisp IDE for VS Code. Display name `:VSCLIDE`, MIT
licensed, hosted at github.com/logoraz/vsclide. This document describes
the system as it is; planned work is in Future work at the end.

## Goals

- No bundled image: the user supplies the Common Lisp implementation
  (SBCL today)
- Built in two arms, in this order:
  1. Slynk-based REPL and IDE features (built)
  2. A Climacs-style design for Lisp-side editing support, as a
     Lisp-side server for configurability and extensibility (planned)
- Highly configurable through VS Code settings
- The extension changes none of the user's settings

## Repository layout

```
vsclide/
├── .vscode/                  launch.json (F5), settings.json
├── LICENSE
├── README.md
├── package.json              main -> out/extension.js
├── esbuild.js                bundles jekyl into out/
├── code/
│   ├── clide/                Common Lisp side (one ASDF system)
│   │   ├── clide.asd         systems: clide, clide/tests
│   │   ├── clide.lisp        entry point: main
│   │   ├── version.sexp
│   │   ├── ocicl.csv         pinned dependencies
│   │   ├── base/             server, slynk-client, ide, location,
│   │   │                     stickers, debugger, inspector, language,
│   │   │                     compiler
│   │   ├── lib/              ansi-color, jsonrpc, slynk-wire
│   │   └── tests/
│   └── jekyl/                TypeScript side (extension host)
│       ├── tsconfig.json     type-check only (noEmit)
│       ├── extension.ts      activation and wiring
│       ├── base/             process, session, launch, ide, debugger,
│       │                     inspector, panel, language, stickers
│       ├── lib/              jsonrpc, forms, source-location,
│       │                     completion, notes, signature, stickers,
│       │                     keymap, sylvester
│       ├── interface/        everything that touches the VS Code API
│       ├── webview/          page scripts of the REPL and debugger
│       │                     (own tsconfig, DOM)
│       └── tests/
├── data/
│   ├── graphics/             icon
│   └── syntax/               TextMate grammar, language configuration
└── docs/
```

- Directories are named by role; there is no `src` directory
- Both languages live in one repo, as SLIME does with swank
- `.vscodeignore` keeps tests, docs, `code/jekyl`, `.vscode` and build
  tooling out of the VSIX

## Runtime

- jekyl spawns and supervises two processes of the user's Lisp
  - clide, for the JSON-RPC server
  - a slynk server for the user's code, started with
    `slynk:create-server :port 0 :dont-close t`, not `start-server`
    (which enables Emacs-only output redirection)
- Both listen on ephemeral loopback ports
- The implementation executable is the `vsclide.lisp.command` setting
  (default `sbcl`)
- clide runs from `code/clide`, so ocicl and ASDF resolve its systems;
  the slynk server runs from the workspace folder, so the user's
  systems are found
- clide starts from `code/clide` of the extension, a checkout under F5
  or the installed folder; an installed extension first runs
  `ocicl install` there (`base/setup.ts`), once per `ocicl.csv`, with
  a progress notice
- The slynk server loads the slynk pinned in `ocicl.csv` when it is
  installed, so clide and slynk match whatever the user's systems offer
- Implementation-specific code is guarded with reader conditionals;
  `ansi-color.lisp` checks for a terminal with `sb-unix:unix-isatty`

## clide

- clide speaks slynk; jekyl talks to clide
- clide is its own process, separate from the slynk server
- Dependencies are pinned in `ocicl.csv`; slynk is the ASDF system
  `slynk` (`cl-slynk` is only the Guix name)

### JSON-RPC server

- jekyl and clide speak JSON-RPC 2.0 over a loopback socket, so several
  clients and reconnects work
- Framing is LSP-style: a `Content-Length` header, a blank line, then a
  UTF-8 JSON body; the length counts bytes
- Handshake and token:
  - jekyl makes a per-session token and passes it in the `CLIDE_TOKEN`
    environment variable, never on the command line
  - clide prints `{"port":N}` on stdout once it is listening; stderr
    carries log output
  - The first message on every connection must be `initialize` with the
    token; anything else gets error `-32001` and the connection closes
  - Tokens are compared in constant time
- One thread per connection (bordeaux-threads); the method table is
  filled before the server starts, so it needs no lock
- Methods are plain functions of the params, registered by name;
  protocol failures use the standard JSON-RPC codes, a handler that
  signals gets `-32603`, an unknown method `-32601`
- Code: `lib/jsonrpc.lisp` (framing, constructors, codes),
  `base/server.lisp` (server struct, dispatch, handshake, lifecycle),
  `clide.lisp` (`main`)
- The server is a struct with named functions and no special variables

### Slynk connection and the ide methods

- `base/slynk-client.lisp` owns the socket; `lib/slynk-wire.lisp` is a
  safe reader that never interns or evaluates, so foreign symbols stay
  structs
- Prompts slynk sends (`:y-or-n-p` and kin) are answered with nil so no
  request hangs; `:debug` opens the debugger and is auto-aborted only
  when no handler is registered
- `base/ide.lisp` registers the `ide/*` methods and turns slynk events
  into notifications; the tables are `register-ide-method` and
  `register-event-handler`, and its header comment lists them all
- Error codes: `-32002` not connected, `-32003` slynk failure
- Evaluation binds `slynk::*echo-number-alist*` to nil so values are
  plain
- Contribs are separate systems (`slynk/mrepl`, `slynk/stickers`) and
  load on demand, as SLY does: the client keeps a list of enabled
  contribs (default `sly-fancy`), calls `slynk-add-load-paths`, then
  `slynk-require` for the modules the server has not loaded
- REPLs use `slynk/mrepl`, one channel per REPL; the next input is sent
  only after the prompt, to avoid slynk dropping it; notifications for a
  REPL can precede the reply that names it

## jekyl

- Logic is segregated into `base/` and `lib/`, mirroring clide
  - `base/ide.ts` is the controller and knows nothing of VS Code
  - `interface/` holds everything that touches the VS Code API
  - `lib/` holds pure helpers, such as `forms.ts`, which finds forms in
    text (top level, before the cursor, in-package)
  - `extension.ts` wires the pieces together
- esbuild bundles `extension.ts` into `out/extension.js` and the page
  scripts `webview/repl.ts` and `webview/debugger.ts` into
  `out/webview/`; `tsc --noEmit` only type-checks; `vscode` is external
  and the output is CommonJS for Node
- Tests are compiled separately, never bundled, and run with
  `node --test`

## REPL UI

- A panel view container (`viewsContainers.panel`, titled mREPL) with a
  webview view and a tab list on the right, as the Terminal has; the
  native list is internal to VS Code, so jekyl draws its own
- The panel opens empty; `VSCLIDE: Open mREPL` focuses it and opens a
  first REPL
- Enter sends, Shift+Enter adds a line, Up and Down recall history;
  Interrupt button and Ctrl+C; `view/title` buttons: new, clear, close
- A new mREPL starts with a Sylvester banner in hot pink; SLY's art and
  quips are GPL, so nothing is bundled: clide reads `sylvesters.txt`
  from the user's slynk install (`ide/sylvesters`), and without it only
  the words of encouragement are shown
- Package sync: evaluating or compiling from the editor sends
  `ide/repl/syncPackage` for the file's package (`guess-and-set-package`
  in the REPL's thread, as SLY's `C-c ~`); the new prompt arrives as
  `ide/repl/prompt`. Skipped when the REPL is busy, already there, or
  the image lacks the package; `lib/package-sync.ts` decides
- Settings: `vsclide.repl.openOnConnect` (default off),
  `vsclide.repl.sylvester` (default on), `vsclide.repl.syncPackage`
  (default on)
- Plain TypeScript in the webview; the REPL tab shows through a `when`
  context flag while a process runs

## Debugger and inspector

- One webview panel beside the editor with two tabs, Debugger and
  Inspector; the bottom mREPL is for the REPL only
- clide: `base/debugger.lisp` and `base/inspector.lisp` register the
  `ide/debug/*` and `ide/inspect/*` methods and their slynk event
  handlers
  - `:debug` becomes `ide/debug/open`; `:debug-activate`,
    `:debug-return` and `:debug-condition` follow
  - Debug requests go to the debugging thread by its id; restart, abort
    and step are fire and forget, since slynk answers with events
  - `ide/eval` takes `debug: true`, so errors in evaluated code open
    the debugger and the call returns when it is left; REPL errors open
    it too
  - Frame disassembly is left out; the SBCL backend lacks it
  - Inspector state lives in slynk, one inspector per connection;
    `more` is true when the next part is beyond the range loaded
- jekyl: `base/debugger.ts` and `base/inspector.ts` hold models that
  only follow events and replies; `base/panel.ts` builds the state the
  page draws; `interface/debug-panel.ts` owns the webview
  - The page keeps no state; it draws the whole state after each change
  - Digit keys 0 to 9 invoke restarts, as in SLY
  - Frame source: `lib/source-location.ts` maps a slynk location to an
    offset; a snippet wins over a position that has gone stale
  - A stop at a sticker or breakpoint is headlined as such
  - Context key `vsclide.debugging` and the status bar follow the open
    levels
- REPL values are clickable: `ide/repl/values` names each value by
  history entry and place, and `ide/inspect/replValue` inspects it in
  the REPL's own thread, as slynk requires

## Completion, definitions, references and compiler notes

- clide: `base/language.lisp` registers `ide/complete`, `ide/arglist`,
  `ide/documentation`, `ide/definitions` and `ide/xref`;
  `base/compiler.lisp`
  registers `ide/compile` and `ide/compileFile`; `base/location.lisp`
  turns slynk source locations into JSON
  - Completion is slynk's flex matching, so `mvb` finds
    `multiple-value-bind`; the package is that of the nearest
    `in-package` above the cursor
  - Definitions are those of what the image has loaded, no more
  - `ide/xref` asks slynk for who calls, who refers to and who
    macroexpands a name; Find All References (Shift+F12) shows them,
    with no panel of our own
  - `ide/compile` sends a string with its file and start offset; slynk
    compiles it as if from that place, so frames find their source and
    notes carry positions; the buffer is named after the file
  - An error while loading compiled code enters the debugger, as with
    `ide/eval`
- jekyl: `base/language.ts` parses the replies; `interface/completion.ts`,
  `definition.ts`, `references.ts` and `diagnostics.ts` are the VS Code
  providers
  - Without a connection they say nothing and start no Lisp
  - Completion is asked for again at each key, since matches depend on
    the whole pattern, and is skipped in strings and comments
  - Arglist and documentation arrive on `resolveCompletionItem`
  - A second backend, `document`, completes from the words of the file
    with no Lisp
  - Automatic or on-request-only completion is the editor's quick
    suggestions setting for Lisp files, which is the user's to set; for
    request only, put this in settings.json:
    `"[commonlisp]": {"editor.quickSuggestions": {"other": "off",
    "comments": "off", "strings": "off"}}`
  - Notes become diagnostics (`lib/notes.ts`): kept as offsets, moved by
    edits above them, dropped by edits on them, replaced on recompile
  - Positions count UTF-16 units in the editor and characters in Lisp
- Settings: `vsclide.completion.{enabled,mode,limit,documentation}`,
  `vsclide.definitions.enabled`, `vsclide.references.enabled`,
  `vsclide.diagnostics.{enabled,minimumSeverity}`

## Signature help, stickers and breakpoints

- Signature help (`interface/signature.ts`, `lib/signature.ts`) is
  client-side: the call the cursor is in is found from the text, the
  lambda list comes from `ide/arglist`, and the parameter being written
  is highlighted
  - Lists that are not calls, such as let bindings, defer to the list
    around them; quoted data is no call; strings and comments give none
  - `&optional` and `&rest` follow position; after `:name` the key
    highlights
  - Triggers: space and `(`; `)` refreshes it
  - Settings: `vsclide.signatureHelp.{enabled,documentation}`
- clide: `base/stickers.lisp` registers `ide/stickers/` compile, kill,
  fetch, search, forget, toggleBreak and inspect over slynk's stickers
  contrib, which `ensure-stickers` (in `base/ide.lisp`) loads on use
  - Stickers are the editor's marks; the image only knows their numbers
  - `compile` sends the wrapped text and the original; slynk falls back
    to the original (not stuck) when the wrapped one fails
  - A debugger entered for a sticker says so in its condition
    (`condition.sticker`: before, after or breakpoint)
- jekyl: `interface/stickers.ts` follows SLY's default behavior
  - Toggle a sticker on the selection or the sexp at point; clear a
    form's or a file's; stickers are decorations that move with edits
    and go when an edit touches them
  - Compiling a form or loading a file wraps each sticker in
    `slynk-stickers:record ID` and arms it
  - Looks: placed, armed, recorded, exited non-locally (theme colors
    `vsclide.sticker*`); hover shows the hit count and last values
  - Recordings are fetched after code runs and when the debugger
    returns (`vsclide.stickers.autoRefresh`)
  - Replay is a list over the playhead: next, previous, per sticker,
    jump to start or end, go to sticker, inspect a value, ignore a
    sticker or the deleted ones; it stays open while the inspector
    opens
  - Toggle Break on Stickers is slynk's global switch
  - Stickers deleted in the editor are sent to slynk with the next
    request (SLY's zombies); a new image knows none
- Breakpoints are the gutter's (`contributes.breakpoints`), as stickers
  that stop before their form, so no debug adapter is needed
  - On each compile a breakpoint's line is read again: its form is the
    largest list that starts on the line and is not top-level; the
    breakpoint's condition, if any, guards the stop
  - The stop calls `clide-image::break-here`, which clide defines in the
    image; it is independent of the global break switch
  - A line where nothing starts, or a form that cannot be wrapped (a
    let binding), does not stick
  - Breakpoints arm when compiled; plain evaluation does not instrument
  - Notes of a form compiled with stickers have positions shifted by the
    wrapping text

## Key bindings

- Two sets are always installed and the `vsclide.activeKeymap` context
  key picks the active one through the `when` clauses
  - `vsclide.keymap` is `auto` (default), `vscode` or `emacs`; `auto`
    selects the Emacs set when Awesome Emacs Keymap
    (`tuttieee.emacs-mcx`) is installed and enabled, and follows
    installs and removals live (`lib/keymap.ts`, `interface/keymap.ts`)
  - VS Code set: modeled on Calva and VS Code's own debugger keys
  - Emacs set: SLY's bindings, each checked against the bindings of
    Awesome Emacs Keymap
  - Editor bindings need a Common Lisp file with the text focused;
    debugger bindings need `vsclide.debugging`, and in the VS Code set
    not VS Code's own debug mode
- `tests/keybindings.test.ts` checks that every binding is in one set,
  runs a contributed command, repeats no key, hides no chord, and that
  the sets bind the same commands
- The full list is in [keybindings.md](keybindings.md)

## Syntax highlighting

- vsclide contributes its own `commonlisp` language, so no other
  extension is needed
  - `data/syntax/commonlisp.tmLanguage.json`: the TextMate grammar
  - `data/syntax/language-configuration.json`: comments, brackets,
    auto-closing pairs and the word pattern
- The grammar scopes definers, special operators, standard macros,
  keywords, specials, constants, packages, numbers, characters and
  reader macros; it does not scope ordinary calls, since telling a
  function from a variable needs more than a grammar
- Package names get three scopes: `:name` in `defpackage`
  (`entity.name.namespace.defined.keyword`), `#:name` in `defpackage`
  (`entity.name.namespace.defined.uninterned`), and elsewhere
  `constant.other.keyword` and `constant.other.uninterned`
- Colors ship as `configurationDefaults` in `package.json`, as
  `editor.tokenColorCustomizations` rules only; no theme is contributed,
  so the user's theme, background and window colors stay; a user's own
  customizations take precedence; the palette follows the maintainer's
  Lem setup
- Tests tokenize samples with vscode-textmate and resolve theme colors
  (`tests/grammar.test.ts`, `colors.test.ts`, `textmate.ts`)

## Packaging

- Linux only, for now
- `npm run package` builds a VSIX with `vsce`; `code/clide` ships in it
- `.vscodeignore` excludes tests, docs, `code/jekyl`, `.vscode`,
  `esbuild.js`, `package-lock.json`, `node_modules/**` and
  `**/tsconfig.json`
- The VSIX carries `ocicl.csv`, not the dependencies; the first launch
  runs `ocicl install`, which needs ocicl on the `PATH` or at
  `vsclide.ocicl.command`

## Future work

In this order.

### 1. Eclector completion backend

- A Lisp-side reader that tolerates incomplete and erroneous source,
  built on eclector; it is the base of the editing arm
- The lighter completion mode: no slynk needed, served by clide; the
  `document` backend in `interface/completion.ts` is the seam, and
  `vsclide.completion.mode` gains the new value
- `eclector` and a tokenizer return to `clide.asd`; ocicl currently
  fails to extract eclector ("file name contained an unexpected NUL
  byte"), which must be resolved first

### 2. Syntax highlighting guided by the eclector reader

- The reader decides what each symbol is, so the colors follow what the
  code means, not what a grammar guesses; layers, from first to last
  - Structural: from the eclector reader, immediate and Lisp-free
  - Dynamic: from slynk, over the layer below, so ordinary calls,
    variables and parameters can be told apart
- Both layers reach the editor as semantic tokens
- The colors stay: the palette in `configurationDefaults` is kept, and
  `semanticTokenScopes` maps each token type to the TextMate scope that
  already carries its color, so the maintainer's palette applies as it
  does now and the user's theme, background and own customizations are
  untouched
- Once the tokens cover what the grammar scopes, remove the static
  TextMate grammar and its tests; the language contribution and
  `language-configuration.json` stay

### 3. EGCL support

EGCL (Evergreen Common Lisp) is the second target after SBCL. Known so
far:

- EGCL keeps forks of libraries, installed through ocicl Git sources
  (`git+URL@branch`) and pinned by commit
- The SLY fork (`atgreen/sly`, branch `egcl`) has a single-threaded
  slynk backend; its `slynk.asd` does not register it, so
  `(asdf:load-system :slynk)` fails with "GRAY-PACKAGE-NAME not
  implemented"; `slynk/run-egcl-slynk.sh` loads the files in order
  (`ocicl install git+https://github.com/atgreen/sly@egcl`, then
  `bash ocicl/sly-<rev>/slynk/run-egcl-slynk.sh 4005`)
- A SLY client connects and evaluates with `sly-contribs` set to nil;
  with `sly-fancy` the connection failed (likely cause: ASDF loading the
  Guix `cl-slynk` over the fork; not confirmed)
- Untested on EGCL: mrepl (the fork stubs `slynk-gray`), stickers,
  inspector, completion, arglists, and clide's threads
  (bordeaux-threads failed to load)
- jekyl's slynk launch must follow the fork's explicit load sequence,
  and contribs must be loaded explicitly
- `interactive-stream-p` is always true for standard streams, so the
  terminal check needs `isatty` through `egcl-ffi`

### Later

- Faster start: build clide for the implementation into
  `context.globalStorageUri` and start from a saved core, falling back
  to the ASDF FASL cache
  - Cache key: clide version plus implementation and its version
  - A lock against concurrent windows, and errors that name the
    failing step
- Hermetic launch: skip the user's init files unless a setting opts in
- A terminal profile for a plain REPL
- One universal VSIX, published to Open VSX and the Microsoft
  marketplace (`vsce`, `ovsx`), with pinned dependencies and license
  notices for anything vendored

## Prior art

- Alive: TypeScript extension plus `alive-lsp` in Lisp; own LSP
  protocol, no swank; Unlicense
- OLIVE: a SLIME-style Common Lisp IDE for VS Code (not yet studied)
