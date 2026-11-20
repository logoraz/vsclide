import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as readline from "node:readline";

/** Run COMMAND with ARGS in CWD, logging its output; reject on failure. */
export type Runner = (
  command: string,
  args: string[],
  cwd: string,
  log: (line: string) => void,
) => Promise<void>;

/** What installing the Lisp dependencies of clide depends on. */
export interface SetupOptions {
  /** The clide directory, where ocicl.csv lives. */
  directory: string;
  /** The ocicl executable, for example "ocicl". */
  command: string;
  /** Receives one line of output at a time. */
  log: (line: string) => void;
  /** Runs commands; the default spawns them. */
  run?: Runner;
}

const STAMP = path.join("ocicl", ".vsclide-pins");

/** Return the hash of the pin file CSV, which names what is installed. */
export function pinStamp(csv: string): string {
  return createHash("sha256").update(csv).digest("hex");
}

/**
 * Return the path of the slynk system definition the pin file CSV
 * names, under DIRECTORY/ocicl, or undefined when slynk is not pinned.
 */
export function slynkSystemPath(
  directory: string,
  csv: string,
): string | undefined {
  for (const line of csv.split("\n")) {
    const [name, , file] = line.split(",").map((part) => part.trim());
    if (name === "slynk" && file) {
      return path.join(directory, "ocicl", file);
    }
  }
  return undefined;
}

/**
 * Return the pinned slynk system definition of DIRECTORY if it is
 * installed, else undefined.
 */
export async function findSlynk(
  directory: string,
): Promise<string | undefined> {
  try {
    const csv = await fs.readFile(path.join(directory, "ocicl.csv"), "utf8");
    const file = slynkSystemPath(directory, csv);
    if (!file) return undefined;
    await fs.access(file);
    return file;
  } catch {
    return undefined;
  }
}

/** Return true when what is installed is not what the pin file names. */
export async function needsInstall(directory: string): Promise<boolean> {
  const csv = await fs.readFile(path.join(directory, "ocicl.csv"), "utf8");
  try {
    const stamp = await fs.readFile(path.join(directory, STAMP), "utf8");
    return stamp.trim() !== pinStamp(csv);
  } catch {
    return true;
  }
}

/**
 * Install the pinned dependencies of clide with ocicl, unless they are
 * installed already, and return whether it did. The stamp is written
 * only after ocicl succeeded, so an interrupted install is redone.
 */
export async function installDependencies(
  options: SetupOptions,
): Promise<boolean> {
  const { directory, command, log } = options;
  if (!(await needsInstall(directory))) return false;
  const run = options.run ?? runCommand;
  log(`installing the dependencies of clide with ${command}`);
  await run(command, ["install"], directory, log);
  const csv = await fs.readFile(path.join(directory, "ocicl.csv"), "utf8");
  await fs.mkdir(path.join(directory, "ocicl"), { recursive: true });
  await fs.writeFile(path.join(directory, STAMP), pinStamp(csv));
  return true;
}

/** The default runner: spawn the command and wait for it to finish. */
export const runCommand: Runner = (command, args, cwd, log) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (const stream of [child.stdout, child.stderr]) {
      readline.createInterface({ input: stream }).on("line", log);
    }
    child.once("error", (error: NodeJS.ErrnoException) => {
      reject(
        new Error(
          error.code === "ENOENT"
            ? `${command} was not found; install ocicl and run ocicl ` +
              "setup, or set vsclide.ocicl.command"
            : `${command} failed to start: ${error.message}`,
        ),
      );
    });
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} install exited with code ${code}`));
    });
  });
