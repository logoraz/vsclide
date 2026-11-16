/*
 * The welcome banner of an mREPL, in the spirit of SLY's Sylvester the
 * Cat. SLY's art and quips are GPL and are not bundled here: the art is
 * read at run time from the user's own slynk install (sylvesters.txt)
 * and the words of encouragement below are original.
 */

/** Words of encouragement; each replaces @@@@ in a piece of art. */
export const WORDS_OF_ENCOURAGEMENT: readonly string[] = [
  "Sufferin' succotash, a fresh REPL!",
  "The image is up and the parens are balanced.",
  "Evaluate early, evaluate often.",
  "A fresh image awaits your forms.",
  "Time to bring some code to life.",
  "Thufferin' thuccotash, let's cons something!",
];

/** Return a random element of ITEMS using RANDOM, a function in [0, 1). */
function pick<T>(items: readonly T[], random: () => number): T {
  return items[Math.min(items.length - 1, Math.floor(random() * items.length))];
}

/**
 * Split the text of sylvesters.txt into its pieces of art. Pieces are
 * separated by a blank line, as SLY reads the file.
 */
export function parseSylvesters(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n\n")
    .map((piece) => piece.replace(/^\n+/, "").replace(/\s+$/, ""))
    .filter((piece) => piece.trim() !== "");
}

/** Prefix every line of TEXT with "; " so it reads as a Lisp comment. */
function comment(text: string): string {
  return text
    .split("\n")
    .map((line) => (line === "" ? ";" : `; ${line}`))
    .join("\n");
}

/**
 * Return the banner for a new mREPL, ending in a newline. SYLVESTERS is
 * the text of sylvesters.txt, if the slynk install has one; without it
 * only the words of encouragement are shown. RANDOM is injectable for
 * tests.
 */
export function banner(
  sylvesters: string | undefined,
  random: () => number = Math.random,
): string {
  const words = pick(WORDS_OF_ENCOURAGEMENT, random);
  const pieces = sylvesters ? parseSylvesters(sylvesters) : [];
  if (pieces.length === 0) return `${comment(words)}\n`;
  const art = pick(pieces, random);
  const filled = art.includes("@@@@") ? art.replace("@@@@", words) : art;
  return `${comment(filled)}\n`;
}
