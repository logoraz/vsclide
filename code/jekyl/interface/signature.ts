import * as vscode from "vscode";
import { Ide } from "../base/ide";
import { tidyDocumentation } from "../base/language";
import { packageAt } from "../lib/forms";
import { callAt, signatureFor } from "../lib/signature";

/**
 * Shows the lambda list of the operator of the call the cursor is in,
 * with the parameter of the argument being written highlighted, as VS
 * Code does for other languages. The lambda list is slynk's, so it
 * covers what is loaded; it never starts a Lisp. The settings it
 * follows, read at each request:
 *
 *   vsclide.signatureHelp.enabled        switch it off
 *   vsclide.signatureHelp.documentation  the docstring under the list
 */
export class SignatureProvider implements vscode.SignatureHelpProvider {
  /** Typing these opens or moves the popup. */
  static readonly triggers = [" ", "("];
  /** Typing these refreshes it, as when a nested call ends. */
  static readonly retriggers = [")"];

  constructor(private readonly ide: Ide) {}

  async provideSignatureHelp(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.SignatureHelp | undefined> {
    const config = vscode.workspace.getConfiguration("vsclide.signatureHelp");
    if (!config.get<boolean>("enabled", true)) return undefined;
    const text = document.getText();
    const offset = document.offsetAt(position);
    const call = callAt(text, offset);
    if (!call) return undefined;
    const packageName = packageAt(text, offset);
    let lambdaList: string | undefined;
    try {
      lambdaList = await this.ide.arglist(call.operator, packageName);
    } catch {
      return undefined;
    }
    if (!lambdaList) return undefined;

    const shape = signatureFor(
      call.operator,
      lambdaList,
      call.index,
      call.before,
    );
    const signature = new vscode.SignatureInformation(
      shape.label,
      await this.documentation(call.operator, packageName, config),
    );
    signature.parameters = shape.ranges.map(
      (range) => new vscode.ParameterInformation(range),
    );
    const help = new vscode.SignatureHelp();
    help.signatures = [signature];
    help.activeSignature = 0;
    // An index past the parameters highlights none.
    help.activeParameter =
      shape.active < 0 ? shape.ranges.length : shape.active;
    return help;
  }

  private async documentation(
    operator: string,
    packageName: string | undefined,
    config: vscode.WorkspaceConfiguration,
  ): Promise<vscode.MarkdownString | undefined> {
    if (!config.get<boolean>("documentation", true)) return undefined;
    const text = await this.ide
      .documentation(operator, packageName)
      .catch(() => undefined);
    if (!text) return undefined;
    return new vscode.MarkdownString(tidyDocumentation(text));
  }
}
