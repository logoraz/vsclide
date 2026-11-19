import * as vscode from "vscode";
import { Ide } from "../base/ide";
import { SourceLocation, locationFile } from "../base/debugger";
import { symbolAround } from "../lib/completion";
import { packageAt } from "../lib/forms";
import { locationOffset } from "../lib/source-location";

/**
 * Takes F12 and Ctrl+click to the definitions of a symbol, as far as
 * the Lisp knows them: what is loaded into it, and no more, so a
 * system is searched once the user has loaded it. Several definitions,
 * such as a function and a variable of the same name, or the methods
 * of a generic function, show in VS Code's peek list.
 *
 * It follows vsclide.definitions.enabled, and does nothing when there
 * is no connection: it never starts a Lisp.
 */
export class DefinitionProvider implements vscode.DefinitionProvider {
  constructor(private readonly ide: Ide) {}

  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.Location[] | undefined> {
    const enabled = vscode.workspace
      .getConfiguration("vsclide.definitions")
      .get<boolean>("enabled", true);
    if (!enabled || !this.ide.connected) return undefined;
    const text = document.getText();
    const offset = document.offsetAt(position);
    const symbol = symbolAround(text, offset);
    if (!symbol) return undefined;

    let definitions;
    try {
      definitions = await this.ide.definitions(
        symbol.name,
        packageAt(text, offset),
      );
    } catch {
      return undefined;
    }
    const found: vscode.Location[] = [];
    const seen = new Set<string>();
    for (const definition of definitions) {
      const location = await this.locate(definition.location);
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
