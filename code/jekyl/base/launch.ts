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
 * keep the process alive. With SYSTEM, the path of a slynk system
 * definition, that slynk is loaded, as the one clide is tested with,
 * whatever the user's own systems offer.
 */
export function slynkArgs(system?: string): string[] {
  const server = "(slynk:create-server :port 0 :dont-close t)";
  const register = system
    ? [`(asdf:load-asd ${JSON.stringify(system)})`]
    : [];
  return evalArgs(
    REQUIRE_ASDF,
    ...register,
    '(asdf:load-system "slynk")',
    ANNOUNCE.replace("PORT", server),
    "(loop (sleep 3600))",
  );
}

/**
 * Return the launch of clide from the extension, run from code/clide
 * so ocicl and ASDF resolve systems.
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
 * code/clide. SYSTEM is the slynk to load, if one is installed.
 */
export function slynkLaunch(
  context: LaunchContext,
  system?: string,
): LaunchOptions {
  return {
    command: context.lispCommand,
    args: slynkArgs(system),
    cwd: context.workspacePath ?? clideDirectory(context),
    log: context.log,
  };
}

/** Return the clide directory of the extension. */
export function clideDirectory(context: LaunchContext): string {
  return path.join(context.extensionPath, "code", "clide");
}
