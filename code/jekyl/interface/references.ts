import * as vscode from "vscode";
import { Ide } from "../base/ide";
import { SourceLocation, locationFile } from "../base/debugger";
import { symbolAround } from "../lib/completion";
import { packageAt } from "../lib/forms";
import { locationOffset } from "../lib/source-location";
import { xrefKinds } from "../base/language";

/**
 * Takes Shift+F12, Find All References, to where a symbol is called,
 * macroexpanded, bound, referred to, set or specialized, as far as the
 * Lisp knows: what is loaded into it, and no more. VS Code shows the
 * list; there is no panel of our own.
 *
 * It follows vsclide.references.enabled, searches the kinds in
 * vsclide.references.kinds, and does nothing when there is no
 * connection: it never starts a Lisp.
 */
export class ReferenceProvider implements vscode.ReferenceProvider {
  constructor(private readonly ide: Ide) {}

  async provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.Location[] | undefined> {
    const settings = vscode.workspace.getConfiguration("vsclide.references");
    if (!settings.get<boolean>("enabled", true) || !this.ide.connected) {
      return undefined;
    }
    const text = document.getText();
    const offset = document.offsetAt(position);
    const symbol = symbolAround(text, offset);
    if (!symbol) return undefined;

    let references;
    try {
      references = await this.ide.xref(
        symbol.name,
        packageAt(text, offset),
        xrefKinds(settings.get("kinds")),
      );
    } catch {
      return undefined;
    }
    const found: vscode.Location[] = [];
    const seen = new Set<string>();
    for (const reference of references) {
      const location = await this.locate(reference.location);
      if (!location) continue;
      const key = `${location.uri.toString()}:${location.range.start.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push(location);
    }
    return found.length > 0 ? found : undefined;
  }

  /** Return the place LOCATION names in an editor, or undefined. */
  private async locate(
    location: SourceLocation | null,
  ): Promise<vscode.Location | undefined> {
    if (!location || location.error) return undefined;
    const file = locationFile(location);
    if (!file) return undefined;
    try {
      const document = await vscode.workspace.openTextDocument(
        vscode.Uri.file(file),
      );
      const offset = locationOffset(document.getText(), location);
      if (offset === undefined) return undefined;
      return new vscode.Location(document.uri, document.positionAt(offset));
    } catch {
      return undefined; // a source file that is gone, as with a build
    }
  }
}
