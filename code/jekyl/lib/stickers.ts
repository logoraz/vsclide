import { Edit, shiftRange } from "./completion";
import { Range, Scan, scanForms } from "./forms";

/** A form marked to be recorded, or to be stopped before. */
export interface Placed extends Range {
  /** The number the image knows it by. */
  id: number;
  /** True for a breakpoint, which enters the debugger before the form. */
  breakpoint?: boolean;
  /** For a breakpoint, a Lisp form that must be true to stop. */
  condition?: string;
}

/** The text that goes before and after the form of ITEM to wrap it. */
export function wrapperFor(item: Placed): [string, string] {
  const open = `(slynk-stickers:record ${item.id} `;
  if (!item.breakpoint) return [open, ")"];
  const stop = `(clide-image::break-here ${item.id})`;
  const guarded = item.condition ? `(when ${item.condition} ${stop})` : stop;
  return [`${open}(progn ${guarded} `, "))"];
}

/**
 * Return the text of SPAN in TEXT with every one of ITEMS inside it
 * wrapped so that the image records it, as SLY does: each form is
 * given to slynk-stickers:record with its number. Items that are not
 * inside SPAN are left out.
 */
export function instrument(
  text: string,
  span: Range,
  items: Placed[],
): string {
  interface Insert {
    at: number;
    open: boolean;
    /** Breaks ties: the outer opens first, the inner closes first. */
    rank: number;
    text: string;
  }
  const inserts: Insert[] = [];
  for (const item of items) {
    if (item.start < span.start || item.end > span.end) continue;
    const [before, after] = wrapperFor(item);
    inserts.push({
      at: item.start - span.start,
      open: true,
      rank: -item.end,
      text: before,
    });
    inserts.push({
      at: item.end - span.start,
      open: false,
      rank: -item.start,
      text: after,
    });
  }
  // At one place a form that ends comes before one that starts.
  inserts.sort(
    (a, b) =>
      a.at - b.at ||
      Number(a.open) - Number(b.open) ||
      a.rank - b.rank,
  );
  const source = text.slice(span.start, span.end);
  let result = "";
  let done = 0;
  for (const insert of inserts) {
    result += source.slice(done, insert.at) + insert.text;
    done = insert.at;
  }
  return result + source.slice(done);
}

/** Return the items inside SPAN. */
export function within<T extends Range>(items: T[], span: Range): T[] {
  return items.filter(
    (item) => item.start >= span.start && item.end <= span.end,
  );
}

/**
 * Return ITEMS as they are after EDIT. An item the edit touches is
 * gone: its text is not what was marked any more.
 */
export function shiftItems<T extends Range>(items: T[], edit: Edit): T[] {
  const kept: T[] = [];
  for (const item of items) {
    const moved = shiftRange(item, edit);
    if (moved) kept.push({ ...item, ...moved });
  }
  return kept;
}

/** Return the items touched by EDIT, which an edit would remove. */
export function touchedBy<T extends Range>(items: T[], edit: Edit): T[] {
  return items.filter((item) => shiftRange(item, edit) === undefined);
}

/**
 * Return how many of ITEMS enclose ITEM: the nesting level of a
 * sticker, which decides how it is shaded.
 */
export function levelOf(item: Range, items: Range[]): number {
  return items.filter(
    (other) =>
      other !== item &&
      other.start <= item.start &&
      other.end >= item.end &&
      (other.start < item.start || other.end > item.end),
  ).length;
}

/**
 * Return the form at OFFSET to put a sticker on, as Emacs finds the
 * sexp at point: the smallest form the cursor is inside or just after.
 */
export function sexpAt(
  text: string,
  offset: number,
  scan: Scan = scanForms(text),
): Range | undefined {
  let best: Range | undefined;
  for (const range of scan.all) {
    const touches =
      (range.start <= offset && offset < range.end) || range.end === offset;
    if (!touches) continue;
    const size = range.end - range.start;
    if (
      !best ||
      size < best.end - best.start ||
      (size === best.end - best.start && range.end === offset)
    ) {
      best = range;
    }
  }
  return best;
}

/**
 * Return the form to stop before for a breakpoint on the line from
 * LINE_START to LINE_END: the largest list that begins on the line and
 * is not a top-level form, for stopping before a definition is loaded
 * is not what a breakpoint is for. Undefined when there is none.
 */
export function breakpointForm(
  text: string,
  lineStart: number,
  lineEnd: number,
  scan: Scan = scanForms(text),
): Range | undefined {
  const top = new Set(scan.top.map((range) => `${range.start}:${range.end}`));
  let best: Range | undefined;
  for (const range of scan.all) {
    if (range.start < lineStart || range.start >= lineEnd) continue;
    if (text[range.start] !== "(") continue;
    if (top.has(`${range.start}:${range.end}`)) continue;
    if (
      !best ||
      range.start < best.start ||
      (range.start === best.start && range.end > best.end)
    ) {
      best = range;
    }
  }
  return best;
}
