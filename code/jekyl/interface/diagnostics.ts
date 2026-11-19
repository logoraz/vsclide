import * as vscode from "vscode";
import { CompileResult, NoteSeverity, atLeast } from "../base/language";
import { Range } from "../lib/forms";
import { shiftRange } from "../lib/completion";
import { Marked, markNotes } from "../lib/notes";

const SEVERITIES: Record<NoteSeverity, vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  information: vscode.DiagnosticSeverity.Information,
  hint: vscode.DiagnosticSeverity.Hint,
};

/**
 * What the compiler said about the code, in the editor: squiggles and
 * entries in the Problems panel. A note is kept as offsets and moves
 * with the edits above it, and goes when an edit touches it; compiling
 * a form again replaces what was said about that form, compiling a
 * file replaces what was said about the file.
 *
 * Settings, read when notes arrive:
 *
 *   vsclide.diagnostics.enabled          show notes at all
 *   vsclide.diagnostics.minimumSeverity  error, warning, information
 *                                        or hint: the least to show
 */
export class Diagnostics implements vscode.Disposable {
  private readonly collection =
    vscode.languages.createDiagnosticCollection("vsclide");
  private readonly marks = new Map<string, Marked[]>();
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor() {
    this.subscriptions.push(
      this.collection,
      vscode.workspace.onDidChangeTextDocument((event) =>
        this.edited(event),
      ),
      vscode.workspace.onDidCloseTextDocument((document) => {
        this.marks.delete(document.uri.toString());
        this.collection.delete(document.uri);
      }),
    );
  }

  /**
   * Record RESULT, from compiling the span WITHIN of DOCUMENT, as what
   * is known of that span.
   */
  update(
    document: vscode.TextDocument,
    within: Range,
    result: CompileResult,
  ): void {
    const config = vscode.workspace.getConfiguration("vsclide.diagnostics");
    const key = document.uri.toString();
    const kept = (this.marks.get(key) ?? []).filter(
      (mark) => mark.end <= within.start || mark.start >= within.end,
    );
    const least = config.get<NoteSeverity>("minimumSeverity", "information");
    const fresh = config.get<boolean>("enabled", true)
      ? markNotes(document.getText(), result.notes, within).filter((mark) =>
          atLeast(mark.severity, least),
        )
      : [];
    this.marks.set(key, [...kept, ...fresh]);
    this.publish(document);
  }

  /** Forget every note. */
  clear(): void {
    this.marks.clear();
    this.collection.clear();
  }

  private edited(event: vscode.TextDocumentChangeEvent): void {
    const key = event.document.uri.toString();
    let marks = this.marks.get(key);
    if (!marks || event.contentChanges.length === 0) return;
    // Later changes first, so each one's offsets still hold.
    const changes = [...event.contentChanges].sort(
      (a, b) => b.rangeOffset - a.rangeOffset,
    );
    for (const change of changes) {
      const edit = {
        start: change.rangeOffset,
        end: change.rangeOffset + change.rangeLength,
        length: change.text.length,
      };
      marks = marks.flatMap((mark) => {
        const moved = shiftRange(mark, edit);
        return moved ? [{ ...mark, ...moved }] : [];
      });
    }
    this.marks.set(key, marks);
    this.publish(event.document);
  }

  private publish(document: vscode.TextDocument): void {
    const marks = this.marks.get(document.uri.toString()) ?? [];
    this.collection.set(
      document.uri,
      marks.map((mark) => {
        const diagnostic = new vscode.Diagnostic(
          new vscode.Range(
            document.positionAt(mark.start),
            document.positionAt(mark.end),
          ),
          mark.message,
          SEVERITIES[mark.severity],
        );
        diagnostic.source = "vsclide";
        diagnostic.code = mark.code;
        return diagnostic;
      }),
    );
  }

  dispose(): void {
    this.subscriptions.forEach((subscription) => subscription.dispose());
  }
}
