# :VSCLIDE

A full-powered Common Lisp IDE for VS Code.

> **Status:** early development, version 0.0.7. It runs from a checkout
> in an Extension Development Host; there is no marketplace release yet.


## Features

- **mREPL:** a REPL panel with several REPLs; values are clickable and
  open the inspector
- **Evaluate and compile:** top-level form, last expression, selection,
  form or whole file, with compiler notes in the Problems panel
- **Completion, signature help and go to definition:** from the running
  Lisp
- **Debugger and inspector:** a side panel with restarts, frames, stepping
  and source locations
- **Stickers:** SLY's stickers; mark forms, record values, replay them
- **Breakpoints:** the gutter's, on top of stickers
- **Syntax highlighting:** its own grammar; your theme stays as it is
- **Key bindings:** a VS Code style set and an SLY and Emacs set


## How it works

VSCLIDE has two parts:

- **clide**, written in Common Lisp, speaks slynk to a running Lisp and
  serves the extension over JSON-RPC on a loopback socket.
- **jekyl**, written in TypeScript, is the VS Code extension. It starts
  clide and provides the editor-facing features.

You bring your own Lisp implementation. See
[docs/architecture.md](docs/architecture.md) for the design.


## Requirements

- Linux
- SBCL, with [ocicl](https://github.com/ocicl/ocicl) set up, and slynk
  loadable by ASDF in your Lisp
- Node.js and npm, to build the extension
- VS Code or VSCodium


## Quick start

From a checkout, until a release exists:

```sh
npm install
npm run compile
(cd code/clide && ocicl install)
```

Open the folder in VS Code and press F5 to start an Extension
Development Host. Open a `.lisp` file there and evaluate a form; the
first evaluation starts Lisp, or run `VSCLIDE: Connect`.
[docs/contributing.md](docs/contributing.md) has the details.


## Usage

- Every command is in the palette under `VSCLIDE:`.
- Key bindings come in two sets, chosen by `vsclide.keymap`: `auto`
  (the default) picks the Emacs set when Awesome Emacs Keymap is
  installed, otherwise the VS Code set. See
  [docs/keybindings.md](docs/keybindings.md).
- Settings, all under `vsclide.`:

  | Setting                | Controls                                          |
  |------------------------|---------------------------------------------------|
  | `lisp.command`         | the Lisp executable (default `sbcl`)              |
  | `keymap`               | the key set: `auto`, `vscode` or `emacs`          |
  | `repl.*`               | opening on connect, Sylvester's art, package sync |
  | `completion.*`         | the completion source, limit and documentation    |
  | `definitions.enabled`  | go to definition                                  |
  | `references.enabled`   | find all references                               |
  | `diagnostics.*`        | compiler notes in the editor                      |
  | `signatureHelp.*`      | the lambda list popup                             |
  | `stickers.autoRefresh` | fetching recordings after code runs               |

VSCLIDE never changes your settings.


## Documentation

- [docs/architecture.md](docs/architecture.md): the design
- [docs/keybindings.md](docs/keybindings.md): the key bindings
- [docs/contributing.md](docs/contributing.md): building and contributing


## License

```lisp
(defmacro license-terms (system . plist)
  "See LICENSE for the actual legally-binding, non-parenthesized version."
  (declare (optimize (safety 0))) ; use at your own risk
  `(list :system ',system ,@plist))

(license-terms vsclide
  :type        '(:MIT . "https://spdx.org/licenses/MIT.html")
  :permissions '(:use :copy :modify :merge :publish :distribute
                 :sublicense :sell)
  :conditions  '(:include-copyright-notice
                 :include-license-notice)
  :warranty    nil)
```

↳ [LICENSE](LICENSE)

<p align="center">
  <img src="data/graphics/lisp-icon-sm.svg"
       height="150" vspace="15" align="absmiddle" />
</p>
