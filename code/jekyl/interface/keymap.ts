import * as vscode from "vscode";
import { EMACS_KEYMAP_EXTENSION, activeKeymap } from "../lib/keymap";

/** Context key the keybindings in package.json test. */
const CONTEXT_KEY = "vsclide.activeKeymap";

/**
 * Keep the vsclide.activeKeymap context key current, so the key set
 * follows the vsclide.keymap setting and, under "auto", whether
 * Awesome Emacs Keymap is installed and enabled. Changes no settings.
 */
export class Keymap implements vscode.Disposable {
  private readonly subscriptions: vscode.Disposable[];

  constructor() {
    this.update();
    this.subscriptions = [
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("vsclide.keymap")) {
          this.update();
        }
      }),
      vscode.extensions.onDidChange(() => this.update()),
    ];
  }

  /** Publish the key set that is active now. */
  private update(): void {
    const setting = vscode.workspace
      .getConfiguration("vsclide")
      .get<string>("keymap");
    const installed =
      vscode.extensions.getExtension(EMACS_KEYMAP_EXTENSION) !== undefined;
    void vscode.commands.executeCommand(
      "setContext",
      CONTEXT_KEY,
      activeKeymap(setting, installed),
    );
  }

  dispose(): void {
    this.subscriptions.forEach((s) => s.dispose());
  }
}
