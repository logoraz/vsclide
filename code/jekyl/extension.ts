import * as vscode from "vscode";
import { Ide } from "./base/ide";
import {
  LaunchContext,
  clideDirectory,
  clideLaunch,
  slynkLaunch,
} from "./base/launch";
import { findSlynk, installDependencies, needsInstall } from "./base/setup";
import { Session } from "./base/session";
import { registerCommands } from "./interface/commands";
import { CompletionProvider } from "./interface/completion";
import { DebugPanel } from "./interface/debug-panel";
import { DefinitionProvider } from "./interface/definition";
import { ReferenceProvider } from "./interface/references";
import { Diagnostics } from "./interface/diagnostics";
import { Highlighting } from "./interface/highlight";
import { Indentation } from "./interface/indent";
import { Keymap } from "./interface/keymap";
import { ReplView, VIEW_ID } from "./interface/repl";
import { Results } from "./interface/results";
import { SignatureProvider } from "./interface/signature";
import { Stickers } from "./interface/stickers";
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
 * Return a function that makes sure the Lisp dependencies of clide are
 * installed, once: a development checkout has its own, so only an
 * installed extension runs ocicl, with a progress notice. A failed
 * install is tried again the next time.
 */
function dependencies(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
): () => Promise<void> {
  let ready: Promise<void> | undefined;
  const install = async (): Promise<void> => {
    const directory = clideDirectory(launchContext(context, output));
    if (!(await needsInstall(directory))) return;
    await Promise.resolve(
      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "VSCLIDE: installing Lisp dependencies with ocicl",
        },
        async () => {
          await installDependencies({
            directory,
            command: vscode.workspace
              .getConfiguration("vsclide")
              .get<string>("ocicl.command", "ocicl"),
            log: (line) => output.appendLine(line),
          });
        },
      ),
    );
  };
  return () => {
    if (context.extensionMode === vscode.ExtensionMode.Development) {
      return Promise.resolve();
    }
    ready ??= install().catch((error: unknown) => {
      ready = undefined;
      throw error;
    });
    return ready;
  };
}

/**
 * Extension entry point; called by VS Code on first activation
 * (see activationEvents in package.json).
 *
 * @param context Extension context; owns subscriptions and storage.
 */
export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("VSCLIDE");
  context.subscriptions.push(output);

  const prepare = dependencies(context, output);
  const session = new Session(async () => {
    await prepare();
    return clideLaunch(launchContext(context, output));
  });
  ide = new Ide(session, async () => {
    await prepare();
    const launch = launchContext(context, output);
    return slynkLaunch(launch, await findSlynk(clideDirectory(launch)));
  });

  const status = new Status(ide);
  const results = new Results(output);
  const panel = new DebugPanel(context.extensionUri, ide, (debugging) =>
    status.setDebugging(debugging),
  );
  const diagnostics = new Diagnostics();
  const stickers = new Stickers(ide, panel);
  const indentation = new Indentation(ide);
  const highlighting = new Highlighting(ide, indentation.rules);
  const repl = new ReplView(
    context.extensionUri,
    ide,
    (replId, entry, value) => panel.inspectReplValue(replId, entry, value),
    (line) => output.appendLine(line),
  );
  context.subscriptions.push(
    status,
    results,
    repl,
    panel,
    diagnostics,
    stickers,
    new Keymap(),
    ...indentation.register(),
    ...highlighting.register(),
    vscode.languages.registerDocumentSemanticTokensProvider(
      LISP,
      highlighting,
      highlighting.legend,
    ),
    vscode.languages.registerDocumentRangeFormattingEditProvider(
      LISP,
      indentation,
    ),
    vscode.languages.registerDocumentFormattingEditProvider(
      LISP,
      indentation,
    ),
    vscode.languages.registerHoverProvider(LISP, stickers),
    vscode.languages.registerCompletionItemProvider(
      LISP,
      new CompletionProvider(ide),
      ...CompletionProvider.triggerCharacters,
    ),
    vscode.languages.registerDefinitionProvider(
      LISP,
      new DefinitionProvider(ide),
    ),
    vscode.languages.registerReferenceProvider(
      LISP,
      new ReferenceProvider(ide),
    ),
    vscode.languages.registerSignatureHelpProvider(
      LISP,
      new SignatureProvider(ide),
      {
        triggerCharacters: SignatureProvider.triggers,
        retriggerCharacters: SignatureProvider.retriggers,
      },
    ),
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
      stickers,
      output,
    }),
  );
}

/**
 * Called by VS Code on shutdown or disable; stops slynk and clide.
 */
export function deactivate(): Thenable<void> | undefined {
  return ide?.stop();
}
