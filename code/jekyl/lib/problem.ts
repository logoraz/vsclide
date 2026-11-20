/** The longest first line of an error shown in the mREPL panel. */
const LONGEST_LINE = 100;

/**
 * Return the sentence the mREPL panel shows when a Lisp could not be
 * started: the first line of ERROR, cut to a readable length, and where
 * to find the rest. The whole message goes to the VSCLIDE output.
 */
export function problemText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const line =
    message
      .split("\n")
      .map((text) => text.trim())
      .find((text) => text.length > 0) ?? "unknown error";
  const shown =
    line.length > LONGEST_LINE ? `${line.slice(0, LONGEST_LINE)}...` : line;
  return `Could not start Lisp: ${shown} See the VSCLIDE output for details.`;
}
