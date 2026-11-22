import * as vscode from "vscode";
import { Ide } from "../base/ide";
import { Features } from "../lib/features";
import { byLine, scan } from "../lib/highlight";
import { IndentRules } from "../lib/indent-rules";

/** The token types, in the order of the legend. */
const TYPES = ["macro", "suppressed"] as const;

/** Milliseconds to wait for more rules before colouring again. */
const SETTLE = 150;

/**
 * Colours what the grammar cannot know, with semantic tokens: calls to
 * macros the running Lisp has loaded, in the colour of the standard
 * macros, and forms that `#+` and `#-` remove for this image, as a
 * comment. Both follow the image: loading a macro, or a change of
 * *features*, recolours the open files. See lib/highlight.ts.
 */
export class Highlighting implements vscode.DocumentSemanticTokensProvider {
  /** The features of the connected image; a fallback when none. */
  readonly features = new Features();

  readonly legend = new vscode.SemanticTokensLegend([...TYPES]);

  private readonly changed = new vscode.EventEmitter<void>();
  private timer: NodeJS.Timeout | undefined;

  readonly onDidChangeSemanticTokens = this.changed.event;

  /**
   * Bracket pair colouring paints over a token's colour, so the
   * suppressed forms are also dimmed by a decoration, which wins. The
   * colour is that of comments in the defaults.
   */
  private readonly dim = vscode.window.createTextEditorDecorationType({
    textDecoration: "none; color: #707070 !important;",
  });

  /** RULES are those the Lisp has reported; see Indentation. */
  constructor(
    private readonly ide: Ide,
    private readonly rules: IndentRules,
  ) {}

  /** Listen to the image, and return what to dispose of. */
  register(): vscode.Disposable[] {
    this.dimAll();
    return [
      this.changed,
      this.dim,
      vscode.window.onDidChangeVisibleTextEditors(() => this.dimAll()),
      vscode.workspace.onDidChangeTextDocument((change) => {
        for (const editor of vscode.window.visibleTextEditors) {
          if (editor.document === change.document) this.dimEditor(editor);
        }
      }),
      new vscode.Disposable(() => clearTimeout(this.timer)),
      new vscode.Disposable(
        this.ide.onEvent((event) => {
          if (event.type === "connected") {
            this.images.set(event.connectionId, event.info.features ?? []);
          } else if (event.type === "features") {
            this.images.set(event.connectionId, event.features);
          } else if (event.type === "disconnected") {
            this.images.delete(event.connectionId);
          }
          if (
            event.type === "connected" ||
            event.type === "features" ||
            event.type === "disconnected" ||
            event.type === "indentation" ||
            event.type === "active"
          ) {
            this.follow();
          }
        }),
      ),
      vscode.workspace.onDidChangeConfiguration((change) => {
        if (change.affectsConfiguration("vsclide.highlighting")) {
          this.refresh();
        }
      }),
    ];
  }

  /** The features each connection's image reported, by connection id. */
  private readonly images = new Map<number, string[]>();

  /**
   * Take the features of the active connection, as the editor follows
   * that image, and colour the open files again.
   */
  private follow(): void {
    const id = this.ide.active?.id;
    const names = id === undefined ? undefined : this.images.get(id);
    this.features.clear();
    if (names) this.features.set(names);
    this.refresh();
  }

  /** Ask for the open files to be coloured again, soon. */
  private refresh(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.changed.fire();
      this.dimAll();
    }, SETTLE);
  }

  /** Dim the suppressed forms of every visible Lisp editor. */
  dimAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.dimEditor(editor);
    }
  }

  /** Dim the suppressed forms of EDITOR, or undim it when off. */
  private dimEditor(editor: vscode.TextEditor): void {
    const { document } = editor;
    if (document.languageId !== "commonlisp") return;
    const config = vscode.workspace.getConfiguration("vsclide.highlighting");
    const ranges = config.get<boolean>("suppressedForms", true)
      ? scan(document.getText(), () => false, this.features)
          .filter((span) => span.kind === "suppressed")
          .map(
            (span) =>
              new vscode.Range(
                document.positionAt(span.start),
                document.positionAt(span.end),
              ),
          )
      : [];
    editor.setDecorations(this.dim, ranges);
  }

  provideDocumentSemanticTokens(
    document: vscode.TextDocument,
  ): vscode.SemanticTokens {
    const config = vscode.workspace.getConfiguration("vsclide.highlighting");
    const macros = config.get<boolean>("loadedMacros", true);
    const suppressed = config.get<boolean>("suppressedForms", true);
    const builder = new vscode.SemanticTokensBuilder(this.legend);
    if (!macros && !suppressed) return builder.build();
    const spans = scan(
      document.getText(),
      (name) => macros && this.rules.hasLive(name),
      this.features,
    ).filter((span) => suppressed || span.kind === "macro");
    for (const piece of byLine(document.getText(), spans)) {
      builder.push(
        piece.line,
        piece.char,
        piece.length,
        TYPES.indexOf(piece.kind),
      );
    }
    return builder.build();
  }
}
