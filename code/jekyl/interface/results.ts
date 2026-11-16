import * as vscode from "vscode";
import { EvalResult } from "../base/ide";

const MAX_INLINE = 120;

/**
 * Shows evaluation results: the value after the evaluated form, as an
 * inline decoration, and everything in the VSCLIDE output channel.
 */
export class Results implements vscode.Disposable {
  private readonly decoration =
    vscode.window.createTextEditorDecorationType({
      after: {
        margin: "0 0 0 1.5em",
        color: new vscode.ThemeColor("editorCodeLens.foreground"),
      },
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
  private readonly subscriptions: vscode.Disposable[] = [];
  private shown: vscode.TextEditor | undefined;

  /** OUTPUT is the VSCLIDE channel that receives the full text. */
  constructor(private readonly output: vscode.OutputChannel) {
    // An edit or a move of the cursor makes the old result stale.
    this.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document === this.shown?.document) this.clear();
      }),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (event.textEditor === this.shown) this.clear();
      }),
    );
  }

  /** Show RESULT after the last line of RANGE in EDITOR. */
  show(
    editor: vscode.TextEditor,
    range: vscode.Range,
    code: string,
    result: EvalResult,
  ): void {
    this.log(code, result);
    const text = result.ok
      ? `=> ${result.value ?? ""}`
      : `error: ${result.error ?? "unknown"}`;
    this.clear();
    const line = editor.document.lineAt(range.end.line);
    const hover = new vscode.MarkdownString();
    hover.appendCodeblock(
      [result.output, result.ok ? result.value : result.error]
        .filter((part) => part)
        .join("\n"),
      "text",
    );
    editor.setDecorations(this.decoration, [
      {
        range: line.range,
        hoverMessage: hover,
        renderOptions: { after: { contentText: summary(text) } },
      },
    ]);
    this.shown = editor;
    if (!result.ok) void vscode.window.setStatusBarMessage(text, 5000);
  }

  /** Append the evaluation to the output channel. */
  log(code: string, result: EvalResult): void {
    this.output.appendLine(`> ${code.trim().split("\n").join("\n  ")}`);
    if (result.output) this.output.append(result.output);
    if (!result.output.endsWith("\n") && result.output) {
      this.output.appendLine("");
    }
    this.output.appendLine(
      result.ok ? `=> ${result.value ?? ""}` : `error: ${result.error ?? ""}`,
    );
  }

  /** Remove the inline result. */
  clear(): void {
    this.shown?.setDecorations(this.decoration, []);
    this.shown = undefined;
  }

  dispose(): void {
    this.clear();
    this.decoration.dispose();
    this.subscriptions.forEach((subscription) => subscription.dispose());
  }
}

/** Return TEXT on one line, cut to a length that fits beside code. */
function summary(text: string): string {
  const line = text.replace(/\s+/g, " ");
  if (line.length <= MAX_INLINE) return line;
  return `${line.slice(0, MAX_INLINE - 1)}…`;
}
