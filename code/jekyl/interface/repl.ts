import * as vscode from "vscode";
import { Ide, IdeEvent } from "../base/ide";
import { banner } from "../lib/sylvester";

/** Id of the webview view, as contributed in package.json. */
export const VIEW_ID = "vsclide.mrepl";

/** Messages the webview sends. */
type Outgoing =
  | { type: "ready" }
  | { type: "send"; replId: number; text: string }
  | { type: "interrupt"; replId: number }
  | { type: "select"; replId: number }
  | { type: "close"; replId: number };

/**
 * The mREPL panel: a webview view in the bottom panel that holds any
 * number of Lisp REPLs, each a tab in a list on the right as in the
 * terminal. The page only draws; the REPLs live in slynk and are
 * driven through the IDE controller.
 */
export class ReplView implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  /** Titles of the open REPLs by id, in creation order. */
  private readonly repls = new Map<number, string>();
  private active: number | undefined;
  private counter = 0;
  private creating: Promise<void> = Promise.resolve();
  private adopting = false;
  private sylvesters: string | undefined | null = null;
  private banner = "";
  /** False until the page has loaded; messages wait in QUEUE. */
  private ready = false;
  private queue: unknown[] = [];
  private readonly announced = new Set<number>();
  private readonly unsubscribe: () => void;

  /** EXTENSION is the root of the extension; the script is under out/. */
  constructor(
    private readonly extension: vscode.Uri,
    private readonly ide: Ide,
  ) {
    this.unsubscribe = ide.onEvent((event) => this.onEvent(event));
  }

  /** Called by VS Code when the view is first shown. */
  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false;
    this.announced.clear();
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extension, "out")],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((message: Outgoing) =>
      void this.onMessage(message),
    );
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
  }

  /** Show the panel; open a first REPL if there is none. */
  async open(): Promise<void> {
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    if (this.repls.size === 0) await this.create();
  }

  /** Open a new REPL and make it the active tab. */
  create(): Promise<void> {
    // One creation at a time: a REPL's first events can arrive before
    // the reply that names it, and are then adopted by the open one.
    this.creating = this.creating.then(() => this.createOne());
    return this.creating;
  }

  /** Close the active REPL. */
  async closeActive(): Promise<void> {
    if (this.active !== undefined) await this.close(this.active);
  }

  /** Clear the transcript of the active REPL. */
  clearActive(): void {
    this.post({ type: "clear", replId: this.active });
  }

  private async createOne(): Promise<void> {
    try {
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`, {
        preserveFocus: true,
      });
      this.adopting = true;
      this.banner = banner(await this.sylvesterText());
      const id = await this.ide.createRepl();
      this.adopt(id);
    } catch (error) {
      this.post({ type: "notice", text: (error as Error).message });
    } finally {
      this.adopting = false;
    }
  }

  /** Fetch sylvesters.txt once; absence is remembered too. */
  private async sylvesterText(): Promise<string | undefined> {
    if (this.sylvesters === null) {
      this.sylvesters = await this.ide.sylvesters().catch(() => undefined);
    }
    return this.sylvesters;
  }

  private async close(id: number): Promise<void> {
    if (!this.repls.delete(id)) return;
    this.announced.delete(id);
    this.post({ type: "remove", replId: id });
    if (this.active === id) this.active = [...this.repls.keys()].pop();
    this.post({ type: "select", replId: this.active });
    await this.ide.closeRepl(id).catch(() => undefined);
  }

  /** Record REPL ID as open, add its tab and make it the active one. */
  private adopt(id: number): void {
    if (this.repls.has(id)) return;
    const title = `mREPL ${++this.counter}`;
    this.repls.set(id, title);
    this.active = id;
    this.announce(id);
    // The banner comes before anything slynk has said for this REPL.
    this.post({ type: "output", replId: id, text: this.banner, first: true });
    this.banner = "";
  }

  /** Tell the page about REPL ID, once. */
  private announce(id: number): void {
    const title = this.repls.get(id);
    if (title === undefined || this.announced.has(id)) return;
    this.announced.add(id);
    this.post({ type: "add", replId: id, title });
  }

  private async onMessage(message: Outgoing): Promise<void> {
    try {
      switch (message.type) {
        case "ready":
          this.flush();
          break;
        case "send":
          await this.ide.sendToRepl(message.replId, message.text);
          break;
        case "interrupt":
          await this.ide.interruptRepl(message.replId);
          break;
        case "select":
          this.active = message.replId;
          break;
        case "close":
          await this.close(message.replId);
          break;
      }
    } catch (error) {
      this.post({
        type: "notice",
        replId: "replId" in message ? message.replId : undefined,
        text: (error as Error).message,
      });
    }
  }

  /**
   * The page has loaded: deliver what waited, then announce any REPL
   * it has not heard of, as after the view was disposed and recreated.
   */
  private flush(): void {
    this.ready = true;
    const queued = this.queue;
    this.queue = [];
    for (const message of queued) void this.view?.webview.postMessage(message);
    for (const id of this.repls.keys()) this.announce(id);
    this.post({ type: "select", replId: this.active });
  }

  private onEvent(event: IdeEvent): void {
    if (event.type === "disconnected") {
      const text = `Disconnected: ${event.reason}. Close this tab and open ` +
        "a new mREPL.";
      for (const replId of this.repls.keys()) {
        this.post({ type: "notice", replId, text });
      }
      return;
    }
    if (!("replId" in event)) return;
    if (!this.repls.has(event.replId)) {
      if (!this.adopting) return;
      this.adopt(event.replId);
    }
    const replId = event.replId;
    switch (event.type) {
      case "replOutput":
        this.post({ type: "output", replId, text: event.text });
        break;
      case "replPrompt":
        this.post({ type: "prompt", replId, text: `${event.nickname}>` });
        break;
      case "replValues":
        this.post({
          type: "values",
          replId,
          values: event.values.map((value) => value.text),
        });
        break;
      case "replAborted":
        this.post({ type: "aborted", replId, message: event.message });
        break;
      case "replCleared":
        this.post({ type: "clear", replId });
        break;
      default:
        break;
    }
  }

  private post(message: unknown): void {
    if (!this.view) return;
    if (this.ready) void this.view.webview.postMessage(message);
    else this.queue.push(message);
  }

  /** Return the page; the content security policy allows our script only. */
  private html(webview: vscode.Webview): string {
    const script = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extension, "out", "webview", "repl.js"),
    );
    const nonce = Array.from({ length: 16 }, () =>
      Math.floor(Math.random() * 16).toString(16),
    ).join("");
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline';
  script-src 'nonce-${nonce}';">
<style>
  html, body { height: 100%; }
  body { display: flex; margin: 0; padding: 0;
         font-family: var(--vscode-editor-font-family);
         font-size: var(--vscode-editor-font-size);
         color: var(--vscode-editor-foreground); }
  #main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  #transcripts { flex: 1; position: relative; min-height: 0; }
  .transcript { position: absolute; inset: 0; overflow-y: auto;
                padding: 4px 8px; white-space: pre-wrap;
                word-break: break-word; display: none; }
  .transcript.active { display: block; }
  .input { color: var(--vscode-terminal-ansiGreen); }
  .value { color: var(--vscode-terminal-ansiCyan); }
  .error { color: var(--vscode-errorForeground); }
  .banner { color: #ff69b4; }
  .notice { color: var(--vscode-descriptionForeground); }
  .notice { font-style: italic; }
  #bar { display: flex; align-items: flex-start; gap: 6px; padding: 4px 8px;
         border-top: 1px solid var(--vscode-panel-border); }
  #prompt { padding-top: 3px; color: var(--vscode-terminal-ansiGreen);
            white-space: nowrap; }
  #input { flex: 1; resize: none; height: 2.6em; font: inherit;
           color: var(--vscode-input-foreground);
           background: var(--vscode-input-background);
           border: 1px solid var(--vscode-input-border, transparent); }
  #tabs { display: none; width: 160px; flex-direction: column;
          border-left: 1px solid var(--vscode-panel-border);
          overflow-y: auto; font-family: var(--vscode-font-family);
          font-size: var(--vscode-font-size); }
  #tabs.shown { display: flex; }
  .tab { display: flex; align-items: center; justify-content: space-between;
         padding: 3px 8px; cursor: pointer; }
  .tab:hover { background: var(--vscode-list-hoverBackground); }
  .tab.active { background: var(--vscode-list-activeSelectionBackground);
                color: var(--vscode-list-activeSelectionForeground); }
  .tab .close { visibility: hidden; padding: 0 4px; }
  .tab:hover .close, .tab.active .close { visibility: visible; }
  button { color: var(--vscode-button-foreground);
           background: var(--vscode-button-background); border: none;
           padding: 4px 8px; cursor: pointer; }
  #empty { padding: 8px; color: var(--vscode-descriptionForeground);
           font-family: var(--vscode-font-family); }
</style>
</head>
<body>
<div id="main">
  <div id="transcripts"><div id="empty">No mREPL open. Use + above.</div></div>
  <div id="bar">
    <span id="prompt">CL-USER&gt;</span>
    <textarea id="input" spellcheck="false" disabled
      placeholder="Enter evaluates; Shift+Enter adds a line"></textarea>
    <button id="interrupt" title="Interrupt (Ctrl+C)">Interrupt</button>
  </div>
</div>
<div id="tabs"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.unsubscribe();
  }
}
