import * as vscode from "vscode";
import {
  DebugLevel,
  DebugModel,
  FRAME_BATCH,
  locationFile,
} from "../base/debugger";
import { Connection, Ide, IdeEvent } from "../base/ide";
import { Inspected, InspectorModel } from "../base/inspector";
import {
  ConnectionSummary,
  PanelMessage,
  PanelState,
  PanelUi,
  Tab,
  panelState,
} from "../base/panel";
import { locationOffset } from "../lib/source-location";

/** How many parts of an object are fetched at a time. */
const PART_BATCH = 100;

/** The debugger and the inspector of one connection. */
interface Models {
  debug: DebugModel;
  inspector: InspectorModel;
}

/**
 * The debugger and inspector panel: one webview beside the editor with
 * a tab for each, and a grouped list of the connections, each with its
 * own debugger and inspector. It owns the models of every connection,
 * keeps them up to date from the IDE's events, does what the page asks
 * for the connection shown, and sends the page the whole state after
 * each change. The page only draws.
 */
export class DebugPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private readonly models = new Map<number, Models>();
  /** Models for when no connection is shown; they never change. */
  private readonly none: Models = {
    debug: new DebugModel(),
    inspector: new InspectorModel(),
  };
  /** The connection whose debugger and inspector are shown. */
  private viewing: number | undefined;
  private readonly ui: PanelUi = {
    tab: "debugger",
    output: undefined,
    notice: undefined,
  };
  /** False until the page has loaded; the latest state waits for it. */
  private ready = false;
  private packageName: string | undefined;
  private readonly subscriptions: (() => void)[] = [];

  /**
   * EXTENSION is the root of the extension; the script is under out/.
   * DEBUGGING is told whenever a level opens or the last one closes.
   */
  constructor(
    private readonly extension: vscode.Uri,
    private readonly ide: Ide,
    private readonly debugging: (debugging: boolean) => void,
  ) {
    this.subscriptions.push(ide.onEvent((event) => this.onEvent(event)));
  }

  /** The debugger of the connection shown. */
  private get debug(): DebugModel {
    return this.shown.debug;
  }

  /** The inspector of the connection shown. */
  private get inspector(): InspectorModel {
    return this.shown.inspector;
  }

  private get shown(): Models {
    return this.models.get(this.viewing ?? -1) ?? this.none;
  }

  /** Return the models of connection ID, made when new. */
  private modelsOf(id: number): Models {
    let models = this.models.get(id);
    if (!models) {
      models = { debug: new DebugModel(), inspector: new InspectorModel() };
      this.subscriptions.push(
        models.debug.onChange(() => this.changed()),
        models.inspector.onChange(() => this.push()),
      );
      this.models.set(id, models);
    }
    return models;
  }

  /** Return the connection whose models are shown, or throw. */
  private connection(): Connection {
    const connection =
      this.ide.get(this.viewing ?? -1) ?? this.ide.active;
    if (!connection) throw new Error("Not connected to slynk.");
    return connection;
  }

  /** True while any Lisp is in the debugger. */
  get isDebugging(): boolean {
    return [...this.models.values()].some((m) => m.debug.debugging);
  }

  /** Show the panel beside the editor, at TAB if given. */
  show(tab?: Tab, preserveFocus = false): void {
    if (tab) this.ui.tab = tab;
    if (this.panel) {
      this.panel.reveal(undefined, preserveFocus);
    } else {
      this.create(preserveFocus);
    }
    this.push();
  }

  /**
   * Inspect the value of CODE, read in PACKAGE if given, and show the
   * inspector.
   */
  async inspectExpression(code: string, packageName?: string): Promise<void> {
    this.packageName = packageName ?? this.packageName;
    await this.run(async () => {
      const connection = await this.ide.connect();
      this.view(connection.id);
      this.show("inspector");
      this.ui.output = undefined;
      this.inspector.start(await connection.inspectInit(code, packageName));
    });
  }

  /**
   * Inspect value VALUE of history entry ENTRY of REPL REPLID of
   * connection CONNECTIONID.
   */
  async inspectReplValue(
    connectionId: number,
    replId: number,
    entry: number,
    value: number,
  ): Promise<void> {
    this.view(connectionId);
    this.show("inspector");
    await this.run(async () => {
      this.ui.output = undefined;
      this.inspector.start(
        await this.connection().inspectReplValue(replId, entry, value),
      );
    });
  }

  /** Show the debugger and inspector of connection ID. */
  view(id: number): void {
    this.modelsOf(id);
    this.viewing = id;
  }

  /**
   * Show in the inspector what LOAD inspects, the first part; keep
   * the focus where it is if PRESERVEFOCUS.
   */
  async inspectWith(
    load: () => Promise<Inspected | undefined>,
    preserveFocus = false,
  ): Promise<void> {
    this.show("inspector", preserveFocus);
    await this.run(async () => {
      this.ui.output = undefined;
      this.inspector.start(await load());
    });
  }

  /** Use the continue restart of the current level. */
  async continue(): Promise<void> {
    await this.run(() =>
      this.withLevel((l) => this.connection().debugContinue(l.threadId)),
    );
  }

  /** Return to the previous level of the current thread. */
  async abort(): Promise<void> {
    await this.run(() =>
      this.withLevel((l) => this.connection().debugAbort(l.threadId)),
    );
  }

  /** Abandon the evaluation that is being debugged. */
  async quit(): Promise<void> {
    await this.run(() =>
      this.withLevel((l) => this.connection().debugQuit(l.threadId)),
    );
  }

  /** Step into, over or out of the selected frame. */
  async step(kind: "into" | "next" | "out"): Promise<void> {
    await this.run(() =>
      this.withLevel((l) =>
        this.connection().debugStep(l.threadId, l.selected, kind),
      ),
    );
  }

  /** Toggle *break-on-signals* and say what it is now. */
  async toggleBreakOnSignals(): Promise<void> {
    await this.run(async () => {
      this.ui.notice = await this.connection().breakOnSignals();
    });
  }

  private create(preserveFocus: boolean): void {
    const panel = vscode.window.createWebviewPanel(
      "vsclide.debugger",
      "VSCLIDE",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extension, "out")],
      },
    );
    this.panel = panel;
    this.ready = false;
    panel.webview.html = this.html(panel.webview);
    panel.webview.onDidReceiveMessage((message: PanelMessage) =>
      void this.onMessage(message),
    );
    panel.onDidDispose(() => {
      if (this.panel === panel) this.panel = undefined;
    });
  }

  private onEvent(event: IdeEvent): void {
    switch (event.type) {
      case "debugOpen": {
        // A debugger that opens takes the view, as it needs attention.
        this.view(event.connectionId);
        this.ui.tab = "debugger";
        this.debug.open(event.level);
        this.show("debugger");
        void this.loadDetails(event.level, event.level.selected);
        break;
      }
      case "debugActivate":
        this.modelsOf(event.connectionId).debug.activate(
          event.threadId,
          event.level,
        );
        break;
      case "debugReturn":
        this.modelsOf(event.connectionId).debug.leave(
          event.threadId,
          event.level,
        );
        break;
      case "debugCondition":
        this.ui.notice = event.message;
        this.push();
        break;
      case "connected":
        this.modelsOf(event.connectionId);
        this.viewing ??= event.connectionId;
        this.push();
        break;
      case "disconnected": {
        const models = this.models.get(event.connectionId);
        models?.debug.clear();
        models?.inspector.clear();
        this.models.delete(event.connectionId);
        if (this.viewing === event.connectionId) {
          this.viewing = this.ide.active?.id;
        }
        this.ui.output = undefined;
        this.changed();
        break;
      }
      case "active":
        this.push();
        break;
      default:
        break;
    }
  }

  /** What the page lists of each connection. */
  private summaries(): ConnectionSummary[] {
    return this.ide.connections.map((connection) => {
      const models = this.models.get(connection.id);
      return {
        id: connection.id,
        name: connection.name,
        levels: models?.debug.all.length ?? 0,
        inspecting: models?.inspector.current !== undefined,
      };
    });
  }

  /** The debug model changed: tell the page, and the status. */
  private changed(): void {
    this.debugging(this.isDebugging);
    this.push();
  }

  /** Send the page the state, or keep it for when the page is ready. */
  private push(): void {
    if (!this.panel || !this.ready) return;
    const state: PanelState = panelState(
      this.debug,
      this.inspector,
      this.ui,
      this.summaries(),
      this.viewing,
    );
    this.panel.title = this.isDebugging ? "VSCLIDE (debugging)" : "VSCLIDE";
    void this.panel.webview.postMessage({ type: "state", state });
  }

  /** Run ACTION; a failure is shown as the notice, not thrown. */
  private async run(action: () => Promise<void>): Promise<void> {
    this.ui.notice = undefined;
    try {
      await action();
    } catch (error) {
      this.ui.notice = (error as Error).message;
    }
    this.push();
  }

  /** Run ACTION on the current level, if there is one. */
  private async withLevel(
    action: (level: DebugLevel) => Promise<unknown>,
  ): Promise<void> {
    const level = this.debug.current;
    if (!level) throw new Error("not in the debugger");
    await action(level);
  }

  /** Fetch what is known of frame INDEX of LEVEL, unless it is. */
  private async loadDetails(level: DebugLevel, index: number): Promise<void> {
    if (level.details[index]) return;
    try {
      const details = await this.connection().debugFrame(
        level.threadId,
        index,
      );
      this.debug.setDetails(level.threadId, level.level, index, details);
    } catch (error) {
      this.ui.notice = (error as Error).message;
      this.push();
    }
  }

  /** Open the source of frame INDEX of LEVEL and put the cursor there. */
  private async openSource(level: DebugLevel, index: number): Promise<void> {
    await this.loadDetails(level, index);
    const location = level.details[index]?.location;
    const file = location ? locationFile(location) : null;
    if (!location || !file) {
      throw new Error(location?.error ?? "this frame has no source file");
    }
    const document = await vscode.workspace.openTextDocument(file);
    const offset = locationOffset(document.getText(), location);
    const editor = await vscode.window.showTextDocument(document, {
      viewColumn: vscode.ViewColumn.One,
      preserveFocus: false,
    });
    if (offset === undefined) return;
    const position = document.positionAt(offset);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(
      new vscode.Range(position, position),
      vscode.TextEditorRevealType.InCenterIfOutsideViewport,
    );
  }

  private async onMessage(message: PanelMessage): Promise<void> {
    if (message.type === "ready") {
      this.ready = true;
      this.push();
      return;
    }
    await this.run(() => this.handle(message));
  }

  /** Do what the page asked. */
  private async handle(message: PanelMessage): Promise<void> {
    if (message.type === "view") {
      this.view(message.connectionId);
      this.ui.tab = message.tab;
      return;
    }
    const level = this.debug.current;
    const inspected = this.inspector.current;
    switch (message.type) {
      case "tab":
        this.ui.tab = message.tab;
        return;
      case "continue":
        return this.continue();
      case "abort":
        return this.abort();
      case "quit":
        return this.quit();
      case "step":
        return this.step(message.kind);
      case "breakOnSignals":
        return this.toggleBreakOnSignals();
      case "switchLevel":
        this.debug.switchTo(message.threadId, message.level);
        return;
      case "inspect":
        this.ui.output = undefined;
        this.inspector.start(
          await this.connection().inspectInit(message.code, this.packageName),
        );
        return;
      case "back":
        this.ui.output = undefined;
        this.inspector.goBack(await this.connection().inspectPop());
        return;
      case "forward":
        this.ui.output = undefined;
        this.inspector.goForward(await this.connection().inspectNext());
        return;
      case "reinspect":
        this.inspector.refresh(await this.connection().inspectReinspect());
        return;
      case "verbose":
        this.inspector.refresh(await this.connection().inspectToggleVerbose());
        return;
      case "part":
        this.ui.output = undefined;
        this.inspector.descend(
          await this.connection().inspectPart(message.index),
        );
        return;
      case "action":
        this.inspector.refresh(
          await this.connection().inspectAction(message.index),
        );
        return;
      case "morePartsOfObject":
        if (inspected) {
          const end = inspected.end;
          this.inspector.extend(
            await this.connection().inspectRange(end, end + PART_BATCH),
          );
        }
        return;
      case "inspectEval":
        this.ui.output = {
          label: `* ${message.code}`,
          text: await this.connection().inspectEval(message.code),
        };
        return;
      case "describe":
        this.ui.output = {
          label: "Describe",
          text: await this.connection().inspectDescribe(message.index),
        };
        return;
      case "closeInspector":
        this.ui.output = undefined;
        this.inspector.clear();
        return;
      default:
        break;
    }
    if (!level) throw new Error("not in the debugger");
    await this.handleInLevel(message, level);
  }

  /** Do what the page asked of the current debugger LEVEL. */
  private async handleInLevel(
    message: PanelMessage,
    level: DebugLevel,
  ): Promise<void> {
    const ide = this.connection();
    const { threadId } = level;
    const frame = level.selected;
    switch (message.type) {
      case "restart":
        await ide.debugRestart(threadId, level.level, message.index);
        return;
      case "selectFrame":
        this.debug.select(message.index);
        await this.loadDetails(level, message.index);
        return;
      case "moreFrames": {
        const last = level.frames[level.frames.length - 1];
        const start = last ? last.index + 1 : 0;
        const frames = await ide.debugBacktrace(
          threadId,
          start,
          start + FRAME_BATCH,
        );
        this.debug.addFrames(threadId, level.level, frames, FRAME_BATCH);
        return;
      }
      case "openSource":
        await this.openSource(level, message.index);
        return;
      case "evalInFrame": {
        const details = level.details[frame];
        const result = await ide.debugEval(
          threadId,
          frame,
          message.code,
          details?.package || undefined,
          message.pprint,
        );
        this.debug.addEval(threadId, level.level, {
          frame,
          code: message.code,
          ok: result.ok,
          text: result.text,
        });
        return;
      }
      case "returnFrom":
        await ide.debugReturnFrom(threadId, frame, message.code);
        return;
      case "restartFrame":
        await ide.debugRestartFrame(threadId, frame);
        return;
      case "inspectLocal":
        this.openInspector(
          await ide.inspectFrameVar(threadId, frame, message.variable),
        );
        return;
      case "inspectInFrame":
        this.openInspector(
          await ide.inspectFrame(threadId, frame, message.code),
        );
        return;
      case "inspectCondition":
        this.openInspector(await ide.inspectCondition(threadId));
        return;
      default:
        return;
    }
  }

  /** Start the inspector at OBJECT, and bring its tab forward. */
  private openInspector(
    object: Parameters<InspectorModel["start"]>[0],
  ): void {
    this.ui.output = undefined;
    this.ui.tab = "inspector";
    this.inspector.start(object);
  }

  /** Return the page; the content security policy allows our script only. */
  private html(webview: vscode.Webview): string {
    const script = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extension, "out", "webview", "debugger.js"),
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
${STYLE}
</style>
</head>
<body>
<div id="sidebar"></div>
<div id="main">
<div id="tabs">
  <button id="tab-debugger" class="tab">Debugger</button>
  <button id="tab-inspector" class="tab">Inspector</button>
  <span id="notice"></span>
</div>

<div id="debugger" class="page">
  <div id="debugger-empty" class="muted">Not in the debugger.</div>
  <div id="debugger-body">
    <div id="levels"></div>
    <div id="condition">
      <div id="condition-message"></div>
      <div id="condition-type" class="muted"></div>
    </div>
    <div id="toolbar"></div>
    <div id="sections">
      <div class="block" style="flex: 2 1 0">
        <div class="toggle">Restarts</div>
        <div id="restarts" class="body"></div>
      </div>
      <div class="sash"></div>
      <div class="block" style="flex: 4 1 0">
        <div class="toggle">Backtrace</div>
        <div id="frames" class="body"></div>
        <button id="more-frames" class="link">More frames...</button>
      </div>
      <div class="sash"></div>
      <div class="block" style="flex: 3 1 0">
        <div class="toggle">Frame</div>
        <div id="details" class="body"></div>
      </div>
      <div class="sash"></div>
      <div class="block" style="flex: 3 1 0">
        <div class="toggle">Evaluate in frame</div>
        <div id="evals" class="body"></div>
        <div class="bar">
          <input id="eval-code" spellcheck="false"
            placeholder="Lisp form; Enter evaluates in the selected frame">
          <label><input type="checkbox" id="pprint"> pretty</label>
          <button id="inspect-in-frame">Inspect</button>
          <button id="return-from">Return</button>
        </div>
      </div>
    </div>
  </div>
</div>

<div id="inspector" class="page">
  <div class="bar">
    <button id="back" title="Previous object">&lt;</button>
    <button id="forward" title="Next object">&gt;</button>
    <input id="inspect-code" spellcheck="false"
      placeholder="Lisp form to inspect; Enter inspects its value">
  </div>
  <div id="inspector-empty" class="muted">Nothing is inspected.</div>
  <div id="inspector-body">
    <div id="inspected-title" class="title"></div>
    <div id="toolbar-inspector">
      <button id="reinspect">Reinspect</button>
      <button id="verbose">Verbose</button>
      <button id="describe">Describe</button>
      <button id="close-inspector">Close</button>
    </div>
    <pre id="content"></pre>
    <button id="more-parts" class="link">More...</button>
    <div id="inspect-output"></div>
    <div class="bar">
      <input id="object-eval" spellcheck="false"
        placeholder="Evaluate with * bound to this object">
    </div>
  </div>
</div>
</div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.subscriptions.forEach((stop) => stop());
    this.panel?.dispose();
  }
}

/** The page's style; colors come from the theme. */
const STYLE = `
  html, body { height: 100%; }
  body { display: flex; flex-direction: row; margin: 0; padding: 0;
         font-family: var(--vscode-editor-font-family);
         font-size: var(--vscode-editor-font-size);
         color: var(--vscode-editor-foreground); }
  #main { flex: 1; display: flex; flex-direction: column; min-width: 0;
          min-height: 0; }
  #sidebar { display: none; width: 180px; flex-direction: column;
             overflow-y: auto; border-right: 1px solid
             var(--vscode-panel-border);
             font-family: var(--vscode-font-family);
             font-size: var(--vscode-font-size); }
  #sidebar.shown { display: flex; }
  .group-name { padding: 4px 8px 2px; font-weight: bold;
                color: var(--vscode-descriptionForeground);
                white-space: nowrap; overflow: hidden;
                text-overflow: ellipsis; }
  .entry { padding: 3px 8px 3px 16px; cursor: pointer; }
  .entry:hover { background: var(--vscode-list-hoverBackground); }
  .entry.active { background: var(--vscode-list-activeSelectionBackground);
                  color: var(--vscode-list-activeSelectionForeground); }
  #tabs { display: flex; align-items: center; gap: 2px; padding: 4px 8px 0;
          border-bottom: 1px solid var(--vscode-panel-border); }
  .tab { background: transparent; color: var(--vscode-foreground);
         border: none; border-bottom: 2px solid transparent;
         padding: 4px 12px; cursor: pointer; }
  .tab.active { border-bottom-color: var(--vscode-focusBorder); }
  #notice { margin-left: 12px; font-style: italic;
            color: var(--vscode-descriptionForeground); }
  .page { display: none; flex: 1; flex-direction: column; min-height: 0;
          overflow-y: auto; padding: 4px 8px; }
  #debugger-body, #inspector-body { display: none; flex-direction: column;
                                    gap: 2px; }
  .muted { color: var(--vscode-descriptionForeground); }
  .section { margin-top: 8px; font-weight: bold;
             color: var(--vscode-descriptionForeground); }
  .toggle { cursor: pointer; user-select: none; flex: none;
            padding: 3px 4px; font-size: 11px; font-weight: bold;
            text-transform: uppercase;
            color: var(--vscode-sideBarSectionHeader-foreground,
                       var(--vscode-foreground));
            background: var(--vscode-sideBarSectionHeader-background); }
  .toggle::before { content: ""; display: inline-block; width: 5px;
                    height: 5px; margin: 0 8px 2px 4px;
                    border-right: 1.5px solid currentColor;
                    border-bottom: 1.5px solid currentColor;
                    transform: rotate(45deg); }
  .block.collapsed > .toggle::before { transform: rotate(-45deg); }
  #debugger-body { flex: 1 1 0; min-height: 0; }
  #debugger-body > * { flex: none; }
  #debugger-body > #sections { flex: 1 1 0; min-height: 0; }
  #sections { display: flex; flex-direction: column; }
  .block { display: flex; flex-direction: column; min-height: 0; }
  .block.collapsed { flex: 0 0 auto !important; }
  .block.collapsed > :not(.toggle) { display: none; }
  .block > .body { flex: 1 1 auto; min-height: 0; overflow: auto; }
  .block > .bar, .block > button { flex: none; }
  .sash { flex: none; height: 4px; cursor: ns-resize;
          border-top: 1px solid var(--vscode-panel-border); }
  .sash:hover { background: var(--vscode-sash-hoverBorder); }
  .title { font-weight: bold; margin: 4px 0; }
  #condition-message { color: var(--vscode-errorForeground);
                       white-space: pre-wrap; }
  #toolbar, #toolbar-inspector, #levels { display: flex; flex-wrap: wrap;
                                          gap: 4px; margin: 4px 0; }
  button { color: var(--vscode-button-foreground);
           background: var(--vscode-button-background); border: none;
           padding: 3px 8px; cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: default; }
  button.active { outline: 1px solid var(--vscode-focusBorder); }
  button.link { background: transparent; text-align: left;
                color: var(--vscode-textLink-foreground); }
  .tab:disabled { opacity: 1; }
  .row { display: flex; gap: 8px; padding: 1px 4px; cursor: default; }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .row.selected { background: var(--vscode-list-activeSelectionBackground);
                  color: var(--vscode-list-activeSelectionForeground); }
  .restart, .frame { cursor: pointer; }
  .number { color: var(--vscode-descriptionForeground); min-width: 2em; }
  .name { color: var(--vscode-symbolIcon-variableForeground, #9cdcfe); }
  .eval .code { color: var(--vscode-terminal-ansiGreen); }
  .result.error { color: var(--vscode-errorForeground); }
  .bar { display: flex; align-items: center; gap: 6px; margin: 4px 0; }
  .bar input[type=text], .bar input:not([type]) {
    flex: 1; font: inherit; color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent); }
  #content { white-space: pre-wrap; margin: 4px 0; }
  #content .value { color: var(--vscode-terminal-ansiCyan); cursor: pointer;
                    text-decoration: underline; }
  #content .action { color: var(--vscode-textLink-foreground);
                     cursor: pointer; }
  #content .label { color: var(--vscode-terminal-ansiYellow); }
  #inspect-output { display: none; }
  #inspect-output pre { white-space: pre-wrap; }
`;
