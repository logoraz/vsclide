import { SourceLocation, parseLocation } from "./debugger";

/** A run of characters of a completion that the typed pattern matched. */
export interface Chunk {
  /** Where in the label the run starts. */
  start: number;
  text: string;
}

/** One candidate of ide/complete. */
export interface Completion {
  label: string;
  /** Slynk's score; the higher, the better the match. */
  score: number;
  /** What the symbol is, in slynk's words: fn, macro, var, cla... */
  kind: string;
  chunks: Chunk[];
}

/** One place a name is defined, as ide/definitions finds it. */
export interface Definition {
  /** What is defined, such as "(DEFUN FOO)". */
  name: string;
  location: SourceLocation | null;
}

/** A place that refers to a name, as ide/xref reports it. */
export interface Reference {
  /** Who refers, such as "(DEFUN FOO)". */
  name: string;
  /** What kind: "calls", "references" or "macroexpands". */
  kind: string;
  location: SourceLocation | null;
}

/** How serious a compiler note is, from most to least. */
export type NoteSeverity =
  | "error"
  | "warning"
  | "information"
  | "hint";

/** One thing the compiler said about the code. */
export interface Note {
  /** The compiler's own word: error, warning, style-warning, note... */
  severity: string;
  message: string;
  /** The form around the problem, as the compiler prints it, or null. */
  context: string | null;
  /** Where it is; null when the compiler could not say. */
  location: SourceLocation | null;
}

/** What compiling came to. */
export interface CompileResult {
  /** The compiler's own verdict, which counts warnings as success. */
  ok: boolean;
  /** True when the user left a debugger that the loaded code entered. */
  aborted: boolean;
  seconds: number;
  /** The fasl written, for a file; null otherwise. */
  fasl: string | null;
  notes: Note[];
}

type Params = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function array(value: unknown): Params[] {
  return Array.isArray(value) ? (value as Params[]) : [];
}

/** Return the completions in VALUE, the reply to ide/complete. */
export function parseCompletions(value: unknown): Completion[] {
  const p = (value ?? {}) as Params;
  return array(p.items).map((item) => ({
    label: text(item.label),
    score: num(item.score),
    kind: text(item.kind),
    chunks: array(item.chunks).map((chunk) => ({
      start: num(chunk.start),
      text: text(chunk.text),
    })),
  }));
}

/** Return the definitions in VALUE, the reply to ide/definitions. */
export function parseDefinitions(value: unknown): Definition[] {
  const p = (value ?? {}) as Params;
  return array(p.definitions).map((definition) => ({
    name: text(definition.name),
    location: parseLocation(definition.location),
  }));
}

/** Return the references in VALUE, the reply to ide/xref. */
export function parseReferences(value: unknown): Reference[] {
  const p = (value ?? {}) as Params;
  return array(p.references).map((reference) => ({
    name: text(reference.name),
    kind: text(reference.kind),
    location: parseLocation(reference.location),
  }));
}

/** Return the compile result in VALUE, the reply to ide/compile. */
export function parseCompileResult(value: unknown): CompileResult {
  const p = (value ?? {}) as Params;
  return {
    ok: p.ok === true,
    aborted: p.aborted === true,
    seconds: num(p.seconds),
    fasl: typeof p.fasl === "string" ? p.fasl : null,
    notes: array(p.notes).map((note) => ({
      severity: text(note.severity),
      message: text(note.message),
      context: typeof note.context === "string" ? note.context : null,
      location: parseLocation(note.location),
    })),
  };
}

/**
 * Return how serious a compiler note of SEVERITY, the compiler's word
 * for it, is. Style warnings count as warnings: SBCL reports undefined
 * functions that way. Plain notes are information, and redefinitions,
 * which are routine at a REPL, are hints.
 */
export function noteSeverity(severity: string): NoteSeverity {
  switch (severity) {
    case "error":
    case "read-error":
      return "error";
    case "warning":
    case "style-warning":
    case "early-deprecation-warning":
    case "late-deprecation-warning":
    case "final-deprecation-warning":
      return "warning";
    case "redefinition":
      return "hint";
    default:
      return "information";
  }
}

/** The order of severities, most serious first. */
const ORDER: NoteSeverity[] = ["error", "warning", "information", "hint"];

/** Return true when SEVERITY is at least as serious as LEAST. */
export function atLeast(
  severity: NoteSeverity,
  least: NoteSeverity,
): boolean {
  return ORDER.indexOf(severity) <= ORDER.indexOf(least);
}

/**
 * Return a one line description of RESULT, such as "2 warnings, 1 note
 * in 0.12s", for the status bar.
 */
export function summarize(result: CompileResult): string {
  if (result.aborted) return "compilation aborted";
  const count = (severities: NoteSeverity[]) =>
    result.notes.filter((note) =>
      severities.includes(noteSeverity(note.severity)),
    ).length;
  const parts: string[] = [];
  const errors = count(["error"]);
  const warnings = count(["warning"]);
  const notes = count(["information", "hint"]);
  if (errors) parts.push(`${errors} error${errors === 1 ? "" : "s"}`);
  if (warnings) parts.push(`${warnings} warning${warnings === 1 ? "" : "s"}`);
  if (notes) parts.push(`${notes} note${notes === 1 ? "" : "s"}`);
  const seconds = `${result.seconds.toFixed(2)}s`;
  return parts.length === 0
    ? `compiled in ${seconds}`
    : `compiled with ${parts.join(", ")} in ${seconds}`;
}

/**
 * Return TEXT, the documentation slynk gives for a symbol, without the
 * lambda list lines, which are shown apart, and with the blank lines
 * squeezed.
 */
export function tidyDocumentation(documentation: string): string {
  return documentation
    .split("\n")
    .filter((line) => !/^\s*Arglist:/.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
