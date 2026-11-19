/** One frame of a backtrace. */
export interface Frame {
  index: number;
  text: string;
  /** True when the frame can be restarted from its start. */
  restartable: boolean;
}

/** One restart the debugger offers, such as ABORT. */
export interface Restart {
  name: string;
  description: string;
}

/** A local variable of a frame. */
export interface Local {
  name: string;
  /** Tells apart locals of the same name, 0 for the only one. */
  id: number;
  value: string;
}

/**
 * Where a frame's code is. Fields slynk did not give are null; error
 * says why there is no location when it is set.
 */
export interface SourceLocation {
  file: string | null;
  /**
   * The buffer the code was compiled from, which ide/compile names
   * after the file; code compiled from a string has no file of its own.
   */
  buffer: string | null;
  /** A character position, counted from 1 as Emacs does. */
  position: number | null;
  line: number | null;
  column: number | null;
  snippet: string | null;
  error: string | null;
}

/** What is known of a frame beyond its line in the backtrace. */
export interface FrameDetails {
  locals: Local[];
  catchTags: string[];
  package: string;
  location: SourceLocation | null;
}

/** The result of evaluating code in a frame. */
export interface EvalEntry {
  frame: number;
  code: string;
  ok: boolean;
  text: string;
}

/** The sticker a debugger was entered for, when it was. */
export interface StickerStop {
  /** before, after (a sticker's form ran) or breakpoint. */
  kind: "before" | "after" | "breakpoint";
  id: number;
  /** The values the form returned, for after. */
  values: string[];
}

/** One level of the debugger: a condition in one thread of the Lisp. */
export interface DebugLevel {
  threadId: number;
  level: number;
  condition: {
    message: string;
    type: string;
    sticker?: StickerStop;
    /** What to show in place of the message, for a sticker stop. */
    headline?: string;
  };
  restarts: Restart[];
  frames: Frame[];
  /** True while there may be frames beyond those loaded. */
  moreFrames: boolean;
  /** The index of the frame the user is looking at. */
  selected: number;
  /** Details of the frames looked at, by frame index. */
  details: Record<number, FrameDetails>;
  evals: EvalEntry[];
}

/** Slynk sends this many frames when it opens the debugger. */
export const INITIAL_FRAMES = 20;

/** How many more frames to ask for at a time. */
export const FRAME_BATCH = 40;

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

/** Return the frames in VALUE, the JSON clide sends. */
export function parseFrames(value: unknown): Frame[] {
  return array(value).map((frame) => ({
    index: num(frame.index),
    text: text(frame.text),
    restartable: frame.restartable === true,
  }));
}

/**
 * Return the file LOCATION is in: its file, else its buffer when that
 * names a file, which it does for code compiled by VSCLIDE. Otherwise
 * null.
 */
export function locationFile(location: SourceLocation): string | null {
  if (location.file) return location.file;
  if (location.buffer && /^(\/|[A-Za-z]:[\\/])/.test(location.buffer)) {
    return location.buffer;
  }
  return null;
}

/** Return a source location from VALUE, or null when it is not one. */
export function parseLocation(value: unknown): SourceLocation | null {
  if (typeof value !== "object" || value === null) return null;
  const p = value as Params;
  const optional = (field: unknown) =>
    typeof field === "string" ? field : null;
  const optionalNumber = (field: unknown) =>
    typeof field === "number" ? field : null;
  return {
    file: optional(p.file),
    buffer: optional(p.buffer),
    position: optionalNumber(p.position),
    line: optionalNumber(p.line),
    column: optionalNumber(p.column),
    snippet: optional(p.snippet),
    error: optional(p.error),
  };
}

/** Return the details of a frame from VALUE, the JSON clide sends. */
export function parseFrameDetails(value: unknown): FrameDetails {
  const p = (value ?? {}) as Params;
  return {
    locals: array(p.locals).map((local) => ({
      name: text(local.name),
      id: num(local.id),
      value: text(local.value),
    })),
    catchTags: Array.isArray(p.catchTags) ? p.catchTags.map(text) : [],
    package: text(p.package),
    location: parseLocation(p.location),
  };
}

/** Return the sticker stop that VALUE describes, or undefined. */
function parseStop(value: unknown): StickerStop | undefined {
  const p = (value ?? undefined) as Params | undefined;
  if (!p || typeof p.id !== "number") return undefined;
  const kind =
    p.kind === "after" || p.kind === "breakpoint" ? p.kind : "before";
  const recording = (p.recording ?? {}) as Params;
  return {
    kind,
    id: p.id,
    values: Array.isArray(recording.values) ? recording.values.map(text) : [],
  };
}

/** Return what to show for a stop at a sticker or breakpoint. */
export function stopHeadline(stop: StickerStop): string {
  switch (stop.kind) {
    case "breakpoint":
      return "Breakpoint";
    case "after":
      return (
        `Sticker ${stop.id} returned ` + (stop.values.join(", ") || "no values")
      );
    default:
      return `Stopped before sticker ${stop.id}`;
  }
}

/** Return the debugger level that the ide/debug/open params describe. */
export function parseLevel(params: unknown): DebugLevel {
  const p = (params ?? {}) as Params;
  const condition = (p.condition ?? {}) as Params;
  const frames = parseFrames(p.frames);
  const sticker = parseStop(condition.sticker);
  return {
    threadId: num(p.threadId),
    level: num(p.level),
    condition: {
      message: text(condition.message),
      type: text(condition.type),
      sticker,
      headline: sticker ? stopHeadline(sticker) : undefined,
    },
    restarts: array(p.restarts).map((restart) => ({
      name: text(restart.name),
      description: text(restart.description),
    })),
    frames,
    moreFrames: frames.length >= INITIAL_FRAMES,
    selected: frames[0]?.index ?? 0,
    details: {},
    evals: [],
  };
}

/**
 * The debugger's state in the extension host: every level that is open,
 * in the order they opened, with the one the user is working in.
 * Levels belong to threads; two threads can be in the debugger at once,
 * and a thread can be several levels deep. The model knows nothing of
 * slynk or of VS Code, it only follows what the events say.
 */
export class DebugModel {
  private levels: DebugLevel[] = [];
  private currentKey: string | undefined;
  private readonly listeners = new Set<() => void>();

  /** Call LISTENER after each change; returns a function that stops it. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The levels that are open, oldest first. */
  get all(): readonly DebugLevel[] {
    return this.levels;
  }

  /** True while any level is open. */
  get debugging(): boolean {
    return this.levels.length > 0;
  }

  /** The level the user is working in, or undefined when none is open. */
  get current(): DebugLevel | undefined {
    return (
      this.levels.find((level) => this.key(level) === this.currentKey) ??
      this.levels[this.levels.length - 1]
    );
  }

  /** A level opened: remember it, and make it the current one. */
  open(level: DebugLevel): void {
    this.levels = this.levels.filter(
      (other) =>
        !(other.threadId === level.threadId && other.level === level.level),
    );
    this.levels.push(level);
    this.currentKey = this.key(level);
    this.changed();
  }

  /** A level became the one slynk waits on; the user works in it. */
  activate(threadId: number, level: number): void {
    const found = this.find(threadId, level);
    if (!found) return;
    this.currentKey = this.key(found);
    this.changed();
  }

  /** LEVEL of THREAD returned; so did the levels below it. */
  leave(threadId: number, level: number): void {
    const before = this.levels.length;
    this.levels = this.levels.filter(
      (other) => !(other.threadId === threadId && other.level >= level),
    );
    if (this.levels.length !== before) {
      if (!this.current) this.currentKey = undefined;
      this.changed();
    }
  }

  /** The Lisp went away; no level is open any more. */
  clear(): void {
    if (this.levels.length === 0) return;
    this.levels = [];
    this.currentKey = undefined;
    this.changed();
  }

  /** Switch to the level of THREAD at LEVEL, if it is open. */
  switchTo(threadId: number, level: number): void {
    this.activate(threadId, level);
  }

  /** Select frame INDEX of the current level. */
  select(index: number): void {
    const level = this.current;
    if (!level) return;
    level.selected = index;
    this.changed();
  }

  /** Keep the DETAILS of frame INDEX of the level of THREAD. */
  setDetails(
    threadId: number,
    levelNumber: number,
    index: number,
    details: FrameDetails,
  ): void {
    const level = this.find(threadId, levelNumber);
    if (!level) return;
    level.details[index] = details;
    this.changed();
  }

  /** Add FRAMES, asked for from index START, to the level of THREAD. */
  addFrames(
    threadId: number,
    levelNumber: number,
    frames: Frame[],
    asked: number,
  ): void {
    const level = this.find(threadId, levelNumber);
    if (!level) return;
    const known = new Set(level.frames.map((frame) => frame.index));
    level.frames.push(...frames.filter((frame) => !known.has(frame.index)));
    level.frames.sort((a, b) => a.index - b.index);
    level.moreFrames = frames.length >= asked;
    this.changed();
  }

  /** Record an evaluation in a frame of the level of THREAD. */
  addEval(threadId: number, levelNumber: number, entry: EvalEntry): void {
    const level = this.find(threadId, levelNumber);
    if (!level) return;
    level.evals.push(entry);
    this.changed();
  }

  private find(threadId: number, level: number): DebugLevel | undefined {
    return this.levels.find(
      (other) => other.threadId === threadId && other.level === level,
    );
  }

  private key(level: DebugLevel): string {
    return `${level.threadId}:${level.level}`;
  }

  private changed(): void {
    this.listeners.forEach((listener) => listener());
  }
}
