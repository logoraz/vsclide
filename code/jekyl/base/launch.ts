import * as path from "node:path";
import { LaunchOptions } from "./process";

/** What the launch of the Lisp processes depends on. */
export interface LaunchContext {
  /** Root of the extension: the checkout while developing. */
  extensionPath: string;
  /** Root of the open workspace folder, if any. */
  workspacePath?: string;
  /** The Lisp implementation executable, for example "sbcl". */
  lispCommand: string;
  /** Receives one line of process output at a time. */
  log: (line: string) => void;
}

/** Make sure ASDF is there even when no init file loads it. */
const REQUIRE_ASDF = "(require :asdf)";

/**
 * Print the announcement: a fresh line, so it is not glued to other
 * output, then the JSON object jekyl looks for.
 */
const ANNOUNCE =
  '(progn (fresh-line) (format t "{\\"port\\":~d}~%" PORT) (finish-output))';

/** The arguments that run each --eval form in order, quietly. */
function evalArgs(...forms: string[]): string[] {
  return [
    "--noinform",
    "--non-interactive",
    ...forms.flatMap((form) => ["--eval", form]),
  ];
}

/** Arguments that load clide, which prints its own announcement. */
export function clideArgs(): string[] {
  return evalArgs(REQUIRE_ASDF, '(asdf:load-system "clide")', "(clide:main)");
}

/**
 * Arguments that load slynk, start its server on an ephemeral loopback
 * port that takes any number of connections, announce the port and
 * keep the process alive.
 */
export function slynkArgs(): string[] {
  const server = "(slynk:create-server :port 0 :dont-close t)";
  return evalArgs(
    REQUIRE_ASDF,
    '(asdf:load-system "slynk")',
    ANNOUNCE.replace("PORT", server),
    "(loop (sleep 3600))",
  );
}

/**
 * Return the launch of clide from this checkout, run from code/clide
 * so ocicl and ASDF resolve systems. Only valid while the extension
 * runs from a checkout (F5).
 */
export function clideLaunch(context: LaunchContext): LaunchOptions {
  return {
    command: context.lispCommand,
    args: clideArgs(),
    cwd: clideDirectory(context),
    log: context.log,
  };
}

/**
 * Return the launch of the slynk server for the user's code: run from
 * the workspace folder so the user's systems are found, else from
 * code/clide.
 */
export function slynkLaunch(context: LaunchContext): LaunchOptions {
  return {
    command: context.lispCommand,
    args: slynkArgs(),
    cwd: context.workspacePath ?? clideDirectory(context),
    log: context.log,
  };
}

function clideDirectory(context: LaunchContext): string {
  return path.join(context.extensionPath, "code", "clide");
}
