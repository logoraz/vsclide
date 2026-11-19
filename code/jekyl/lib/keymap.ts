/** Extension id of Awesome Emacs Keymap, whose presence selects "emacs". */
export const EMACS_KEYMAP_EXTENSION = "tuttieee.emacs-mcx";

/** Name of a key binding set; matches the when clauses in package.json. */
export type Keymap = "vscode" | "emacs";

/**
 * Return the key map to activate.
 *
 * @param setting Value of vsclide.keymap: "auto", "vscode" or "emacs";
 *   anything else counts as "auto".
 * @param emacsKeymapInstalled Whether Awesome Emacs Keymap is enabled.
 */
export function activeKeymap(
  setting: string | undefined,
  emacsKeymapInstalled: boolean,
): Keymap {
  if (setting === "vscode" || setting === "emacs") {
    return setting;
  }
  return emacsKeymapInstalled ? "emacs" : "vscode";
}
