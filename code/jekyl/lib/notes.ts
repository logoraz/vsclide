import { Note, NoteSeverity, noteSeverity } from "../base/language";
import { symbolAround } from "./completion";
import { Range, Scan, scanForms } from "./forms";
import { locationOffset } from "./source-location";

/** A compiler note placed in a text, for a diagnostic. */
export interface Marked extends Range {
  severity: NoteSeverity;
  message: string;
  /** The compiler's word for the severity, such as style-warning. */
  code: string;
}

/**
 * Return the span of the smallest form of SCAN that starts at START, or
 * the symbol there, or the rest of the line, so that a note underlines
 * what it is about.
 */
function extentAt(text: string, start: number, scan: Scan): Range {
  let best: Range | undefined;
  for (const form of scan.all) {
    if (form.start !== start) continue;
    if (!best || form.end < best.end) best = form;
  }
  if (best) return best;
  const symbol = symbolAround(text, start);
  if (symbol && symbol.start === start) {
    return { start, end: symbol.end };
  }
  const newline = text.indexOf("\n", start);
  const end = newline < 0 ? text.length : newline;
  return { start, end: Math.max(end, Math.min(start + 1, text.length)) };
}

/**
 * Return where each of NOTES is in TEXT. A note with a location is put
 * at the form it points to, inside WITHIN, the span that was compiled;
 * one without a location, which the compiler gives when it cannot tell
 * where, covers all of WITHIN.
 */
export function markNotes(
  text: string,
  notes: Note[],
  within: Range,
): Marked[] {
  const scan = scanForms(text);
  return notes.map((note) => {
    const offset =
      note.location && !note.location.error
        ? locationOffset(text, note.location)
        : undefined;
    const span =
      offset === undefined
        ? within
        : extentAt(
            text,
            Math.min(Math.max(offset, within.start), within.end),
            scan,
          );
    return {
      start: span.start,
      end: Math.max(span.start, Math.min(span.end, within.end)),
      severity: noteSeverity(note.severity),
      message: note.message,
      code: note.severity,
    };
  });
}
