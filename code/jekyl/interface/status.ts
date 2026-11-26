import * as vscode from "vscode";
import { Ide, IdeEvent } from "../base/ide";

/**
 * The status bar item and the vsclide.lispRunning context key, both
 * following the connections of the IDE controller. The item names the
 * active connection, and with several open a click switches it.
 */
export class Status implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    10,
  );
  private readonly subscription: () => void;
  private inDebugger = false;

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

  /** Show whether the Lisp is in the debugger, and set the context key. */
  setDebugging(debugging: boolean): void {
    this.inDebugger = debugging;
    void vscode.commands.executeCommand(
      "setContext",
      "vsclide.debugging",
      debugging,
    );
    this.render();
  }

  private update(event: IdeEvent): void {
    if (
      event.type === "connected" ||
      event.type === "disconnected" ||
      event.type === "active"
    ) {
      this.render();
    }
  }

  /** Reflect the state of the connections. */
  render(): void {
    const active = this.ide.active;
    const info = active?.info;
    const others = this.ide.connections.length - 1;
    void vscode.commands.executeCommand(
      "setContext",
      "vsclide.lispRunning",
      info !== undefined,
    );
    void vscode.commands.executeCommand(
      "setContext",
      "vsclide.severalConnections",
      others > 0,
    );
    if (active && info && this.inDebugger) {
      this.item.text = "$(debug) Lisp: debugging";
      this.item.command = "vsclide.showDebugger";
      this.item.tooltip = "The Lisp is in the debugger; click to show it";
    } else if (active && info) {
      const { name, version } = info.implementation;
      const label = active.origin === "spawned"
        ? `${name ?? "Lisp"} ${version ?? ""}`.trim()
        : active.name;
      this.item.text =
        `$(check) ${label}` + (others > 0 ? ` +${others}` : "");
      this.item.command =
        others > 0 ? "vsclide.switchConnection" : "vsclide.disconnect";
      this.item.tooltip =
        `Active connection: ${active.name} (${name} ${version}). ` +
        (others > 0 ? "Click to switch" : "Click to disconnect");
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
