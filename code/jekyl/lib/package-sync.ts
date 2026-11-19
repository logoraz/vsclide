/** What a REPL says of itself: its package and the prompt's nickname. */
export interface ReplPackage {
  name: string;
  nickname: string;
}

/**
 * Return true when a REPL should be told to change package: the file's
 * package WANTED is known, differs (ignoring case) from the name and
 * the nickname the REPL prompted with, and the REPL is idle, since a
 * busy REPL thread cannot take the request. A REPL that has not yet
 * prompted is not synced.
 */
export function needsPackageSync(
  current: ReplPackage | undefined,
  wanted: string | undefined,
  busy: boolean,
): boolean {
  if (!current || !wanted || busy) return false;
  const want = wanted.replace(/^#?:/, "").toLowerCase();
  if (want === "") return false;
  return (
    want !== current.name.toLowerCase() &&
    want !== current.nickname.toLowerCase()
  );
}
