import * as vscode from "vscode";
import { EvalResult, Ide } from "../base/ide";
import {
  Range,
  formBefore,
  packageAt,
  scanForms,
  topLevelFormAt,
} from "../lib/forms";
import { ReplView } from "./repl";
import { Results } from "./results";
import { Status } from "./status";

/** What the commands work with. */
export interface CommandContext {
  ide: Ide;
  results: Results;
  status: Status;
  repl: ReplView;
  output: vscode.OutputChannel;
}

/** Return the active editor if it holds Lisp, else tell the user. */
function lispEditor(): vscode.TextEditor | undefined {
  const editor = vscode.window.activeTextEditor;
  if (editor?.document.languageId === "commonlisp") return editor;
  void vscode.window.showInformationMessage(
    "VSCLIDE: open a Common Lisp file first.",
  );
  return undefined;
}

/** Return what OFFSETS span in the document as an editor range. */
function toRange(document: vscode.TextDocument, range: Range): vscode.Range {
  return new vscode.Range(
    document.positionAt(range.start),
    document.positionAt(range.end),
  );
}

/**
 * Evaluate what PICK chooses in the active editor and show the result.
 * PICK gets the text, the cursor offset and the selection (if any),
 * and returns the span to evaluate or undefined for none.
 */
async function evaluateIn(
  context: CommandContext,
  pick: (text: string, offset: number, selection: Range | undefined) =>
    Range | undefined,
): Promise<void> {
  const editor = lispEditor();
  if (!editor) return;
  const document = editor.document;
  const text = document.getText();
  const offset = document.offsetAt(editor.selection.active);
  const selection = editor.selection.isEmpty
    ? undefined
    : {
        start: document.offsetAt(editor.selection.start),
        end: document.offsetAt(editor.selection.end),
      };
  const span = pick(text, offset, selection);
  if (!span) {
    void vscode.window.showInformationMessage("VSCLIDE: no form here.");
    return;
  }
  const code = text.slice(span.start, span.end);
  const packageName = packageAt(text, span.start);
  try {
    context.status.connecting();
    // Slynk reads one form per evaluation, so a span holding several,
    // such as a selection, is evaluated form by form. It stops at the
    // first error and shows the last result.
    const forms = scanForms(code).top.map((range) =>
      code.slice(range.start, range.end),
    );
    let result: EvalResult | undefined;
    let last = code;
    for (const form of forms.length > 0 ? forms : [code]) {
      if (result) context.results.log(last, result);
      last = form;
      result = await context.ide.evaluate(form, packageName);
      if (!result.ok) break;
    }
    context.status.render();
    if (result) {
      context.results.show(editor, toRange(document, span), last, result);
    }
  } catch (error) {
    context.status.render();
    context.output.show(true);
    void vscode.window.showErrorMessage(
      `VSCLIDE: ${(error as Error).message}`,
    );
  }
}

/** Run ACTION; show a failure as an error message and in the log. */
async function guarded(
  context: CommandContext,
  action: () => Promise<void>,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    context.status.render();
    context.output.show(true);
    void vscode.window.showErrorMessage(
      `VSCLIDE: ${(error as Error).message}`,
    );
  }
}

/**
 * Register the commands of package.json and return their disposables.
 * Evaluation commands refuse files that are not Common Lisp.
 */
export function registerCommands(
  context: CommandContext,
): vscode.Disposable[] {
  const register = (name: string, action: () => Promise<void>) =>
    vscode.commands.registerCommand(`vsclide.${name}`, action);

  return [
    register("connect", () =>
      guarded(context, async () => {
        context.status.connecting();
        const info = await context.ide.connect();
        context.status.render();
        const { name, version } = info.implementation;
        void vscode.window.showInformationMessage(
          `VSCLIDE: connected to ${name} ${version}`,
        );
      }),
    ),
    register("disconnect", () =>
      guarded(context, async () => {
        await context.ide.disconnect();
        context.status.render();
      }),
    ),
    register("restart", () =>
      guarded(context, async () => {
        context.status.connecting();
        await context.ide.disconnect();
        await context.ide.connect();
        context.status.render();
      }),
    ),
    register("evalTopLevelForm", () =>
      evaluateIn(context, (text, offset, selection) =>
        selection ?? topLevelFormAt(text, offset, scanForms(text))),
    ),
    register("evalLastExpression", () =>
      evaluateIn(context, (text, offset, selection) =>
        selection ?? formBefore(text, offset, scanForms(text))),
    ),
    register("evalSelection", () =>
      evaluateIn(context, (_text, _offset, selection) => selection),
    ),
    register("openRepl", () => guarded(context, () => context.repl.open())),
    register("newRepl", () => guarded(context, () => context.repl.create())),
    register("closeRepl", () =>
      guarded(context, () => context.repl.closeActive()),
    ),
    register("clearRepl", async () => context.repl.clearActive()),
    register("showOutput", async () => context.output.show(true)),
  ];
}
