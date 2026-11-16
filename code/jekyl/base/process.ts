import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as readline from "node:readline";

/** How to launch a Lisp process that announces a port. */
export interface LaunchOptions {
  /** Implementation executable, for example "sbcl". */
  command: string;
  /** Arguments that load the system and print the announcement. */
  args: string[];
  /** Working directory; ocicl and ASDF resolve systems from here. */
  cwd: string;
  /** Receives one line of the process's output at a time. */
  log: (line: string) => void;
  /** Give up waiting for the port line after this long. */
  timeoutMs?: number;
}

/** A running Lisp process that has announced its port. */
export interface LispProcess {
  readonly port: number;
  /** Resolves with the exit code, or null when killed by a signal. */
  readonly exited: Promise<number | null>;
  /** Stop the process; resolves once it has exited. */
  stop(): Promise<void>;
}

/** A running clide process. */
export interface ClideProcess extends LispProcess {
  /** Session token the first message on a connection must carry. */
  readonly token: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const KILL_GRACE_MS = 5_000;
const TAIL_LINES = 20;

/** Return a fresh random session token. */
export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Return the port if LINE ends with the announcement, else undefined.
 * The announcement is a JSON object such as {"port":40075}; other
 * output may precede it on the same line.
 */
export function parsePortLine(line: string): number | undefined {
  const match = /\{"port":(\d+)\}\s*$/.exec(line);
  return match ? Number(match[1]) : undefined;
}

/**
 * Spawn a Lisp process and resolve once it announces its port on
 * stdout. NAME says what the process is, for error messages. EXTRA is
 * added to the environment. Other stdout lines and all stderr lines go
 * to the log function. Rejects if the process fails to start, exits
 * first, or stays silent past the timeout.
 */
export function startLisp(
  options: LaunchOptions,
  name: string,
  extra: Record<string, string> = {},
): Promise<LispProcess> {
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: { ...process.env, ...extra },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
    child.once("error", () => resolve(null));
  });

  const tail: string[] = [];
  const remember = (line: string): void => {
    tail.push(line);
    if (tail.length > TAIL_LINES) tail.shift();
  };

  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    await exited;
    clearTimeout(timer);
  };

  return new Promise<LispProcess>((resolve, reject) => {
    let announced = false;
    const timer = setTimeout(() => {
      void stop();
      reject(new Error(startupFailure(name, "timed out", tail)));
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    readline.createInterface({ input: child.stdout! }).on("line", (line) => {
      const port = announced ? undefined : parsePortLine(line);
      if (port === undefined) {
        remember(line);
        options.log(line);
        return;
      }
      announced = true;
      clearTimeout(timer);
      resolve({ port, exited, stop });
    });

    readline.createInterface({ input: child.stderr! }).on("line", (line) => {
      remember(line);
      options.log(line);
    });

    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`cannot start ${options.command}: ${error.message}`));
    });

    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (!announced) {
        const how = signal ? `was killed by ${signal}` : `exited ${code}`;
        reject(new Error(startupFailure(name, how, tail)));
      }
    });
  });
}

/**
 * Spawn clide and resolve once it announces its port. The token goes
 * in the CLIDE_TOKEN environment variable, never on the command line.
 */
export async function startClide(
  options: LaunchOptions,
): Promise<ClideProcess> {
  const token = generateToken();
  const lisp = await startLisp(options, "clide", { CLIDE_TOKEN: token });
  return { ...lisp, token };
}

/**
 * Spawn the slynk server the IDE talks to and resolve once it
 * announces its port. It listens on loopback only.
 */
export function startSlynk(options: LaunchOptions): Promise<LispProcess> {
  return startLisp(options, "slynk");
}

/** Describe a startup failure, with the last lines the process printed. */
function startupFailure(name: string, what: string, tail: string[]): string {
  const lines = tail.length ? `\n${tail.join("\n")}` : "";
  return `${name} ${what} before announcing its port${lines}`;
}
