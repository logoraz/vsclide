import * as vscode from "vscode";
import { Ide, IdeEvent } from "../base/ide";

/**
 * The status bar item and the vsclide.lispRunning context key, both
 * following the connection of the IDE controller.
 */
export class Status implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    10,
  );
  private readonly subscription: () => void;

  /** IDE is the controller whose connection is shown. */
  constructor(private readonly ide: Ide) {
    this.item.command = "vsclide.connect";
    this.subscription = ide.onEvent((event) => this.update(event));
    this.render();
  }

  /** Show that a connection attempt is under way. */
  connecting(): void {
    this.item.text = "$(sync~spin) Lisp: starting";
    this.item.tooltip = "Starting the Lisp and connecting to it";
    this.item.show();
  }

  private update(event: IdeEvent): void {
    if (event.type === "connected" || event.type === "disconnected") {
      this.render();
    }
  }

  /** Reflect the state of the connection. */
  render(): void {
    const info = this.ide.connection;
    void vscode.commands.executeCommand(
      "setContext",
      "vsclide.lispRunning",
      info !== undefined,
    );
    if (info) {
      const { name, version } = info.implementation;
      this.item.text = `$(check) ${name ?? "Lisp"} ${version ?? ""}`.trim();
      this.item.command = "vsclide.disconnect";
      this.item.tooltip = `Connected to ${name} ${version}; click to stop`;
    } else {
      this.item.text = "$(circle-slash) Lisp: not running";
      this.item.tooltip = "Click to start the Lisp and connect";
      this.item.command = "vsclide.connect";
    }
    this.item.show();
  }

  dispose(): void {
    this.subscription();
    this.item.dispose();
  }
}
