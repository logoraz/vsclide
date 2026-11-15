import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as readline from "node:readline";

/** How to launch the Lisp implementation running clide. */
export interface LaunchOptions {
  /** Implementation executable, for example "sbcl". */
  command: string;
  /** Arguments that load clide and call clide:main. */
  args: string[];
  /** Working directory; ocicl and ASDF resolve systems from here. */
  cwd: string;
  /** Receives one line of clide output at a time. */
  log: (line: string) => void;
  /** Give up waiting for the port line after this long. */
  timeoutMs?: number;
}

/** A running clide process that has announced its port. */
export interface ClideProcess {
  readonly port: number;
  /** Session token the first message on a connection must carry. */
  readonly token: string;
  /** Resolves with the exit code, or null when killed by a signal. */
  readonly exited: Promise<number | null>;
  /** Stop the process; resolves once it has exited. */
  stop(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const KILL_GRACE_MS = 5_000;
const TAIL_LINES = 20;

/** Return a fresh random session token. */
export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Return the port if LINE ends with clide's announcement, else
 * undefined. The announcement is a JSON object such as {"port":40075};
 * other output may precede it on the same line.
 */
export function parsePortLine(line: string): number | undefined {
  const match = /\{"port":(\d+)\}\s*$/.exec(line);
  return match ? Number(match[1]) : undefined;
}

/**
 * Spawn clide and resolve once it announces its port on stdout.
 * The token goes in the CLIDE_TOKEN environment variable, never on
 * the command line. Other stdout lines and all stderr lines go to
 * the log function. Rejects if the process fails to start, exits
 * first, or stays silent past the timeout.
 */
export function startClide(options: LaunchOptions): Promise<ClideProcess> {
  const token = generateToken();
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: { ...process.env, CLIDE_TOKEN: token },
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

  return new Promise<ClideProcess>((resolve, reject) => {
    let announced = false;
    const timer = setTimeout(() => {
      void stop();
      reject(new Error(startupFailure("timed out", tail)));
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
      resolve({ port, token, exited, stop });
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
        reject(new Error(startupFailure(how, tail)));
      }
    });
  });
}

/** Describe a startup failure, with the last lines clide printed. */
function startupFailure(what: string, tail: string[]): string {
  const lines = tail.length ? `\n${tail.join("\n")}` : "";
  return `clide ${what} before announcing its port${lines}`;
}
