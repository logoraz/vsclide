import { CompileResult, parseCompileResult } from "./language";

type Params = Record<string, unknown>;

/** Seconds from 1900, where Lisp's universal time starts, to 1970. */
const UNIVERSAL_TO_UNIX = 2208988800;

/** What a sticker's form returned one time it ran. */
export interface Recording {
  id: number;
  /** When it was recorded, in milliseconds since 1970. */
  time: number;
  /** The values, printed. */
  values: string[];
  /** True when the form was left by an error or another exit. */
  exited: boolean;
}

/** What the image knows of a sticker. */
export interface StickerInfo {
  id: number;
  /** How many times the form ran. */
  count: number;
  /** The recording last made or asked for, or null while none. */
  recording: Recording | null;
}

/** Where the playhead stands among the recordings. */
export interface Playhead {
  /** How many recordings there are in all. */
  total: number;
  /** The position of this one among them, from 0. */
  index: number;
  sticker: StickerInfo;
}

/** What compiling with stickers came to. */
export interface StickerCompile {
  /** True when the instrumented code was the one compiled. */
  stuck: boolean;
  /** The compiler's verdict, or null when nothing compiled. */
  result: CompileResult | null;
}

/** Return the recording VALUE describes, or null. */
export function parseRecording(value: unknown): Recording | null {
  const p = value as Params | null;
  if (!p || typeof p.id !== "number") return null;
  const time = typeof p.time === "number" ? p.time : 0;
  return {
    id: p.id,
    time: (time - UNIVERSAL_TO_UNIX) * 1000,
    values: Array.isArray(p.values)
      ? p.values.map((v) => (typeof v === "string" ? v : String(v)))
      : [],
    exited: p.exited === true,
  };
}

/** Return the sticker VALUE describes. */
export function parseSticker(value: unknown): StickerInfo {
  const p = (value ?? {}) as Params;
  return {
    id: typeof p.id === "number" ? p.id : 0,
    count: typeof p.count === "number" ? p.count : 0,
    recording: parseRecording(p.recording),
  };
}

/** Return the playhead VALUE describes, or the error it reports. */
export function parsePlayhead(value: unknown): Playhead | { error: string } {
  const p = (value ?? {}) as Params;
  if (typeof p.error === "string") return { error: p.error };
  return {
    total: typeof p.total === "number" ? p.total : 0,
    index: typeof p.index === "number" ? p.index : 0,
    sticker: parseSticker(p.sticker),
  };
}

/** Return what ide/stickers/compile replied. */
export function parseStickerCompile(value: unknown): StickerCompile {
  const p = (value ?? {}) as Params;
  return {
    stuck: p.stuck === true,
    result: p.result ? parseCompileResult(p.result) : null,
  };
}

/** Return the stickers of an ide/stickers/fetch reply. */
export function parseStickers(value: unknown): StickerInfo[] {
  const p = (value ?? {}) as Params;
  return Array.isArray(p.stickers) ? p.stickers.map(parseSticker) : [];
}

/** How to move the playhead, as ide/stickers/search takes it. */
export interface Search {
  /** How many recordings to move by, or where to go when jumping. */
  index: number;
  /** Stickers whose recordings are skipped. */
  ignored?: number[];
  /** Skip the recordings of stickers that have been deleted. */
  ignoreZombies?: boolean;
  /** Move among the recordings of this sticker only. */
  sticker?: number;
  /** Go to the recording at INDEX of all. */
  jump?: boolean;
}
