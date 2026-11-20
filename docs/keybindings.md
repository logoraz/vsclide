# Key bindings

VSCLIDE ships two key sets. Both are always installed; the active one
is chosen by the `vsclide.keymap` setting.

| Value    | Style                                                                             |
| -------- | --------------------------------------------------------------------------------- |
| `auto`   | Default. `emacs` if Awesome Emacs Keymap is installed and enabled, else `vscode`. |
| `vscode` | Calva-like, plus VS Code debug keys.                                              |
| `emacs`  | SLY chords, checked against Awesome Emacs Keymap.                                 |

```json
"vsclide.keymap": "vscode"
```

Set it only to override detection. The extension never writes to user
settings.

Editor bindings are active when a Common Lisp file has focus
(`editorLangId == commonlisp`). Debugger bindings are active while the
VSCLIDE debugger is open (`vsclide.debugging`).

## Evaluate

| Command                  | VS Code                     | Emacs     |
| ------------------------ | --------------------------- | --------- |
| Evaluate top-level form  | `Alt+Enter`                 | `C-M-x`   |
| Evaluate last expression | `Ctrl+Enter` (no selection) | `C-x C-e` |
| Evaluate selection       | `Ctrl+Enter` (selection)    | `C-c C-r` |

In the VS Code set, `Ctrl+Enter` replaces Insert Line Below in Lisp
files (as Calva does in Clojure).

## Compile and load

| Command                | VS Code            | Emacs     |
| ---------------------- | ------------------ | --------- |
| Compile top-level form | `Ctrl+Alt+C C`     | `C-c C-c` |
| Compile and load file  | `Ctrl+Alt+C Enter` | `C-c C-k` |

## REPL and inspector

| Command            | VS Code        | Emacs     |
| ------------------ | -------------- | --------- |
| Open mREPL         | `Ctrl+Alt+C R` | `C-c C-z` |
| Inspect expression | `Ctrl+Alt+C I` | `C-c I`   |

## Completion and signature help

| Command            | VS Code                       | Emacs        |
| ------------------ | ----------------------------- | ------------ |
| Trigger completion | `Ctrl+Space` (editor default) | `Ctrl+Alt+I` |
| Signature help     | automatic on `Space` and `(`  | same         |

`Ctrl+Alt+I` is also bound by Awesome Emacs Keymap to the same command,
so there is no conflict.

## Stickers

| Command                  | VS Code              | Emacs           |
| ------------------------ | -------------------- | --------------- |
| Place or remove sticker  | `Ctrl+Alt+C S`       | `C-c C-s C-s`   |
| Replay recordings        | `Ctrl+Alt+C P`       | `C-c C-s C-r`   |
| Toggle break on stickers | `Ctrl+Alt+C B`       | `C-c C-s C-b`   |
| Fetch recordings         | `Ctrl+Alt+C F`       | `C-c C-s C-f`   |
| Clear stickers in form   | `Ctrl+Alt+C K`       | `C-c C-s C-k`   |
| Clear stickers in file   | `Ctrl+Alt+C Shift+K` | `C-c C-s C-S-k` |

"Toggle break on stickers" is slynk's global switch. Source-line
breakpoints (below) break independently of it.

## Debugger

Active while the debugger is open.

| Command       | VS Code        | Emacs       |
| ------------- | -------------- | ----------- |
| Show debugger | `Ctrl+Alt+C D` | `C-c C-d d` |
| Continue      | `F5`           | `C-c C-d c` |
| Abort         | `Shift+F5`     | `C-c C-d a` |
| Step into     | `F11`          | `C-c C-d s` |
| Step next     | `F10`          | `C-c C-d n` |
| Step out      | `Shift+F11`    | `C-c C-d o` |

The VS Code debug keys apply only when `vsclide.debugging` is set and
VS Code's own debugger is not active (`!inDebugMode`).

## Breakpoints

Source-line breakpoints use VS Code's gutter and built-in key, so they
are the same in both sets: click the gutter, or press `F9` to toggle a
breakpoint on the current line. Breakpoints are built on stickers and
take effect at the next compile of the enclosing form.

## Commands without default keys

Available from the command palette (`VSCLIDE:` prefix); bind them in
your own `keybindings.json` if wanted.

| Command                   | ID                             |
| ------------------------- | ------------------------------ |
| Connect                   | `vsclide.connect`              |
| Disconnect and Stop Lisp  | `vsclide.disconnect`           |
| Restart Lisp              | `vsclide.restart`              |
| Clear Compiler Notes      | `vsclide.clearNotes`           |
| Show Output               | `vsclide.showOutput`           |
| New mREPL                 | `vsclide.newRepl`              |
| Close mREPL               | `vsclide.closeRepl`            |
| Clear mREPL               | `vsclide.clearRepl`            |
| Show Inspector            | `vsclide.showInspector`        |
| Debugger Quit             | `vsclide.debugQuit`            |
| Toggle Break on Signals   | `vsclide.toggleBreakOnSignals` |
| Forget Sticker Recordings | `vsclide.stickerForget`        |
| Inspect Sticker Recording | `vsclide.stickerInspect`       |
