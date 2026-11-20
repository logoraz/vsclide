import * as vscode from "vscode";
import { Ide } from "../base/ide";
import { packageAt } from "../lib/forms";
import { indentRegion } from "../lib/indent";
import { IndentRules } from "../lib/indent-rules";

/** A line and the column to move it to. */
interface Placement {
  line: number;
  column: number;
}

/**
 * Indents Common Lisp the way an Emacs Lisp mode does: Tab places the
 * line the cursor is on, or every line of a selection; Enter places the
 * line it opens; Format Selection and Format Document place the lines
 * they cover. The rules are the standard table, over what the running
 * Lisp reports for the macros it has loaded (see lib/indent-rules.ts).
 * Indentation is always spaces.
 */
export class Indentation
  implements
    vscode.DocumentRangeFormattingEditProvider,
    vscode.DocumentFormattingEditProvider
{
  private packageName: string | undefined;

  /** The rules in force; the Lisp's reports are added to them. */
  readonly rules = new IndentRules(() => this.packageName);

  constructor(private readonly ide: Ide) {}

  /**
   * Register the commands and the listener for the Lisp's rules, and
   * return what to dispose of. A new connection starts with the table
   * alone, and asks the Lisp for what it knows.
   */
  register(): vscode.Disposable[] {
    return [
      new vscode.Disposable(
        this.ide.onEvent((event) => {
          if (event.type === "connected") {
            this.rules.clear();
            this.ide.startIndentation().catch(() => undefined);
          } else if (event.type === "indentation") {
            this.rules.update(event.rules);
          }
        }),
      ),
      vscode.commands.registerTextEditorCommand("vsclide.indent", (editor) =>
        this.indent(editor),
      ),
      vscode.commands.registerCommand("vsclide.newlineAndIndent", () =>
        this.newline(),
      ),
    ];
  }

  provideDocumentRangeFormattingEdits(
    document: vscode.TextDocument,
    range: vscode.Range,
  ): vscode.TextEdit[] {
    return this.edits(document, range.start.line, this.lastLine(range));
  }

  provideDocumentFormattingEdits(
    document: vscode.TextDocument,
  ): vscode.TextEdit[] {
    return this.edits(document, 0, document.lineCount - 1);
  }

  /** Return the last line RANGE covers; one that ends at column 0 is out. */
  private lastLine(range: vscode.Range): number {
    return range.end.character === 0 && range.end.line > range.start.line
      ? range.end.line - 1
      : range.end.line;
  }

  /**
   * Return where the lines FIRST to LAST of DOCUMENT should go. Blank
   * lines are placed only when BLANK is true.
   */
  private placements(
    document: vscode.TextDocument,
    first: number,
    last: number,
    blank = false,
  ): Placement[] {
    const text = document.getText();
    this.packageName = packageAt(
      text,
      document.offsetAt(new vscode.Position(first, 0)),
    );
    return indentRegion(text, first, last, this.rules, blank);
  }

  /** Return the edits that move lines FIRST to LAST to their places. */
  private edits(
    document: vscode.TextDocument,
    first: number,
    last: number,
  ): vscode.TextEdit[] {
    return this.placements(document, first, last).map(({ line, column }) =>
      vscode.TextEdit.replace(
        new vscode.Range(
          line,
          0,
          line,
          document.lineAt(line).firstNonWhitespaceCharacterIndex,
        ),
        " ".repeat(column),
      ),
    );
  }

  /** Tab: place the lines of every selection, keeping the cursors put. */
  private async indent(editor: vscode.TextEditor): Promise<void> {
    const document = editor.document;
    const selections = editor.selections;
    const ranges = this.mergedLines(selections);
    const moved = new Map<number, Placement>();
    const before = new Map<number, number>();
    const blank = selections.every((selection) => selection.isEmpty);
    for (const [first, last] of ranges) {
      const placed = this.placements(document, first, last, blank);
      for (const placement of placed) {
        moved.set(placement.line, placement);
      }
    }
    for (const line of this.linesOf(selections)) {
      before.set(line, document.lineAt(line).firstNonWhitespaceCharacterIndex);
    }
    if (moved.size > 0) {
      await editor.edit(
        (builder) => {
          for (const { line, column } of moved.values()) {
            builder.replace(
              new vscode.Range(line, 0, line, before.get(line) ?? 0),
              " ".repeat(column),
            );
          }
        },
        { undoStopBefore: true, undoStopAfter: true },
      );
    }
    editor.selections = selections.map((selection) => {
      const range = !selection.isEmpty;
      const carry = (position: vscode.Position, start: boolean) =>
        this.carry(position, before, moved, range && start);
      return new vscode.Selection(
        carry(selection.anchor, !selection.isReversed),
        carry(selection.active, selection.isReversed),
      );
    });
  }

  /**
   * Return where POSITION goes when its line is placed: a position in
   * the indentation, other than the very start of a selection's line,
   * goes to the text, and one in the text moves with it.
   */
  private carry(
    position: vscode.Position,
    before: Map<number, number>,
    moved: Map<number, Placement>,
    keepStart: boolean,
  ): vscode.Position {
    const old = before.get(position.line);
    if (old === undefined) return position;
    const now = moved.get(position.line)?.column ?? old;
    if (position.character === 0 && keepStart) return position;
    const character =
      position.character <= old ? now : position.character + (now - old);
    return position.with(undefined, character);
  }

  /** Return the distinct lines of SELECTIONS, one per cursor or more. */
  private linesOf(selections: readonly vscode.Selection[]): Set<number> {
    const lines = new Set<number>();
    for (const [first, last] of this.mergedLines(selections)) {
      for (let line = first; line <= last; line++) lines.add(line);
    }
    return lines;
  }

  /** Return the line spans SELECTIONS cover, sorted and not overlapping. */
  private mergedLines(
    selections: readonly vscode.Selection[],
  ): [number, number][] {
    const spans = selections
      .map((s): [number, number] => [s.start.line, this.lastLine(s)])
      .sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const span of spans) {
      const top = merged[merged.length - 1];
      if (top && span[0] <= top[1]) {
        top[1] = Math.max(top[1], span[1]);
      } else {
        merged.push([...span]);
      }
    }
    return merged;
  }

  /** Enter: break the line as usual, then place the line it opens. */
  private async newline(): Promise<void> {
    await vscode.commands.executeCommand("default:type", { text: "\n" });
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== "commonlisp") return;
    const document = editor.document;
    const lines = [
      ...new Set(editor.selections.map((s) => s.active.line)),
    ];
    const before = new Map<number, number>();
    const moved = new Map<number, Placement>();
    for (const line of lines) {
      before.set(line, document.lineAt(line).firstNonWhitespaceCharacterIndex);
      for (const placement of this.placements(document, line, line, true)) {
        moved.set(line, placement);
      }
    }
    if (moved.size === 0) return;
    const selections = editor.selections;
    await editor.edit(
      (builder) => {
        for (const { line, column } of moved.values()) {
          builder.replace(
            new vscode.Range(line, 0, line, before.get(line) ?? 0),
            " ".repeat(column),
          );
        }
      },
      { undoStopBefore: false, undoStopAfter: true },
    );
    editor.selections = selections.map((selection) => {
      const at = this.carry(selection.active, before, moved, false);
      return new vscode.Selection(at, at);
    });
  }
}
