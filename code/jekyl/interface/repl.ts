import * as vscode from "vscode";
import { ReplPackage, needsPackageSync } from "../lib/package-sync";
import { problemText } from "../lib/problem";
import { Connection, Ide, IdeEvent, Origin } from "../base/ide";
import { banner } from "../lib/sylvester";

/** Id of the webview view, as contributed in package.json. */
export const VIEW_ID = "vsclide.mrepl";

/** Messages the webview sends. */
type Outgoing =
  | { type: "ready" }
  | { type: "send"; replId: number; text: string }
  | { type: "interrupt"; replId: number }
  | { type: "select"; replId: number }
  | { type: "reconnect"; group: number }
  | { type: "dismiss"; group: number }

  | { type: "close"; replId: number }
  | { type: "inspect"; replId: number; entry: number; value: number };

/** What is needed to connect again to a connection that has ended. */
interface Endpoint {
  name: string;
  origin: Origin;
  host: string;
  port: number;
}

/** A REPL of the panel: which connection it is on, and its id there. */
interface ReplTab {
  connectionId: number;
  replId: number;
  title: string;
}

/**
 * The mREPL panel: a webview view in the bottom panel that holds any
 * number of Lisp REPLs, each a tab in a list on the right as in the
 * terminal, grouped under the connection it is on. The page only
 * draws; the REPLs live in slynk and are driven through the IDE
 * controller. The page names a REPL by a number of its own, as REPL
 * ids repeat from one connection to the next.
 */
export class ReplView implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  /** The open REPLs by the page's number, in creation order. */
  private readonly repls = new Map<number, ReplTab>();
  private nextTab = 1;
  private active: number | undefined;
  /** The tab last used on each connection, by connection id. */
  private readonly lastTab = new Map<number, number>();
  private readonly packages = new Map<number, ReplPackage>();
  private readonly busy = new Set<number>();
  /** Where each connection that has had a heading here connected to. */
  private readonly endpoints = new Map<number, Endpoint>();
  /** The names of the connections that have had a REPL here. */
  private readonly names = new Map<number, string>();
  /** REPLs opened so far on each connection, for the titles. */
  private readonly counters = new Map<number, number>();
  private creating: Promise<void> = Promise.resolve();
  /** The connection a REPL is being created on, or undefined. */
  private adopting: number | undefined;
  private sylvesters: string | undefined | null = null;
  private banner = "";
  /** False until the page has loaded; messages wait in QUEUE. */
  private ready = false;
  private queue: unknown[] = [];
  private readonly announced = new Set<number>();
  private readonly unsubscribe: () => void;

  /**
   * EXTENSION is the root of the extension; the script is under out/.
   * INSPECT is called when the user clicks a value of a transcript.
   */
  constructor(
    private readonly extension: vscode.Uri,
    private readonly ide: Ide,
    private readonly inspect: (
      connectionId: number,
      replId: number,
      entry: number,
      value: number,
    ) => Promise<void>,
    private readonly log: (line: string) => void = () => undefined,
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

  /**
   * Hide the panel when the mREPL is showing; otherwise open it, as the
   * terminal's toggle does.
   */
  async toggle(): Promise<void> {
    if (this.view?.visible) {
      await vscode.commands.executeCommand("workbench.action.closePanel");
    } else {
      await this.open();
    }
  }

  /**
   * Open a new REPL and make it the active tab, on CONNECTION when given
   * (which then becomes the active connection), else on the active one.
   */
  create(connection?: Connection): Promise<void> {
    // One creation at a time: a REPL's first events can arrive before
    // the reply that names it, and are then adopted by the open one.
    this.creating = this.creating.then(() => this.createOne(connection));
    return this.creating;
  }

  /**
   * Make PACKAGENAME, the package of the file being evaluated, the
   * package of the active REPL, when vsclide.repl.syncPackage is on and
   * the REPL is elsewhere. It does not wait and does not complain: a
   * package the image lacks, such as one not yet loaded, leaves the REPL
   * where it is.
   */
  syncPackage(packageName: string | undefined): void {
    const enabled = vscode.workspace
      .getConfiguration("vsclide")
      .get<boolean>("repl.syncPackage", true);
    const id = this.active;
    const tab = id === undefined ? undefined : this.repls.get(id);
    if (!enabled || id === undefined || !tab) return;
    const connection = this.ide.get(tab.connectionId);
    const wanted = packageName;
    if (
      !connection ||
      !wanted ||
      !needsPackageSync(this.packages.get(id), wanted, this.busy.has(id))
    ) {
      return;
    }
    connection.syncReplPackage(tab.replId, wanted).catch(() => undefined);
  }

  /** Close the active REPL. */
  async closeActive(): Promise<void> {
    if (this.active !== undefined) await this.close(this.active);
  }

  /** Clear the transcript of the active REPL. */
  clearActive(): void {
    this.post({ type: "clear", replId: this.active });
  }

  private async createOne(chosen?: Connection): Promise<void> {
    try {
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`, {
        preserveFocus: true,
      });
      this.post({ type: "problem" });
      // Connect first, so a start that fails fails once and is reported.
      // The REPL goes to the active connection.
      const connection = chosen ?? (await this.ide.connect());
      this.adopting = connection.id;
      const art = vscode.workspace
        .getConfiguration("vsclide")
        .get<boolean>("repl.sylvester", true);
      this.banner = banner(
        art ? await this.sylvesterText(connection) : undefined,
      );
      const id = await connection.createRepl();
      this.adopt(connection, id);
      if (chosen) this.ide.setActive(chosen.id);
    } catch (error) {
      this.log(`vsclide: could not start a REPL: ${(error as Error).message}`);
      this.post(
        this.repls.size === 0
          ? { type: "problem", text: problemText(error) }
          : { type: "notice", text: problemText(error) },
      );
    } finally {
      this.adopting = undefined;
    }
  }

  /**
   * Fetch sylvesters.txt once, from the first image asked; absence is
   * remembered too.
   */
  private async sylvesterText(
    connection: Connection,
  ): Promise<string | undefined> {
    if (this.sylvesters === null) {
      this.sylvesters = await connection.sylvesters().catch(() => undefined);
    }
    return this.sylvesters;
  }

  private async close(id: number): Promise<void> {
    const tab = this.repls.get(id);
    if (!tab) return;
    this.repls.delete(id);
    this.packages.delete(id);
    this.busy.delete(id);
    this.announced.delete(id);
    this.post({ type: "remove", replId: id });
    if (this.active === id) this.active = [...this.repls.keys()].pop();
    this.post({ type: "select", replId: this.active });
    await this.ide
      .get(tab.connectionId)
      ?.closeRepl(tab.replId)
      .catch(() => undefined);
  }

  /** Note that tab ID is the one last used on its connection. */
  private remember(id: number): void {
    const tab = this.repls.get(id);
    if (tab) this.lastTab.set(tab.connectionId, id);
  }

  /**
   * The active connection changed: show its REPL, the one last used or
   * else the newest, or say that it has none yet.
   */
  private followActive(): void {
    const id = this.ide.active?.id;
    this.post({ type: "active", group: id });
    if (id === undefined) return;
    let tab = this.lastTab.get(id);
    if (tab === undefined || !this.repls.has(tab)) {
      tab = [...this.repls]
        .filter(([, other]) => other.connectionId === id)
        .map(([number]) => number)
        .pop();
    }
    this.active = tab;
    this.post({
      type: "problem",
      text:
        tab === undefined
          ? `No mREPL on ${this.groupName(id)}. Use + above.`
          : undefined,
    });
    this.post({ type: "select", replId: tab });
  }

  /** Give connection ID its heading in the page, with or without REPLs. */
  private announceGroup(id: number): void {
    const connection = this.ide.get(id);
    if (connection) {
      this.endpoints.set(id, {
        name: connection.name,
        origin: connection.origin,
        host: connection.host,
        port: connection.port,
      });
    }
    this.post({ type: "group", group: id, groupName: this.groupName(id) });
  }

  /**
   * Connect again to what connection ID was, the Lisp VSCLIDE owns or
   * the slynk it attached to, drop the dead tabs and open a REPL on the
   * new connection. The old REPLs cannot come back: they lived in the
   * connection that ended.
   */
  private async reconnect(id: number): Promise<void> {
    const was = this.endpoints.get(id);
    if (!was) return;
    let connection: Connection;
    try {
      connection =
        was.origin === "spawned"
          ? await this.ide.start()
          : await this.ide.attach(was.host, was.port, was.name);
    } catch (error) {
      void vscode.window.showErrorMessage(
        `VSCLIDE: could not reconnect to ${was.name}: ` +
          (error as Error).message,
      );
      return;
    }
    this.dropGroup(id);
    this.ide.setActive(connection.id);
    await this.create();
  }

  /** Remove the tabs and the heading of the ended connection ID. */
  private dropGroup(id: number): void {
    for (const [tabId, tab] of [...this.repls]) {
      if (tab.connectionId !== id) continue;
      this.repls.delete(tabId);
      this.packages.delete(tabId);
      this.busy.delete(tabId);
      this.announced.delete(tabId);
      this.post({ type: "remove", replId: tabId });
    }
    this.lastTab.delete(id);
    this.endpoints.delete(id);
    this.post({ type: "ungroup", group: id });
    if (this.active !== undefined && !this.repls.has(this.active)) {
      this.active = [...this.repls.keys()].pop();
      this.post({ type: "select", replId: this.active });
    }
  }

  /** Tell the page whether several connections are open. */
  private announceMulti(): void {
    this.post({ type: "multi", on: this.ide.connections.length > 1 });
  }

  /** Return the page's number for REPL REPLID of CONNECTIONID, if open. */
  private find(connectionId: number, replId: number): number | undefined {
    for (const [id, tab] of this.repls) {
      if (tab.connectionId === connectionId && tab.replId === replId) {
        return id;
      }
    }
    return undefined;
  }

  /**
   * Record REPL REPLID of CONNECTION as open, add its tab and make it
   * the active one. Return the page's number for it.
   */
  private adopt(connection: Connection, replId: number): number {
    const known = this.find(connection.id, replId);
    if (known !== undefined) return known;
    const count = (this.counters.get(connection.id) ?? 0) + 1;
    this.counters.set(connection.id, count);
    const id = this.nextTab++;
    this.repls.set(id, {
      connectionId: connection.id,
      replId,
      title: `mREPL ${count}`,
    });
    this.active = id;
    this.remember(id);
    this.announce(id);
    // The banner comes before anything slynk has said for this REPL.
    this.post({ type: "output", replId: id, text: this.banner, first: true });
    this.banner = "";
    return id;
  }

  /** Tell the page about REPL ID, once. */
  private announce(id: number): void {
    const tab = this.repls.get(id);
    if (tab === undefined || this.announced.has(id)) return;
    this.announced.add(id);
    this.post({
      type: "add",
      replId: id,
      title: tab.title,
      group: tab.connectionId,
      groupName: this.groupName(tab.connectionId),
    });
  }

  private async onMessage(message: Outgoing): Promise<void> {
    try {
      switch (message.type) {
        case "ready":
          this.flush();
          break;
        case "send": {
          const tab = this.repls.get(message.replId);
          if (!tab) break;
          this.busy.add(message.replId);
          await this.connectionOf(tab).sendToRepl(tab.replId, message.text);
          break;
        }
        case "interrupt": {
          const tab = this.repls.get(message.replId);
          if (tab) await this.connectionOf(tab).interruptRepl(tab.replId);
          break;
        }
        case "reconnect":
          await this.reconnect(message.group);
          break;
        case "dismiss":
          this.dropGroup(message.group);
          break;
        case "select": {
          this.active = message.replId;
          this.remember(message.replId);
          // The REPL chosen is the connection the editor uses too.
          const tab = this.repls.get(message.replId);
          if (tab) this.ide.setActive(tab.connectionId);
          break;
        }
        case "close":
          await this.close(message.replId);
          break;
        case "inspect": {
          const tab = this.repls.get(message.replId);
          if (tab) {
            await this.inspect(
              tab.connectionId,
              tab.replId,
              message.entry,
              message.value,
            );
          }
          break;
        }
      }
    } catch (error) {
      this.post({
        type: "notice",
        replId: "replId" in message ? message.replId : undefined,
        text: (error as Error).message,
      });
    }
  }

  /** Return the connection TAB is on, or throw when it has gone. */
  private connectionOf(tab: ReplTab): Connection {
    const connection = this.ide.get(tab.connectionId);
    if (!connection) throw new Error("This REPL's connection has ended.");
    return connection;
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
    this.announceMulti();
    for (const connection of this.ide.connections) {
      this.announceGroup(connection.id);
    }
    this.post({ type: "active", group: this.ide.active?.id });
    this.post({ type: "select", replId: this.active });
  }

  /**
   * Open a first mREPL, without taking focus, when the Lisp has just
   * connected and the vsclide.repl.openOnConnect setting is on. Nothing
   * happens while a REPL is being created, as that is what connects.
   */
  private async openOnConnect(): Promise<void> {
    const enabled = vscode.workspace
      .getConfiguration("vsclide")
      .get<boolean>("repl.openOnConnect", false);
    if (!enabled || this.adopting !== undefined || this.repls.size > 0) {
      return;
    }
    await this.create();
  }

  private onEvent(event: IdeEvent): void {
    if (event.type === "active") {
      this.followActive();
      return;
    }
    if (event.type === "connected") {
      this.announceGroup(event.connectionId);
      this.announceMulti();
      void this.openOnConnect();
      return;
    }
    if (event.type === "disconnected") {
      this.announceMulti();
      const text = `Disconnected: ${event.reason}. Close this tab and open ` +
        "a new mREPL.";
      for (const [replId, tab] of this.repls) {
        if (tab.connectionId !== event.connectionId) continue;
        this.post({ type: "notice", replId, text });
      }
      const has = [...this.repls.values()].some(
        (tab) => tab.connectionId === event.connectionId,
      );
      this.post(
        has
          ? {
              type: "group",
              group: event.connectionId,
              groupName: this.groupName(event.connectionId),
              ended: true,
            }
          : { type: "ungroup", group: event.connectionId },
      );
      return;
    }
    if (!("replId" in event)) return;
    let replId = this.find(event.connectionId, event.replId);
    if (replId === undefined) {
      const connection = this.ide.get(event.connectionId);
      if (this.adopting !== event.connectionId || !connection) return;
      replId = this.adopt(connection, event.replId);
    }
    switch (event.type) {
      case "replOutput":
        this.post({ type: "output", replId, text: event.text });
        break;
      case "replPrompt":
        this.busy.delete(replId);
        this.packages.set(replId, {
          name: event.packageName,
          nickname: event.nickname,
        });
        this.post({ type: "prompt", replId, text: `${event.nickname}>` });
        break;
      case "replValues":
        this.post({
          type: "values",
          replId,
          values: event.values.map((value) => ({
            text: value.text,
            entry: value.index,
            value: value.value,
          })),
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

  /**
   * Return the name the page shows for connection ID, kept after the
   * connection has gone, as its tabs stay.
   */
  private groupName(id: number): string {
    const name = this.ide.get(id)?.name ?? this.names.get(id);
    const shown = name ?? `connection ${id}`;
    this.names.set(id, shown);
    return shown;
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
  .value.inspectable { cursor: pointer; width: fit-content; }
  .value.inspectable:hover { text-decoration: underline; }
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
  .group { display: flex; flex-direction: column; flex: 1 1 auto;
           min-height: 0; border-top: 1px solid
           var(--vscode-sideBarSectionHeader-border,
               var(--vscode-panel-border)); }
  .group.collapsed { flex: 0 0 auto; }
  .group.collapsed .group-body { display: none; }
  .group-body { overflow-y: auto; min-height: 0; }
  .group-name { display: flex; gap: 4px; padding: 3px 8px; cursor: pointer;
                font-size: 11px; font-weight: bold; text-transform: uppercase;
                color: var(--vscode-sideBarSectionHeader-foreground,
                           var(--vscode-foreground));
                background: var(--vscode-sideBarSectionHeader-background,
                                transparent);
                white-space: nowrap; overflow: hidden; }
  .group-name .name { overflow: hidden; text-overflow: ellipsis; flex: 1; }
  .group-name .actions { display: flex; gap: 6px; }
  .group-name .action { padding: 0 2px; }
  .group-name .action:hover {
    background: var(--vscode-toolbar-hoverBackground); }
  .group-name .chevron { flex: none; transition: transform 0.1s; }
  .group:not(.collapsed) .chevron { transform: rotate(90deg); }
  .group-name.ended .name { opacity: 0.5; }
  .group-name.current .name::before { content: "\\25cf\\a0"; }
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
