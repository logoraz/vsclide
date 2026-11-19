import * as vscode from "vscode";
import { Ide } from "../base/ide";
import { Completion, tidyDocumentation } from "../base/language";
import { contextAt, flexScore, symbolBefore, wordsIn } from "../lib/completion";
import { packageAt } from "../lib/forms";

/** Where completions come from. */
type Mode = "slynk" | "document";

/** What slynk says a symbol is, most telling first. */
const KIND_ORDER: [string, vscode.CompletionItemKind][] = [
  ["macro", vscode.CompletionItemKind.Keyword],
  ["special-op", vscode.CompletionItemKind.Keyword],
  ["generic-fn", vscode.CompletionItemKind.Method],
  ["fn", vscode.CompletionItemKind.Function],
  ["cla", vscode.CompletionItemKind.Class],
  ["type", vscode.CompletionItemKind.TypeParameter],
  ["constant", vscode.CompletionItemKind.Constant],
  ["var", vscode.CompletionItemKind.Variable],
  ["pak", vscode.CompletionItemKind.Module],
];

/**
 * Return the item kind for KIND, slynk's classification of a symbol,
 * which may name several things separated by commas.
 */
export function itemKind(kind: string): vscode.CompletionItemKind {
  const kinds = kind.split(",");
  for (const [name, itemKind] of KIND_ORDER) {
    if (kinds.includes(name)) return itemKind;
  }
  return vscode.CompletionItemKind.Text;
}

/** A completion item that remembers what to look up for its popup. */
class LispItem extends vscode.CompletionItem {
  /** The symbol to ask slynk about, or undefined for a local word. */
  symbol: string | undefined;
  packageName: string | undefined;
}

/**
 * Completes symbols as one types in Common Lisp files. The settings it
 * follows, read at each request:
 *
 *   vsclide.completion.enabled        switch it off
 *   vsclide.completion.mode           slynk, or document for the words of
 *                                     the file, which needs no Lisp
 *   vsclide.completion.limit          how many items at most
 *   vsclide.completion.documentation  arglist and docstring beside the
 *                                     highlighted item
 *
 * Whether it opens while one types or only on request (Ctrl+Alt+I, the
 * Emacs M-TAB, which the extension binds) is the editor's quick
 * suggestions for the language, which vsclide.completion.trigger sets
 * (see applyTrigger).
 */
export class CompletionProvider implements vscode.CompletionItemProvider {
  /** The characters that open the list besides typing a name. */
  static readonly triggerCharacters = [":"];

  constructor(private readonly ide: Ide) {}

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.CompletionList | undefined> {
    const config = vscode.workspace.getConfiguration("vsclide.completion");
    if (!config.get<boolean>("enabled", true)) return undefined;
    const text = document.getText();
    const offset = document.offsetAt(position);
    if (contextAt(text, offset) !== "code") return undefined;
    const typed = symbolBefore(text, offset);
    if (!typed) return undefined;

    const mode = config.get<Mode>("mode", "slynk");
    const limit = config.get<number>("limit", 100);
    const packageName = packageAt(text, offset);
    const range = new vscode.Range(document.positionAt(typed.start), position);
    const items =
      mode === "document"
        ? this.fromDocument(text, typed.name, limit)
        : await this.fromSlynk(typed.name, packageName, limit);

    // The matches depend on what is typed, which is not always the
    // start of the label, so the list is asked for again as one types.
    return new vscode.CompletionList(
      items.map((item, index) => {
        item.range = range;
        item.filterText = typed.name;
        item.sortText = String(index).padStart(5, "0");
        item.packageName = packageName;
        return item;
      }),
      true,
    );
  }

  async resolveCompletionItem(
    item: vscode.CompletionItem,
  ): Promise<vscode.CompletionItem> {
    const lisp = item as LispItem;
    const config = vscode.workspace.getConfiguration("vsclide.completion");
    if (!lisp.symbol || !config.get<boolean>("documentation", true)) {
      return item;
    }
    const [arglist, documentation] = await Promise.all([
      this.ide.arglist(lisp.symbol, lisp.packageName).catch(() => undefined),
      this.ide
        .documentation(lisp.symbol, lisp.packageName)
        .catch(() => undefined),
    ]);
    const markdown = new vscode.MarkdownString();
    if (arglist) markdown.appendCodeblock(arglist, "commonlisp");
    if (documentation) {
      markdown.appendText(tidyDocumentation(documentation));
    }
    if (arglist || documentation) item.documentation = markdown;
    return item;
  }

  private async fromSlynk(
    prefix: string,
    packageName: string | undefined,
    limit: number,
  ): Promise<LispItem[]> {
    let completions: Completion[];
    try {
      completions = await this.ide.complete(prefix, packageName, limit);
    } catch {
      return [];
    }
    return completions.map((completion) => {
      const item = new LispItem(
        completion.label,
        itemKind(completion.kind),
      );
      item.detail = completion.kind;
      item.symbol = completion.label;
      return item;
    });
  }

  private fromDocument(
    text: string,
    prefix: string,
    limit: number,
  ): LispItem[] {
    const scored: { word: string; score: number }[] = [];
    for (const word of wordsIn(text)) {
      if (word.toLowerCase() === prefix.toLowerCase()) continue;
      const score = flexScore(prefix, word);
      if (score !== undefined) scored.push({ word, score });
    }
    scored.sort((a, b) => b.score - a.score || a.word.localeCompare(b.word));
    return scored.slice(0, limit).map(({ word }) => {
      const item = new LispItem(word, vscode.CompletionItemKind.Text);
      item.detail = "in this file";
      return item;
    });
  }
}

/** The quick suggestions of the editor when completion is by hand. */
const MANUAL = { other: "off", comments: "off", strings: "off" };

/**
 * Make the editor open completion as one types, or only on request,
 * as vsclide.completion.trigger says. Manual completion sets the
 * quick suggestions of Common Lisp files to off, in the user's
 * settings; going back to automatic removes that, if it is still what
 * was set here, so a setting of the user's own is left alone.
 */
export async function applyTrigger(): Promise<void> {
  const trigger = vscode.workspace
    .getConfiguration("vsclide.completion")
    .get<string>("trigger", "automatic");
  const editor = vscode.workspace.getConfiguration("editor", {
    languageId: "commonlisp",
  });
  const own = editor.inspect("quickSuggestions")?.globalLanguageValue;
  if (trigger === "manual") {
    if (own === undefined) {
      await editor.update(
        "quickSuggestions",
        MANUAL,
        vscode.ConfigurationTarget.Global,
        true,
      );
    }
  } else if (JSON.stringify(own) === JSON.stringify(MANUAL)) {
    await editor.update(
      "quickSuggestions",
      undefined,
      vscode.ConfigurationTarget.Global,
      true,
    );
  }
}
