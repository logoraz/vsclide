import * as vscode from "vscode";
import { Ide } from "./base/ide";
import { LaunchContext, clideLaunch, slynkLaunch } from "./base/launch";
import { Session } from "./base/session";
import { registerCommands } from "./interface/commands";
import { CompletionProvider, applyTrigger } from "./interface/completion";
import { DebugPanel } from "./interface/debug-panel";
import { DefinitionProvider } from "./interface/definition";
import { Diagnostics } from "./interface/diagnostics";
import { ReplView, VIEW_ID } from "./interface/repl";
import { Results } from "./interface/results";
import { Status } from "./interface/status";

let ide: Ide | undefined;

/** What the providers are for: Common Lisp files, saved or not. */
const LISP: vscode.DocumentSelector = { language: "commonlisp" };

/**
 * Return what launching the Lisp processes depends on. The Lisp
 * implementation comes from the vsclide.lisp.command setting.
 */
function launchContext(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
): LaunchContext {
  return {
    extensionPath: context.extensionUri.fsPath,
    workspacePath: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    lispCommand: vscode.workspace
      .getConfiguration("vsclide")
      .get<string>("lisp.command", "sbcl"),
    log: (line) => output.appendLine(line),
  };
}

/**
 * Extension entry point; called by VS Code on first activation
 * (see activationEvents in package.json).
 *
 * Only the development launch of clide, from a checkout, exists so far.
 *
 * @param context Extension context; owns subscriptions and storage.
 */
export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("VSCLIDE");
  context.subscriptions.push(output);

  const session = new Session(() => {
    if (context.extensionMode !== vscode.ExtensionMode.Development) {
      throw new Error("only the development launch is implemented");
    }
    return clideLaunch(launchContext(context, output));
  });
  ide = new Ide(session, () => slynkLaunch(launchContext(context, output)));

  const status = new Status(ide);
  const results = new Results(output);
  const panel = new DebugPanel(context.extensionUri, ide, (debugging) =>
    status.setDebugging(debugging),
  );
  const diagnostics = new Diagnostics();
  const repl = new ReplView(
    context.extensionUri,
    ide,
    (replId, entry, value) => panel.inspectReplValue(replId, entry, value),
  );
  context.subscriptions.push(
    status,
    results,
    repl,
    panel,
    diagnostics,
    vscode.languages.registerCompletionItemProvider(
      LISP,
      new CompletionProvider(ide),
      ...CompletionProvider.triggerCharacters,
    ),
    vscode.languages.registerDefinitionProvider(
      LISP,
      new DefinitionProvider(ide),
    ),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("vsclide.completion.trigger")) {
        void applyTrigger();
      }
    }),
    vscode.window.registerWebviewViewProvider(VIEW_ID, repl, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    new vscode.Disposable(
      ide.onEvent((event) => {
        if (event.type === "output") output.append(event.text);
        if (event.type === "disconnected") {
          output.appendLine(`;; disconnected: ${event.reason}`);
        }
      }),
    ),
    ...registerCommands({
      ide,
      results,
      status,
      repl,
      panel,
      diagnostics,
      output,
    }),
  );
  void applyTrigger();
}

/**
 * Called by VS Code on shutdown or disable; stops slynk and clide.
 */
export function deactivate(): Thenable<void> | undefined {
  return ide?.stop();
}
