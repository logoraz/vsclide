/**
 * One piece of what the inspector shows: plain text, a label, a value
 * that can be inspected in turn, or an action that can be run.
 */
export type Part =
  | { kind: "text"; text: string }
  | { kind: "label"; text: string }
  | { kind: "value"; text: string; index: number }
  | { kind: "action"; text: string; index: number };

/** An inspected object: its title and as much of its content as loaded. */
export interface Inspected {
  title: string;
  id: number;
  parts: Part[];
  /** The end of the range of parts loaded so far. */
  end: number;
  /** True when ide/inspect/range can fetch more parts. */
  more: boolean;
}

type Params = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

/** Return the parts in VALUE, the JSON clide sends. */
export function parseParts(value: unknown): Part[] {
  const parts = Array.isArray(value) ? (value as Params[]) : [];
  return parts.map((part): Part => {
    switch (part.kind) {
      case "label":
        return { kind: "label", text: text(part.text) };
      case "value":
        return { kind: "value", text: text(part.text), index: num(part.index) };
      case "action":
        return {
          kind: "action",
          text: text(part.text),
          index: num(part.index),
        };
      default:
        return { kind: "text", text: text(part.text) };
    }
  });
}

/**
 * Slynk cuts its content at a number of parts, which can fall inside a
 * line, between a label and its value. When MORE parts follow, return
 * the parts up to the last whole line, and END moved back to match,
 * so that the next range starts at the start of a line. Without any
 * line end, the parts stay as they are.
 */
export function wholeLines(
  parts: Part[],
  end: number,
  more: boolean,
): { parts: Part[]; end: number } {
  if (!more) return { parts, end };
  let last = -1;
  parts.forEach((part, index) => {
    if (part.kind === "text" && part.text.endsWith("\n")) last = index;
  });
  if (last < 0) return { parts, end };
  return {
    parts: parts.slice(0, last + 1),
    end: end - (parts.length - 1 - last),
  };
}

/**
 * Return the inspected object that VALUE, the JSON clide sends, holds,
 * or undefined when it holds none.
 */
export function parseInspected(value: unknown): Inspected | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const p = value as Params;
  const more = p.more === true;
  const whole = wholeLines(parseParts(p.parts), num(p.end), more);
  return {
    title: text(p.title),
    id: num(p.id),
    parts: whole.parts,
    end: whole.end,
    more,
  };
}

/** The parts that ide/inspect/range sends. */
export interface Range {
  parts: Part[];
  start: number;
  end: number;
  more: boolean;
}

/** Return the range that VALUE, the JSON clide sends, holds. */
export function parseRange(value: unknown): Range {
  const p = (value ?? {}) as Params;
  const more = p.more === true;
  const whole = wholeLines(parseParts(p.parts), num(p.end), more);
  return {
    parts: whole.parts,
    start: num(p.start),
    end: whole.end,
    more,
  };
}

/**
 * The inspector's state in the extension host. Slynk keeps the history
 * of inspected objects; this keeps the object shown and how far back
 * and forward the history goes, which the buttons need to know.
 */
export class InspectorModel {
  private shown: Inspected | undefined;
  private backward = 0;
  private forward = 0;
  private readonly listeners = new Set<() => void>();

  /** Call LISTENER after each change; returns a function that stops it. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The object shown, or undefined when none is. */
  get current(): Inspected | undefined {
    return this.shown;
  }

  /** True when there is an earlier object to go back to. */
  get canGoBack(): boolean {
    return this.backward > 0;
  }

  /** True when there is a later object to go forward to. */
  get canGoForward(): boolean {
    return this.forward > 0;
  }

  /** Start over with OBJECT: the history holds nothing else. */
  start(object: Inspected | undefined): void {
    this.shown = object;
    this.backward = 0;
    this.forward = 0;
    this.changed();
  }

  /** OBJECT, reached from a part of the shown one, is shown now. */
  descend(object: Inspected | undefined): void {
    if (!object) return;
    this.shown = object;
    this.backward += 1;
    this.forward = 0;
    this.changed();
  }

  /** The previous object, OBJECT, is shown now; undefined means none. */
  goBack(object: Inspected | undefined): void {
    if (!object) return;
    this.shown = object;
    this.backward = Math.max(0, this.backward - 1);
    this.forward += 1;
    this.changed();
  }

  /** The next object, OBJECT, is shown now; undefined means none. */
  goForward(object: Inspected | undefined): void {
    if (!object) return;
    this.shown = object;
    this.forward = Math.max(0, this.forward - 1);
    this.backward += 1;
    this.changed();
  }

  /** The shown object was refreshed, or printed another way. */
  refresh(object: Inspected | undefined): void {
    if (!object) return;
    this.shown = object;
    this.changed();
  }

  /** More parts of the shown object arrived. */
  extend(range: Range): void {
    const shown = this.shown;
    if (!shown) return;
    shown.parts = [...shown.parts, ...range.parts];
    shown.end = range.end;
    shown.more = range.more;
    this.changed();
  }

  /** Forget everything. */
  clear(): void {
    if (!this.shown && this.backward === 0 && this.forward === 0) return;
    this.start(undefined);
  }

  private changed(): void {
    this.listeners.forEach((listener) => listener());
  }
}
