import {
  DebugLevel,
  FrameDetails,
  Frame,
  parseFrameDetails,
  parseFrames,
  parseLevel,
} from "./debugger";
import {
  Inspected,
  Range,
  parseInspected,
  parseRange,
} from "./inspector";
import {
  CompileResult,
  Completion,
  Definition,
  parseCompileResult,
  parseCompletions,
  parseDefinitions,
  parseReferences,
  Reference,
} from "./language";
import { LiveRule, toLiveRules } from "../lib/indent-rules";
import { LaunchOptions, LispProcess, startSlynk } from "./process";
import {
  Playhead,
  Search,
  StickerCompile,
  StickerInfo,
  parsePlayhead,
  parseStickerCompile,
  parseStickers,
} from "./stickers";
import { Session } from "./session";

/** What slynk reports about itself; null where it reports nothing. */
export interface ConnectionInfo {
  implementation: {
    type: string | null;
    name: string | null;
    version: string | null;
    program: string | null;
  };
  pid: number | null;
  style: string | null;
  machine: {
    instance: string | null;
    type: string | null;
    version: string | null;
  };
  package: { name: string | null; prompt: string | null };
  protocolVersion: string | null;
  /** The features of the image, lower case; absent from older clide. */
  features?: string[];
}

/** The outcome of evaluating code. A Lisp error has ok false. */
export interface EvalResult {
  ok: boolean;
  /** What the code printed. */
  output: string;
  /** The printed value, or null after an error. */
  value: string | null;
  /** The error message, or null when the code ran. */
  error: string | null;
}

/**
 * Where a connection came from: a Lisp VSCLIDE started and stops, or a
 * running slynk it attached to and only disconnects.
 */
export type Origin = "spawned" | "attached";

/** What happened on one connection; the event names it. */
export type ConnectionEvent =
  | { type: "connected"; info: ConnectionInfo }
  | { type: "disconnected"; reason: string }
  | { type: "output"; text: string }
  | { type: "replOutput"; replId: number; text: string }
  | {
      type: "replPrompt";
      replId: number;
      packageName: string;
      nickname: string;
      level: number;
      entry: number;
      condition: string | null;
    }
  | {
      type: "replValues";
      replId: number;
      values: { text: string; index: number; value: number }[];
    }
  | { type: "replAborted"; replId: number; message: string }
  | { type: "replReadMode"; replId: number; mode: string }
  | { type: "replCleared"; replId: number }
  | { type: "debugOpen"; level: DebugLevel }
  | { type: "debugActivate"; threadId: number; level: number }
  | { type: "debugReturn"; threadId: number; level: number; stepping: boolean }
  | { type: "debugCondition"; threadId: number; message: string }
  | { type: "indentation"; rules: LiveRule[] }
  | { type: "features"; features: string[] };

/**
 * Something that happened that the user interface may show: an event of
 * a connection, which names it, or a change of the active connection.
 */
export type IdeEvent =
  | (ConnectionEvent & { connectionId: number })
  | { type: "active"; connectionId: number | undefined };

type Params = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

/**
 * Turn a notification from clide into an event of the connection it
 * names, or undefined when it is not one the interface knows.
 * ide/disconnected is handled by the controller itself, as it also
 * changes its state.
 */
export function parseNotification(
  method: string,
  params: unknown,
): IdeEvent | undefined {
  const body = parseBody(method, params);
  if (!body) return undefined;
  const p = (params ?? {}) as Params;
  return { ...body, connectionId: num(p.connectionId) };
}

function parseBody(
  method: string,
  params: unknown,
): ConnectionEvent | undefined {
  const p = (params ?? {}) as Params;
  switch (method) {
    case "ide/output":
      return { type: "output", text: text(p.text) };
    case "ide/repl/output":
      return { type: "replOutput", replId: num(p.replId), text: text(p.text) };
    case "ide/repl/prompt":
      return {
        type: "replPrompt",
        replId: num(p.replId),
        packageName: text(p.package),
        nickname: text(p.nickname),
        level: num(p.level),
        entry: num(p.entry),
        condition: typeof p.condition === "string" ? p.condition : null,
      };
    case "ide/repl/values": {
      const values = Array.isArray(p.values) ? p.values : [];
      return {
        type: "replValues",
        replId: num(p.replId),
        values: values.map((value) => ({
          text: text((value as Params).text),
          index: num((value as Params).index),
          value: num((value as Params).value),
        })),
      };
    }
    case "ide/repl/aborted":
      return {
        type: "replAborted",
        replId: num(p.replId),
        message: text(p.message),
      };
    case "ide/repl/readMode":
      return {
        type: "replReadMode",
        replId: num(p.replId),
        mode: text(p.mode),
      };
    case "ide/indentation":
      return { type: "indentation", rules: toLiveRules(p.rules) };
    case "ide/features":
      return {
        type: "features",
        features: Array.isArray(p.features)
          ? p.features.filter((f): f is string => typeof f === "string")
          : [],
      };
    case "ide/repl/cleared":
      return { type: "replCleared", replId: num(p.replId) };
    case "ide/debug/open":
      return { type: "debugOpen", level: parseLevel(params) };
    case "ide/debug/activate":
      return {
        type: "debugActivate",
        threadId: num(p.threadId),
        level: num(p.level),
      };
    case "ide/debug/return":
      return {
        type: "debugReturn",
        threadId: num(p.threadId),
        level: num(p.level),
        stepping: p.stepping === true,
      };
    case "ide/debug/condition":
      return {
        type: "debugCondition",
        threadId: num(p.threadId),
        message: text(p.message),
      };
    default:
      return undefined;
  }
}

/**
 * One connection to a slynk server, held by clide: the image's REPLs,
 * debugger, inspector, compiler and stickers. Every request names the
 * connection to clide. It knows nothing of VS Code.
 */
export class Connection {
  constructor(
    /** The id clide gave it; REPL ids and thread ids are its own. */
    readonly id: number,
    /** What the user sees: "SBCL", or the name given when attaching. */
    readonly name: string,
    readonly origin: Origin,
    readonly host: string,
    readonly port: number,
    /** What slynk reported when it connected. */
    readonly info: ConnectionInfo,
    private readonly send: (method: string, params: Params) => Promise<unknown>,
  ) {}

  /** Send METHOD for this connection to clide and return the result. */
  private request<T = unknown>(
    method: string,
    params: Params = {},
  ): Promise<T> {
    const named = { ...params, connectionId: this.id };
    return this.send(method, named) as Promise<T>;
  }

  /**
   * Evaluate CODE, a string of Lisp, in PACKAGE if given. With DEBUG an
   * error enters the debugger, and the promise resolves when the
   * debugger is left; the debugger itself is reported as events.
   */
  async evaluate(
    code: string,
    packageName?: string,
    debug = false,
  ): Promise<EvalResult> {
    return this.request<EvalResult>("ide/eval", {
      code,
      package: packageName,
      debug: debug || undefined,
    });
  }

  /**
   * Return the text of sylvesters.txt from the slynk install, or
   * undefined when there is none.
   */
  async sylvesters(): Promise<string | undefined> {
    const reply = await this.request<{ text: string | null }>(
      "ide/sylvesters",
    );
    return reply.text ?? undefined;
  }

  /**
   * Have the Lisp send the indentation rules of the macros it knows, now
   * and as more code is loaded; they arrive as "indentation" events.
   * Resolve with false when its slynk has no indentation contrib.
   */
  async startIndentation(): Promise<boolean> {
    const reply = await this.request<{ loaded: boolean }>(
      "ide/indentation",
    );
    return reply.loaded === true;
  }

  /** Open a REPL and resolve with its id. */
  async createRepl(): Promise<number> {
    const reply = await this.request<{ replId: number }>(
      "ide/repl/create",
    );
    return reply.replId;
  }

  /** Give REPL one line, or several, of input. */
  async sendToRepl(replId: number, input: string): Promise<void> {
    await this.request("ide/repl/send", { replId, text: input });
  }

  /** Interrupt what REPL is evaluating. */
  async interruptRepl(replId: number): Promise<void> {
    await this.request("ide/repl/interrupt", { replId });
  }

  /** End REPL. */
  async closeRepl(replId: number): Promise<void> {
    await this.request("ide/repl/close", { replId });
  }

  /** Fetch frames START to END, or to the bottom, of a debugger thread. */
  async debugBacktrace(
    threadId: number,
    start: number,
    end?: number,
  ): Promise<Frame[]> {
    const reply = await this.request<{ frames: unknown }>(
      "ide/debug/backtrace",
      { threadId, start, end },
    );
    return parseFrames(reply.frames);
  }

  /** Fetch the locals, package and source location of a frame. */
  async debugFrame(threadId: number, frame: number): Promise<FrameDetails> {
    return parseFrameDetails(
      await this.request("ide/debug/frame", { threadId, frame }),
    );
  }

  /** Invoke restart INDEX of LEVEL; the debugger events say what follows. */
  async debugRestart(
    threadId: number,
    level: number,
    index: number,
  ): Promise<void> {
    await this.request("ide/debug/restart", {
      threadId,
      level,
      index,
    });
  }

  /** Return to the previous debugger level. */
  async debugAbort(threadId: number): Promise<void> {
    await this.request("ide/debug/abort", { threadId });
  }

  /** Abandon the evaluation, whatever the level. */
  async debugQuit(threadId: number): Promise<void> {
    await this.request("ide/debug/quit", { threadId });
  }

  /** Use the continue restart. */
  async debugContinue(threadId: number): Promise<void> {
    await this.request("ide/debug/continue", { threadId });
  }

  /** Evaluate CODE in a frame; PPRINT asks for pretty-printed values. */
  async debugEval(
    threadId: number,
    frame: number,
    code: string,
    packageName?: string,
    pprint = false,
  ): Promise<{ ok: boolean; text: string }> {
    return this.request("ide/debug/eval", {
      threadId,
      frame,
      code,
      package: packageName,
      pprint,
    });
  }

  /** Step into, over (next) or out of a frame. */
  async debugStep(
    threadId: number,
    frame: number,
    kind: "into" | "next" | "out",
  ): Promise<void> {
    await this.request("ide/debug/step", { threadId, frame, kind });
  }

  /** Return the value of CODE from a frame. */
  async debugReturnFrom(
    threadId: number,
    frame: number,
    code: string,
  ): Promise<void> {
    await this.request("ide/debug/returnFrom", {
      threadId,
      frame,
      code,
    });
  }

  /** Run a frame again from its start. */
  async debugRestartFrame(threadId: number, frame: number): Promise<void> {
    await this.request("ide/debug/restartFrame", { threadId, frame });
  }

  /** Toggle *break-on-signals*, and say what it is now. */
  async breakOnSignals(): Promise<string> {
    const reply = await this.request<{ message: string }>(
      "ide/debug/breakOnSignals",
    );
    return reply.message;
  }

  /** Inspect the value of CODE, in PACKAGE if given. */
  async inspectInit(
    code: string,
    packageName?: string,
  ): Promise<Inspected | undefined> {
    return parseInspected(
      await this.request("ide/inspect/init", {
        code,
        package: packageName,
      }),
    );
  }

  /** Inspect the value part INDEX of the object shown. */
  async inspectPart(index: number): Promise<Inspected | undefined> {
    return parseInspected(
      await this.request("ide/inspect/part", { index }),
    );
  }

  /** Go back to the previous object; undefined when there is none. */
  async inspectPop(): Promise<Inspected | undefined> {
    return parseInspected(await this.request("ide/inspect/pop"));
  }

  /** Go forward again after a pop; undefined when there is nothing. */
  async inspectNext(): Promise<Inspected | undefined> {
    return parseInspected(await this.request("ide/inspect/next"));
  }

  /** Fetch the object shown again. */
  async inspectReinspect(): Promise<Inspected | undefined> {
    return parseInspected(
      await this.request("ide/inspect/reinspect"),
    );
  }

  /** Print the object shown with more or less detail. */
  async inspectToggleVerbose(): Promise<Inspected | undefined> {
    return parseInspected(
      await this.request("ide/inspect/toggleVerbose"),
    );
  }

  /** Fetch parts FROM to TO of the object shown. */
  async inspectRange(from: number, to: number): Promise<Range> {
    return parseRange(
      await this.request("ide/inspect/range", { from, to }),
    );
  }

  /** Run action part INDEX; undefined when it asks for no refresh. */
  async inspectAction(index: number): Promise<Inspected | undefined> {
    return parseInspected(
      await this.request("ide/inspect/action", { index }),
    );
  }

  /** Evaluate CODE with * bound to the object shown. */
  async inspectEval(code: string): Promise<string> {
    const reply = await this.request<{ text: string }>(
      "ide/inspect/eval",
      { code },
    );
    return reply.text;
  }

  /** Describe the object shown, or its part INDEX. */
  async inspectDescribe(index?: number): Promise<string> {
    const reply = await this.request<{ text: string }>(
      "ide/inspect/describe",
      { index },
    );
    return reply.text;
  }

  /** Inspect the value of CODE in a frame of a debugger thread. */
  async inspectFrame(
    threadId: number,
    frame: number,
    code: string,
  ): Promise<Inspected | undefined> {
    return parseInspected(
      await this.request("ide/inspect/frame", {
        threadId,
        frame,
        code,
      }),
    );
  }

  /** Inspect local variable VAR, its place in the locals, of a frame. */
  async inspectFrameVar(
    threadId: number,
    frame: number,
    variable: number,
  ): Promise<Inspected | undefined> {
    return parseInspected(
      await this.request("ide/inspect/frameVar", {
        threadId,
        frame,
        var: variable,
      }),
    );
  }

  /** Inspect the condition a debugger thread is handling. */
  async inspectCondition(threadId: number): Promise<Inspected | undefined> {
    return parseInspected(
      await this.request("ide/inspect/condition", { threadId }),
    );
  }

  /**
   * Inspect value VALUE of history entry ENTRY of REPL, as shown in its
   * transcript.
   */
  async inspectReplValue(
    replId: number,
    entry: number,
    value: number,
  ): Promise<Inspected | undefined> {
    return parseInspected(
      await this.request("ide/inspect/replValue", {
        replId,
        entry,
        value,
      }),
    );
  }

  /**
   * Return the symbols that PREFIX completes to, read in PACKAGE if
   * given, at most LIMIT of them. Nothing when not connected: asking
   * must not start a Lisp as a side effect of typing.
   */
  async complete(
    prefix: string,
    packageName?: string,
    limit?: number,
  ): Promise<Completion[]> {
    return parseCompletions(
      await this.request("ide/complete", {
        prefix,
        package: packageName,
        limit,
      }),
    );
  }

  /** Return the lambda list of NAME, printed, or undefined. */
  async arglist(
    name: string,
    packageName?: string,
  ): Promise<string | undefined> {
    const reply = await this.request<{ arglist: string | null }>(
      "ide/arglist",
      { name, package: packageName },
    );
    return reply.arglist ?? undefined;
  }

  /** Return the documentation of NAME, or undefined when it has none. */
  async documentation(
    name: string,
    packageName?: string,
  ): Promise<string | undefined> {
    const reply = await this.request<{ text: string | null }>(
      "ide/documentation",
      { name, package: packageName },
    );
    return reply.text ?? undefined;
  }

  /**
   * Return where NAME is defined, in what the image has loaded. Nothing
   * when not connected.
   */
  async definitions(
    name: string,
    packageName?: string,
  ): Promise<Definition[]> {
    return parseDefinitions(
      await this.request("ide/definitions", {
        name,
        package: packageName,
      }),
    );
  }

  /**
   * Return where NAME is called, referred to or macroexpanded, in what
   * the image has loaded. Nothing when not connected.
   */
  async xref(
    name: string,
    packageName?: string,
    kinds?: string[],
  ): Promise<Reference[]> {
    return parseReferences(
      await this.request("ide/xref", {
        name,
        package: packageName,
        kinds,
      }),
    );
  }

  /**
   * Make PACKAGENAME the package of REPL, as SLY's C-c ~ does. The new
   * prompt arrives as a replPrompt event.
   */
  async syncReplPackage(replId: number, packageName: string): Promise<void> {
    await this.request("ide/repl/syncPackage", {
      replId,
      package: packageName,
    });
  }

  /**
   * Compile and load CODE, which starts at the character offset
   * POSITION of FILE, or of an unsaved buffer when there is no FILE.
   * An error in loading it enters the debugger, and the promise
   * resolves when the debugger is left.
   */
  async compile(
    code: string,
    position: number,
    file?: string,
    packageName?: string,
  ): Promise<CompileResult> {
    return parseCompileResult(
      await this.request("ide/compile", {
        code,
        position,
        file,
        package: packageName,
      }),
    );
  }

  /** Compile FILE, and load it when LOAD is true. */
  async compileFile(file: string, load: boolean): Promise<CompileResult> {
    return parseCompileResult(
      await this.request("ide/compileFile", { file, load }),
    );
  }

  /**
   * Compile CODE, in which the forms of the stickers NEW are wrapped,
   * as ide/compile does; ORIGINAL is the code unwrapped, the fallback.
   * DEAD stickers are forgotten along the way.
   */
  async compileStickered(
    code: string,
    original: string | undefined,
    position: number,
    file: string | undefined,
    packageName: string | undefined,
    stickers: number[],
    dead: number[],
  ): Promise<StickerCompile> {
    return parseStickerCompile(
      await this.request("ide/stickers/compile", {
        code,
        original,
        position,
        file,
        package: packageName,
        stickers,
        dead,
      }),
    );
  }

  /** Forget the stickers IDS. */
  async killStickers(ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    await this.request("ide/stickers/kill", { ids });
  }

  /** Describe every sticker the image knows; DEAD are forgotten. */
  async fetchStickers(dead: number[]): Promise<StickerInfo[]> {
    return parseStickers(
      await this.request("ide/stickers/fetch", { dead }),
    );
  }

  /** Move the playhead by SEARCH; DEAD stickers are forgotten. */
  async searchRecordings(
    search: Search,
    dead: number[],
  ): Promise<Playhead | { error: string }> {
    return parsePlayhead(
      await this.request("ide/stickers/search", {
        ...search,
        key: 1,
        dead,
      }),
    );
  }

  /** Forget the recordings, or the first HOWMANY; return what is left. */
  async forgetRecordings(dead: number[], howMany?: number): Promise<number> {
    const reply = await this.request<{ remaining: number }>(
      "ide/stickers/forget",
      { dead, howMany },
    );
    return reply.remaining;
  }

  /** Switch breaking on every sticker; return whether it is on now. */
  async toggleBreakOnStickers(): Promise<boolean> {
    const reply = await this.request<{ on: boolean }>(
      "ide/stickers/toggleBreak",
    );
    return reply.on === true;
  }

  /** Inspect the sticker ID, or the recording RECORDING's VALUE. */
  async inspectSticker(
    target: { sticker: number } | { recording: number; value?: number },
  ): Promise<Inspected | undefined> {
    return parseInspected(
      await this.request("ide/stickers/inspect", target),
    );
  }
}

/** A connection and, when VSCLIDE started its Lisp, the process. */
interface Entry {
  connection: Connection;
  slynk?: LispProcess;
}

/**
 * The IDE's controller: it has clide, one process for all of them, hold
 * several connections to slynk servers, those it starts itself and those
 * it attaches to, and keeps one of them active. The editor's requests
 * (evaluation, completion, definitions, compiling) go to the active
 * connection; the REPLs, the debugger and the inspector name theirs.
 * Everything that changes is reported as an IdeEvent. It knows nothing
 * of VS Code.
 */
export class Ide {
  private readonly entries = new Map<number, Entry>();
  private activeId: number | undefined;
  private spawning: Promise<Connection> | undefined;
  private readonly listeners = new Set<(event: IdeEvent) => void>();

  /**
   * SESSION runs clide. SLYNK is called each time a slynk server has
   * to be started.
   */
  constructor(
    private readonly session: Session,
    private readonly slynkLaunch: () => LaunchOptions | Promise<LaunchOptions>,
  ) {
    session.onNotification((method, params) =>
      this.onNotification(method, params),
    );
    session.onExit(() => this.dropAll("clide exited"));
  }

  /** The open connections, by id. */
  get connections(): Connection[] {
    return [...this.entries.values()]
      .map((entry) => entry.connection)
      .sort((a, b) => a.id - b.id);
  }

  /** The connection the editor's requests go to, or undefined. */
  get active(): Connection | undefined {
    return this.activeId === undefined
      ? undefined
      : this.entries.get(this.activeId)?.connection;
  }

  /** What slynk reported of the active connection, or undefined. */
  get connection(): ConnectionInfo | undefined {
    return this.active?.info;
  }

  /** True while there is an active connection. */
  get connected(): boolean {
    return this.active !== undefined;
  }

  /** The connection with ID, or undefined once it has gone. */
  get(id: number): Connection | undefined {
    return this.entries.get(id)?.connection;
  }

  /** Make the connection ID the active one. */
  setActive(id: number): void {
    if (!this.entries.has(id) || id === this.activeId) return;
    this.activeId = id;
    this.emit({ type: "active", connectionId: id });
  }

  /** Call LISTENER for each event; returns a function that stops it. */
  onEvent(listener: (event: IdeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Return the active connection. With none, start the Lisp and connect
   * to it, as the first use of the IDE does.
   */
  connect(): Promise<Connection> {
    return this.active ? Promise.resolve(this.active) : this.start();
  }

  /**
   * Return the connection to the Lisp VSCLIDE owns, starting the Lisp
   * when it is not running, whatever else is connected. It becomes the
   * active connection only when there is none.
   */
  start(): Promise<Connection> {
    const spawned = this.connections.find((c) => c.origin === "spawned");
    if (spawned) return Promise.resolve(spawned);
    this.spawning ??= this.spawn().finally(() => {
      this.spawning = undefined;
    });
    return this.spawning;
  }

  /**
   * Connect to a slynk server that is already running, as SLY's
   * sly-connect does. The connection is called NAME, or HOST:PORT. A
   * server already attached is returned as it is. It becomes the active
   * connection only when there is none; VSCLIDE never stops that server.
   */
  async attach(
    host: string,
    port: number,
    name?: string,
  ): Promise<Connection> {
    const known = this.connections.find(
      (connection) =>
        connection.origin === "attached" &&
        connection.host === host &&
        connection.port === port,
    );
    if (known) return known;
    await this.session.ensure();
    return this.open(host, port, "attached", name);
  }

  /**
   * End the connection ID. The Lisp VSCLIDE started is stopped with
   * it; a server it attached to is left running.
   */
  async disconnect(id: number): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    await this.session
      .request("ide/disconnect", { connectionId: id })
      .catch(() => undefined);
    this.drop(id, "disconnected", false);
    await entry.slynk?.stop();
  }

  /** End every connection. */
  async disconnectAll(): Promise<void> {
    await Promise.all(this.connections.map((c) => this.disconnect(c.id)));
  }

  /** Disconnect, then stop slynk and clide. */
  async stop(): Promise<void> {
    await this.disconnectAll();
    await this.session.stop();
  }

  private async requireActive(): Promise<Connection> {
    const active = this.active;
    if (!active) throw new Error("Not connected to slynk.");
    return active;
  }

  /**
   * Run evaluate on the active connection, starting the Lisp
   * if none.
   */
  async evaluate(
    ...args: Parameters<Connection["evaluate"]>
  ): ReturnType<Connection["evaluate"]> {
    return (await this.connect()).evaluate(...args);
  }

  /**
   * Run sylvesters on the active connection, starting the Lisp
   * if none.
   */
  async sylvesters(
    ...args: Parameters<Connection["sylvesters"]>
  ): ReturnType<Connection["sylvesters"]> {
    return (await this.connect()).sylvesters(...args);
  }

  /**
   * Run breakOnSignals on the active connection, starting the Lisp
   * if none.
   */
  async breakOnSignals(
    ...args: Parameters<Connection["breakOnSignals"]>
  ): ReturnType<Connection["breakOnSignals"]> {
    return (await this.connect()).breakOnSignals(...args);
  }

  /**
   * Run compile on the active connection, starting the Lisp
   * if none.
   */
  async compile(
    ...args: Parameters<Connection["compile"]>
  ): ReturnType<Connection["compile"]> {
    return (await this.connect()).compile(...args);
  }

  /**
   * Run compileFile on the active connection, starting the Lisp
   * if none.
   */
  async compileFile(
    ...args: Parameters<Connection["compileFile"]>
  ): ReturnType<Connection["compileFile"]> {
    return (await this.connect()).compileFile(...args);
  }

  /**
   * Run compileStickered on the active connection, starting the Lisp
   * if none.
   */
  async compileStickered(
    ...args: Parameters<Connection["compileStickered"]>
  ): ReturnType<Connection["compileStickered"]> {
    return (await this.connect()).compileStickered(...args);
  }

  /**
   * Run fetchStickers on the active connection, starting the Lisp
   * if none.
   */
  async fetchStickers(
    ...args: Parameters<Connection["fetchStickers"]>
  ): ReturnType<Connection["fetchStickers"]> {
    return (await this.connect()).fetchStickers(...args);
  }

  /**
   * Run searchRecordings on the active connection, starting the Lisp
   * if none.
   */
  async searchRecordings(
    ...args: Parameters<Connection["searchRecordings"]>
  ): ReturnType<Connection["searchRecordings"]> {
    return (await this.connect()).searchRecordings(...args);
  }

  /**
   * Run forgetRecordings on the active connection, starting the Lisp
   * if none.
   */
  async forgetRecordings(
    ...args: Parameters<Connection["forgetRecordings"]>
  ): ReturnType<Connection["forgetRecordings"]> {
    return (await this.connect()).forgetRecordings(...args);
  }

  /**
   * Run toggleBreakOnStickers on the active connection, starting the Lisp
   * if none.
   */
  async toggleBreakOnStickers(
    ...args: Parameters<Connection["toggleBreakOnStickers"]>
  ): ReturnType<Connection["toggleBreakOnStickers"]> {
    return (await this.connect()).toggleBreakOnStickers(...args);
  }

  /**
   * Run inspectSticker on the active connection, starting the Lisp
   * if none.
   */
  async inspectSticker(
    ...args: Parameters<Connection["inspectSticker"]>
  ): ReturnType<Connection["inspectSticker"]> {
    return (await this.connect()).inspectSticker(...args);
  }

  /**
   * Run complete on the active connection; with none, nothing is
   * done and no Lisp is started.
   */
  async complete(
    ...args: Parameters<Connection["complete"]>
  ): ReturnType<Connection["complete"]> {
    const active = this.active;
    return (active ? active.complete(...args) : []) as Awaited<
      ReturnType<Connection["complete"]>
    >;
  }

  /**
   * Run arglist on the active connection; with none, nothing is
   * done and no Lisp is started.
   */
  async arglist(
    ...args: Parameters<Connection["arglist"]>
  ): ReturnType<Connection["arglist"]> {
    const active = this.active;
    return (active ? active.arglist(...args) : undefined) as Awaited<
      ReturnType<Connection["arglist"]>
    >;
  }

  /**
   * Run documentation on the active connection; with none, nothing is
   * done and no Lisp is started.
   */
  async documentation(
    ...args: Parameters<Connection["documentation"]>
  ): ReturnType<Connection["documentation"]> {
    const active = this.active;
    return (active ? active.documentation(...args) : undefined) as Awaited<
      ReturnType<Connection["documentation"]>
    >;
  }

  /**
   * Run definitions on the active connection; with none, nothing is
   * done and no Lisp is started.
   */
  async definitions(
    ...args: Parameters<Connection["definitions"]>
  ): ReturnType<Connection["definitions"]> {
    const active = this.active;
    return (active ? active.definitions(...args) : []) as Awaited<
      ReturnType<Connection["definitions"]>
    >;
  }

  /**
   * Run xref on the active connection; with none, nothing is
   * done and no Lisp is started.
   */
  async xref(
    ...args: Parameters<Connection["xref"]>
  ): ReturnType<Connection["xref"]> {
    const active = this.active;
    return (active ? active.xref(...args) : []) as Awaited<
      ReturnType<Connection["xref"]>
    >;
  }

  /**
   * Run killStickers on the active connection; with none, nothing is
   * done and no Lisp is started.
   */
  async killStickers(
    ...args: Parameters<Connection["killStickers"]>
  ): ReturnType<Connection["killStickers"]> {
    const active = this.active;
    return (active ? active.killStickers(...args) : undefined) as Awaited<
      ReturnType<Connection["killStickers"]>
    >;
  }

  private async spawn(): Promise<Connection> {
    await this.session.ensure();
    const slynk = await this.startSlynkProcess();
    try {
      return await this.open(
        "127.0.0.1",
        slynk.port,
        "spawned",
        undefined,
        slynk,
      );
    } catch (error) {
      await slynk.stop();
      throw error;
    }
  }

  private async open(
    host: string,
    port: number,
    origin: Origin,
    name?: string,
    slynk?: LispProcess,
  ): Promise<Connection> {
    const info = await this.session.request<
      ConnectionInfo & { connectionId: number }
    >("ide/connect", { host, port, name });
    const label =
      name ??
      (origin === "spawned"
        ? `${info.implementation.name ?? "lisp"} (Inferior)`
        : `${host}:${port}`);
    const connection = new Connection(
      info.connectionId,
      label,
      origin,
      host,
      port,
      info,
      (method, params) => this.session.request(method, params),
    );
    this.entries.set(connection.id, { connection, slynk });
    this.emit({ type: "connected", connectionId: connection.id, info });
    if (this.activeId === undefined) {
      this.activeId = connection.id;
      this.emit({ type: "active", connectionId: connection.id });
    }
    return connection;
  }

  private async startSlynkProcess(): Promise<LispProcess> {
    const slynk = await startSlynk(await this.slynkLaunch());
    void slynk.exited.then(() => {
      for (const [id, entry] of this.entries) {
        if (entry.slynk === slynk) {
          this.drop(id, "slynk exited", false);
          return;
        }
      }
    });
    return slynk;
  }

  private onNotification(method: string, params: unknown): void {
    if (method === "ide/disconnected") {
      const p = (params ?? {}) as Params;
      this.drop(num(p.connectionId), text(p.reason) || "connection closed");
      return;
    }
    const event = parseNotification(method, params);
    if (event) this.emit(event);
  }

  private dropAll(reason: string): void {
    for (const id of [...this.entries.keys()]) this.drop(id, reason);
  }

  /**
   * Forget the connection ID and report REASON. The slynk process, if
   * VSCLIDE started it and it still runs, is stopped unless STOP is
   * false. When ID was the active connection, the next one is.
   */
  private drop(id: number, reason: string, stop = true): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    if (stop && entry.slynk) void entry.slynk.stop();
    this.emit({ type: "disconnected", connectionId: id, reason });
    if (this.activeId === id) {
      this.activeId = this.connections[0]?.id;
      this.emit({ type: "active", connectionId: this.activeId });
    }
  }

  private emit(event: IdeEvent): void {
    this.listeners.forEach((listener) => listener(event));
  }
}
