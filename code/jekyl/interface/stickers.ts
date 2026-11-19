import * as vscode from "vscode";
import { Ide, IdeEvent } from "../base/ide";
import { CompileResult } from "../base/language";
import { Playhead, StickerInfo } from "../base/stickers";
import { contextAt } from "../lib/completion";
import { Range as Span, packageAt, scanForms } from "../lib/forms";
import {
  Placed,
  breakpointForm,
  instrument,
  sexpAt,
  shiftItems,
  touchedBy,
  within,
} from "../lib/stickers";
import { DebugPanel } from "./debug-panel";

/** What compiling with stickers came to. */
export interface Stickered {
  result: CompileResult;
  /** True when the stickers stuck: the instrumented code compiled. */
  stuck: boolean;
  /** How many stickers and breakpoints were in the code. */
  count: number;
}

/** The look of a sticker, by what is known of it. */
type Look = "placed" | "armed" | "recorded" | "exited";

const LOOKS: Record<Look, vscode.DecorationRenderOptions> = {
  placed: {
    border: "1px dotted",
    borderColor: new vscode.ThemeColor("vsclide.stickerPlaced"),
  },
  armed: {
    backgroundColor: new vscode.ThemeColor("vsclide.stickerArmed"),
  },
  recorded: {
    backgroundColor: new vscode.ThemeColor("vsclide.stickerRecorded"),
  },
  exited: {
    backgroundColor: new vscode.ThemeColor("vsclide.stickerExited"),
  },
};

/** How long the sticker a debugger stopped at stays lit. */
const FLASH_MS = 1500;

/**
 * Stickers, as SLY has them: marks on forms in the editor. Compiling a
 * form (or loading a file) with stickers in it makes the image record
 * what each marked form returns whenever it runs. The recordings can
 * be seen on the sticker, replayed one after another and inspected,
 * and the image can break before or after a sticker. Breakpoints,
 * those of the editor's gutter, are stickers too, which stop before
 * their form, so they come with the same compiling.
 *
 * The stickers are marks in the editor and nowhere else: they move
 * with the text and are gone with an edit inside them, and what the
 * image holds of one that is gone is told to forget it with the next
 * request. Settings, read when used:
 *
 *   vsclide.stickers.autoRefresh   fetch the recordings after code runs
 */
export class Stickers implements vscode.Disposable, vscode.HoverProvider {
  private readonly stickers = new Map<string, Placed[]>();
  private readonly armed = new Set<number>();
  private readonly info = new Map<number, StickerInfo>();
  /** Stickers deleted here that the image still holds. */
  private readonly zombies = new Set<number>();
  /** Which sticker stands for which breakpoint, by breakpoint id. */
  private readonly breakpointStickers = new Map<string, number>();
  private readonly sites = new Map<number, { uri: vscode.Uri; line: number }>();
  private readonly decorations = new Map<
    Look,
    vscode.TextEditorDecorationType
  >();
  private readonly flash = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor("editor.findMatchBackground"),
  });
  private readonly subscriptions: vscode.Disposable[] = [];
  private nextId = 1;
  private ignored: number[] = [];
  private ignoreZombies = false;

  constructor(
    private readonly ide: Ide,
    private readonly panel: DebugPanel,
  ) {
    for (const look of Object.keys(LOOKS) as Look[]) {
      this.decorations.set(
        look,
        vscode.window.createTextEditorDecorationType(LOOKS[look]),
      );
    }
    this.subscriptions.push(
      new vscode.Disposable(ide.onEvent((event) => this.onEvent(event))),
      vscode.workspace.onDidChangeTextDocument((event) => this.edited(event)),
      vscode.workspace.onDidCloseTextDocument((document) =>
        this.closed(document),
      ),
      vscode.window.onDidChangeVisibleTextEditors((editors) =>
        editors.forEach((editor) => this.render(editor)),
      ),
      vscode.debug.onDidChangeBreakpoints((event) => {
        for (const breakpoint of event.removed) {
          const id = this.breakpointStickers.get(breakpoint.id);
          if (id === undefined) continue;
          this.breakpointStickers.delete(breakpoint.id);
          this.sites.delete(id);
          if (this.armed.delete(id)) this.zombies.add(id);
        }
      }),
    );
  }

  dispose(): void {
    this.subscriptions.forEach((s) => s.dispose());
    this.decorations.forEach((d) => d.dispose());
    this.flash.dispose();
  }

  // Placing

  /**
   * Put a sticker on the selection or the form at the cursor, or take
   * away the one that is there.
   */
  toggle(editor: vscode.TextEditor): void {
    const document = editor.document;
    const text = document.getText();
    let span: Span | undefined;
    if (!editor.selection.isEmpty) {
      span = {
        start: document.offsetAt(editor.selection.start),
        end: document.offsetAt(editor.selection.end),
      };
    } else {
      const offset = document.offsetAt(editor.selection.active);
      if (contextAt(text, offset) !== "code") {
        void vscode.window.showInformationMessage(
          "VSCLIDE: no point placing stickers in strings or comments.",
        );
        return;
      }
      span = sexpAt(text, offset);
    }
    if (!span) {
      void vscode.window.showInformationMessage(
        "VSCLIDE: nothing here to place a sticker on.",
      );
      return;
    }
    const key = document.uri.toString();
    const here = this.stickers.get(key) ?? [];
    const same = here.find((s) => s.start === span.start && s.end === span.end);
    if (same) {
      this.remove([same], key);
      void vscode.window.setStatusBarMessage("VSCLIDE: sticker deleted", 3000);
    } else {
      const sticker = { id: this.nextId++, ...span };
      this.stickers.set(key, [...here, sticker]);
      void vscode.window.setStatusBarMessage(
        `VSCLIDE: sticker ${sticker.id} placed; compile to arm it`,
        3000,
      );
    }
    this.renderDocument(document);
  }

  /** Delete the stickers of the top-level form at the cursor. */
  clearForm(editor: vscode.TextEditor): void {
    const document = editor.document;
    const text = document.getText();
    const offset = document.offsetAt(editor.selection.active);
    const scan = scanForms(text);
    const top = scan.top.find((r) => r.start <= offset && offset <= r.end);
    if (!top) return;
    this.clearWithin(document, top);
  }

  /** Delete every sticker of the document. */
  clearDocument(editor: vscode.TextEditor): void {
    this.clearWithin(editor.document, {
      start: 0,
      end: editor.document.getText().length,
    });
  }

  private clearWithin(document: vscode.TextDocument, span: Span): void {
    const key = document.uri.toString();
    const here = this.stickers.get(key) ?? [];
    this.remove(within(here, span), key);
    this.renderDocument(document);
  }

  private remove(stickers: Placed[], key: string): void {
    const ids = new Set(stickers.map((s) => s.id));
    this.stickers.set(
      key,
      (this.stickers.get(key) ?? []).filter((s) => !ids.has(s.id)),
    );
    for (const id of ids) this.forget(id);
  }

  /** Note that sticker ID is gone here, though the image may hold it. */
  private forget(id: number): void {
    if (this.armed.delete(id)) this.zombies.add(id);
    this.info.delete(id);
  }

  // Compiling

  /**
   * Compile SPAN of DOCUMENT with the stickers and breakpoints in it,
   * or return undefined when there are none, for the caller to compile
   * as usual. FILE and PACKAGE are as for ide.compile.
   */
  async compile(
    document: vscode.TextDocument,
    span: Span,
    file: string | undefined,
    packageName: string | undefined,
  ): Promise<Stickered | undefined> {
    const items = this.itemsIn(document, span);
    if (items.length === 0) return undefined;
    const text = document.getText();
    const dead = [...this.zombies];
    const reply = await this.ide.compileStickered(
      instrument(text, span, items),
      text.slice(span.start, span.end),
      span.start,
      file,
      packageName,
      items.map((item) => item.id),
      dead,
    );
    dead.forEach((id) => this.zombies.delete(id));
    for (const item of items) {
      this.info.delete(item.id);
      if (reply.stuck) this.armed.add(item.id);
      else if (this.armed.delete(item.id)) this.zombies.add(item.id);
    }
    this.renderDocument(document);
    if (!reply.result) throw new Error("nothing compiled");
    return { result: reply.result, stuck: reply.stuck, count: items.length };
  }

  /**
   * After the file of DOCUMENT was compiled and loaded, compile again
   * each top-level form that has stickers, so that they stick. Return
   * how many forms stuck and how many did not.
   */
  async compileStickered(
    document: vscode.TextDocument,
    file: string | undefined,
  ): Promise<{ stuck: number; failed: number }> {
    const text = document.getText();
    const scan = scanForms(text);
    const all = this.itemsIn(document, { start: 0, end: text.length });
    let stuck = 0;
    let failed = 0;
    for (const top of scan.top) {
      if (within(all, top).length === 0) continue;
      const done = await this.compile(
        document,
        top,
        file,
        packageAt(text, top.start, scan),
      );
      if (done?.stuck) stuck++;
      else failed++;
    }
    return { stuck, failed };
  }

  /** The stickers and breakpoints inside SPAN of DOCUMENT. */
  private itemsIn(document: vscode.TextDocument, span: Span): Placed[] {
    const key = document.uri.toString();
    const items = within(this.stickers.get(key) ?? [], span);
    const text = document.getText();
    const scan = scanForms(text);
    for (const breakpoint of vscode.debug.breakpoints) {
      if (
        !(breakpoint instanceof vscode.SourceBreakpoint) ||
        !breakpoint.enabled ||
        breakpoint.location.uri.toString() !== key
      ) {
        continue;
      }
      const line = breakpoint.location.range.start.line;
      if (line >= document.lineCount) continue;
      const start = document.offsetAt(new vscode.Position(line, 0));
      const end = document.offsetAt(document.lineAt(line).range.end);
      const form = breakpointForm(text, start, end, scan);
      if (!form || form.start < span.start || form.end > span.end) continue;
      if (items.some((i) => i.start === form.start && i.end === form.end)) {
        continue;
      }
      let id = this.breakpointStickers.get(breakpoint.id);
      if (id === undefined) {
        id = this.nextId++;
        this.breakpointStickers.set(breakpoint.id, id);
      }
      this.sites.set(id, { uri: breakpoint.location.uri, line });
      items.push({
        id,
        ...form,
        breakpoint: true,
        condition: breakpoint.condition?.trim() || undefined,
      });
    }
    return items;
  }

  // Recordings

  /** Fetch what the image recorded and show it on the stickers. */
  async refresh(): Promise<void> {
    if (this.armed.size === 0 || !this.ide.connected) return;
    const dead = [...this.zombies];
    const stickers = await this.ide.fetchStickers(dead);
    dead.forEach((id) => this.zombies.delete(id));
    for (const sticker of stickers) {
      if (this.armed.has(sticker.id)) this.info.set(sticker.id, sticker);
    }
    vscode.window.visibleTextEditors.forEach((e) => this.render(e));
  }

  /** Refresh unless the user switched that off; failures are ignored. */
  async refreshQuietly(): Promise<void> {
    const config = vscode.workspace.getConfiguration("vsclide.stickers");
    if (!config.get<boolean>("autoRefresh", true)) return;
    try {
      await this.refresh();
    } catch {
      // The recordings are a courtesy; the work they follow went on.
    }
  }

  /** The command to fetch the recordings, saying what came of it. */
  async fetch(): Promise<void> {
    const dead = [...this.zombies];
    const stickers = await this.ide.fetchStickers(dead);
    dead.forEach((id) => this.zombies.delete(id));
    for (const sticker of stickers) {
      if (this.armed.has(sticker.id)) this.info.set(sticker.id, sticker);
    }
    vscode.window.visibleTextEditors.forEach((e) => this.render(e));
    const total = stickers.reduce((sum, s) => sum + s.count, 0);
    void vscode.window.setStatusBarMessage(
      `VSCLIDE: ${stickers.length} stickers, ${total} recordings`,
      4000,
    );
  }

  /** Forget the recordings of every sticker. */
  async forgetRecordings(): Promise<void> {
    const dead = [...this.zombies];
    await this.ide.forgetRecordings(dead);
    dead.forEach((id) => this.zombies.delete(id));
    this.info.clear();
    vscode.window.visibleTextEditors.forEach((e) => this.render(e));
    void vscode.window.setStatusBarMessage(
      "VSCLIDE: recordings forgotten",
      3000,
    );
  }

  /** Switch breaking on every sticker, and say which it is. */
  async toggleBreak(): Promise<void> {
    const on = await this.ide.toggleBreakOnStickers();
    void vscode.window.setStatusBarMessage(
      `VSCLIDE: breaking on stickers is ${on ? "on" : "off"}`,
      4000,
    );
  }

  /**
   * Replay the recordings: a list over the playhead that moves it,
   * shows the sticker it belongs to and offers what SLY's replay does.
   * It stays open until dismissed.
   */
  async replay(): Promise<void> {
    let head = await this.search({ index: 0, jump: true });
    for (;;) {
      if ("error" in head) {
        void vscode.window.showInformationMessage(`VSCLIDE: ${head.error}`);
        return;
      }
      await this.reveal(head.sticker.id, true);
      const choice = await this.choose(head);
      if (!choice) return;
      const next = await choice();
      if (next) head = next;
    }
  }

  private async search(
    options: Parameters<Ide["searchRecordings"]>[0],
  ): Promise<Playhead | { error: string }> {
    const dead = [...this.zombies];
    const found = await this.ide.searchRecordings(
      {
        ...options,
        ignored: this.ignored,
        ignoreZombies: this.ignoreZombies,
      },
      dead,
    );
    dead.forEach((id) => this.zombies.delete(id));
    return found;
  }

  /** Ask what to do at HEAD; return the action chosen, if any. */
  private async choose(
    head: Playhead,
  ): Promise<(() => Promise<Playhead | undefined>) | undefined> {
    const sticker = head.sticker;
    const recording = sticker.recording;
    const id = sticker.id;
    const move = (options: Parameters<Ide["searchRecordings"]>[0]) =>
      async () => {
        const found = await this.search(options);
        if ("error" in found) {
          void vscode.window.showInformationMessage(`VSCLIDE: ${found.error}`);
          return undefined;
        }
        return found;
      };
    const actions: {
      label: string;
      description?: string;
      run: () => Promise<Playhead | undefined>;
    }[] = [
      { label: "Next", run: move({ index: 1 }) },
      { label: "Previous", run: move({ index: -1 }) },
      {
        label: "Next for this sticker",
        run: move({ index: 1, sticker: id }),
      },
      {
        label: "Previous for this sticker",
        run: move({ index: -1, sticker: id }),
      },
      { label: "Jump to start", run: move({ index: 0, jump: true }) },
      { label: "Jump to end", run: move({ index: -1, jump: true }) },
      {
        label: "Go to sticker",
        run: async () => {
          await this.reveal(id, false);
          return undefined;
        },
      },
      {
        label: "Inspect value",
        description: recording ? `of recording ${recording.id}` : undefined,
        run: async () => {
          await this.inspectRecording(sticker);
          return undefined;
        },
      },
      {
        label: this.ignored.includes(id)
          ? "Stop ignoring this sticker"
          : "Ignore this sticker",
        run: async () => {
          this.ignored = this.ignored.includes(id)
            ? this.ignored.filter((other) => other !== id)
            : [...this.ignored, id];
          return head;
        },
      },
      {
        label: "Reset the ignore list",
        run: async () => {
          this.ignored = [];
          return head;
        },
      },
      {
        label: this.ignoreZombies
          ? "Stop ignoring deleted stickers"
          : "Ignore deleted stickers",
        run: async () => {
          this.ignoreZombies = !this.ignoreZombies;
          return head;
        },
      },
    ];
    const values = recording
      ? recording.exited
        ? "exited non-locally"
        : recording.values.join(", ") || "no values"
      : "no recording";
    const picked = await vscode.window.showQuickPick(
      actions.map((a) => ({ label: a.label, description: a.description, a })),
      {
        title:
          `Recording ${head.index + 1} of ${head.total}: sticker ${id}, ` +
          `${sticker.count} hits`,
        placeHolder: values,
        ignoreFocusOut: true,
      },
    );
    return picked?.a.run;
  }

  /** Inspect a value of the recording of STICKER. */
  private async inspectRecording(sticker: StickerInfo): Promise<void> {
    const recording = sticker.recording;
    if (!recording || recording.values.length === 0) {
      void vscode.window.showInformationMessage(
        "VSCLIDE: this recording has no values to inspect.",
      );
      return;
    }
    let value = 0;
    if (recording.values.length > 1) {
      const picked = await vscode.window.showQuickPick(
        recording.values.map((text, index) => ({ label: text, index })),
        { title: "Inspect which value?" },
      );
      if (!picked) return;
      value = picked.index;
    }
    await this.panel.inspectWith(
      () => this.ide.inspectSticker({ recording: recording.id, value }),
      true,
    );
  }

  /** The command to inspect the sticker at the cursor, or a pick. */
  async inspectAtCursor(editor: vscode.TextEditor): Promise<void> {
    const found = this.at(editor.document, editor.selection.active);
    if (found.length === 0) {
      void vscode.window.showInformationMessage("VSCLIDE: no sticker here.");
      return;
    }
    const sticker = this.info.get(found[0].id);
    if (!sticker) {
      void vscode.window.showInformationMessage(
        "VSCLIDE: this sticker has no recordings yet.",
      );
      return;
    }
    await this.inspectRecording(sticker);
  }

  // Showing

  /**
   * The column that already shows DOCUMENT, so that revealing a
   * sticker does not open a second copy in the group that has focus.
   */
  private columnOf(
    document: vscode.TextDocument,
  ): vscode.ViewColumn | undefined {
    return vscode.window.visibleTextEditors.find(
      (editor) => editor.document === document,
    )?.viewColumn;
  }

  /** Open the sticker ID in an editor and select it. */
  async reveal(id: number, preserveFocus: boolean): Promise<boolean> {
    for (const [key, stickers] of this.stickers) {
      const sticker = stickers.find((s) => s.id === id);
      if (!sticker) continue;
      const document = await vscode.workspace.openTextDocument(
        vscode.Uri.parse(key),
      );
      const editor = await vscode.window.showTextDocument(document, {
        viewColumn: this.columnOf(document),
        preserveFocus,
        preview: false,
      });
      const range = new vscode.Range(
        document.positionAt(sticker.start),
        document.positionAt(sticker.end),
      );
      editor.selection = new vscode.Selection(range.start, range.start);
      editor.revealRange(
        range,
        vscode.TextEditorRevealType.InCenterIfOutsideViewport,
      );
      this.flashRange(editor, range);
      return true;
    }
    const site = this.sites.get(id);
    if (site) {
      const document = await vscode.workspace.openTextDocument(site.uri);
      const editor = await vscode.window.showTextDocument(document, {
        viewColumn: this.columnOf(document),
        preserveFocus,
        preview: false,
      });
      const range = document.lineAt(site.line).range;
      editor.selection = new vscode.Selection(range.start, range.start);
      editor.revealRange(
        range,
        vscode.TextEditorRevealType.InCenterIfOutsideViewport,
      );
      this.flashRange(editor, range);
      return true;
    }
    void vscode.window.setStatusBarMessage(
      `VSCLIDE: sticker ${id} is gone from the editor`,
      4000,
    );
    return false;
  }

  private flashRange(editor: vscode.TextEditor, range: vscode.Range): void {
    editor.setDecorations(this.flash, [range]);
    setTimeout(() => editor.setDecorations(this.flash, []), FLASH_MS);
  }

  /** The stickers of DOCUMENT around POSITION, the innermost first. */
  private at(document: vscode.TextDocument, position: vscode.Position) {
    const offset = document.offsetAt(position);
    return (this.stickers.get(document.uri.toString()) ?? [])
      .filter((s) => s.start <= offset && offset <= s.end)
      .sort((a, b) => a.end - a.start - (b.end - b.start));
  }

  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Hover | undefined {
    const found = this.at(document, position)[0];
    if (!found) return undefined;
    const markdown = new vscode.MarkdownString();
    markdown.appendMarkdown(`**Sticker ${found.id}**\n\n`);
    const info = this.info.get(found.id);
    if (!this.armed.has(found.id)) {
      markdown.appendMarkdown("Not armed; compile the form to arm it.");
    } else if (!info || info.count === 0 || !info.recording) {
      markdown.appendMarkdown("Armed; it has not run yet.");
    } else {
      const recording = info.recording;
      markdown.appendMarkdown(`${info.count} recordings; last:\n\n`);
      if (recording.exited) {
        markdown.appendMarkdown("exited non-locally");
      } else {
        for (const value of recording.values) markdown.appendCodeblock(value);
        if (recording.values.length === 0) markdown.appendText("no values");
      }
    }
    return new vscode.Hover(
      markdown,
      new vscode.Range(
        document.positionAt(found.start),
        document.positionAt(found.end),
      ),
    );
  }

  private look(id: number): Look {
    if (!this.armed.has(id)) return "placed";
    const info = this.info.get(id);
    if (!info || info.count === 0 || !info.recording) return "armed";
    return info.recording.exited ? "exited" : "recorded";
  }

  private render(editor: vscode.TextEditor): void {
    const document = editor.document;
    const stickers = this.stickers.get(document.uri.toString()) ?? [];
    for (const [look, type] of this.decorations) {
      editor.setDecorations(
        type,
        stickers
          .filter((s) => this.look(s.id) === look)
          .map(
            (s) =>
              new vscode.Range(
                document.positionAt(s.start),
                document.positionAt(s.end),
              ),
          ),
      );
    }
  }

  private renderDocument(document: vscode.TextDocument): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document === document) this.render(editor);
    }
  }

  // Events

  private edited(event: vscode.TextDocumentChangeEvent): void {
    const key = event.document.uri.toString();
    let stickers = this.stickers.get(key);
    if (!stickers || event.contentChanges.length === 0) return;
    // Later changes first, so each one's offsets still hold.
    const changes = [...event.contentChanges].sort(
      (a, b) => b.rangeOffset - a.rangeOffset,
    );
    for (const change of changes) {
      const edit = {
        start: change.rangeOffset,
        end: change.rangeOffset + change.rangeLength,
        length: change.text.length,
      };
      for (const gone of touchedBy(stickers, edit)) this.forget(gone.id);
      stickers = shiftItems(stickers, edit);
    }
    this.stickers.set(key, stickers);
    this.renderDocument(event.document);
  }

  private closed(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    for (const sticker of this.stickers.get(key) ?? []) this.forget(sticker.id);
    this.stickers.delete(key);
  }

  private onEvent(event: IdeEvent): void {
    switch (event.type) {
      case "connected":
        // A new image knows none of them.
        this.armed.clear();
        this.info.clear();
        this.zombies.clear();
        vscode.window.visibleTextEditors.forEach((e) => this.render(e));
        break;
      case "debugOpen": {
        const stop = event.level.condition.sticker;
        if (!stop) break;
        void this.reveal(stop.id, false);
        if (stop.kind === "after") {
          void vscode.window.showInformationMessage(
            `VSCLIDE: sticker ${stop.id} returned ` +
              (stop.values.join(", ") || "no values"),
          );
        }
        void this.refreshQuietly();
        break;
      }
      case "debugReturn":
        void this.refreshQuietly();
        break;
      default:
        break;
    }
  }
}
