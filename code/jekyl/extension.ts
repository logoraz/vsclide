import * as path from "node:path";
import * as vscode from "vscode";
import { LaunchOptions } from "./base/process";
import { Session } from "./base/session";

let session: Session | undefined;

/**
 * Return the development launch: SBCL loading clide from this
 * checkout, run from code/clide so ocicl and ASDF resolve systems.
 * Only valid while the extension runs from a checkout (F5).
 */
function developmentLaunch(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
): LaunchOptions {
  return {
    command: "sbcl",
    args: [
      "--noinform",
      "--non-interactive",
      "--eval",
      '(asdf:load-system "clide")',
      "--eval",
      "(clide:main)",
    ],
    cwd: path.join(context.extensionUri.fsPath, "code", "clide"),
    log: (line) => output.appendLine(line),
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

  context.subscriptions.push(
    vscode.commands.registerCommand("vsclide.ping", async () => {
      if (context.extensionMode !== vscode.ExtensionMode.Development) {
        vscode.window.showErrorMessage(
          "VSCLIDE: only the development launch is implemented.",
        );
        return;
      }
      session ??= new Session(developmentLaunch(context, output));
      try {
        const client = await session.ensure();
        const reply = await client.request<string>("ping");
        vscode.window.showInformationMessage(`clide replied: ${reply}`);
      } catch (error) {
        output.show(true);
        vscode.window.showErrorMessage(
          `VSCLIDE: ping failed: ${(error as Error).message}`,
        );
      }
    }),
  );
}

/**
 * Called by VS Code on shutdown or disable; stops clide.
 */
export function deactivate(): Thenable<void> | undefined {
  return session?.stop();
}
