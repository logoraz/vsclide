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

/** Something that happened that the user interface may show. */
export type IdeEvent =
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
  | { type: "indentation"; rules: LiveRule[] };

type Params = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

/**
 * Turn a notification from clide into an event, or undefined when it
 * is not one the interface knows. ide/disconnected is handled by the
 * controller itself, as it also changes its state.
 */
export function parseNotification(
  method: string,
  params: unknown,
): IdeEvent | undefined {
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
 * The IDE's controller: starts the slynk server, has clide connect to
 * it, and offers evaluation and REPLs. Everything that changes is
 * reported as an IdeEvent. It knows nothing of VS Code.
 */
export class Ide {
  private slynk: LispProcess | undefined;
  private info: ConnectionInfo | undefined;
  private connecting: Promise<ConnectionInfo> | undefined;
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
    session.onExit(() => this.drop("clide exited"));
  }

  /** What slynk reported when connected, or undefined. */
  get connection(): ConnectionInfo | undefined {
    return this.info;
  }

  /** Call LISTENER for each event; returns a function that stops it. */
  onEvent(listener: (event: IdeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Start the Lisp and connect to it, if not already. Resolves with
   * what slynk reports about itself.
   */
  connect(): Promise<ConnectionInfo> {
    if (this.info) return Promise.resolve(this.info);
    this.connecting ??= this.open().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  /** Disconnect and stop the Lisp. */
  async disconnect(): Promise<void> {
    const slynk = this.slynk;
    this.slynk = undefined;
    if (this.info) {
      await this.session.request("ide/disconnect").catch(() => undefined);
      this.drop("disconnected", false);
    }
    await slynk?.stop();
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
    await this.connect();
    return this.session.request<EvalResult>("ide/eval", {
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
    await this.connect();
    const reply = await this.session.request<{ text: string | null }>(
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
    const reply = await this.session.request<{ loaded: boolean }>(
      "ide/indentation",
    );
    return reply.loaded === true;
  }

  /** Open a REPL and resolve with its id. */
  async createRepl(): Promise<number> {
    await this.connect();
    const reply = await this.session.request<{ replId: number }>(
      "ide/repl/create",
    );
    return reply.replId;
  }

  /** Give REPL one line, or several, of input. */
  async sendToRepl(replId: number, input: string): Promise<void> {
    await this.session.request("ide/repl/send", { replId, text: input });
  }

  /** Interrupt what REPL is evaluating. */
  async interruptRepl(replId: number): Promise<void> {
    await this.session.request("ide/repl/interrupt", { replId });
  }

  /** End REPL. */
  async closeRepl(replId: number): Promise<void> {
    await this.session.request("ide/repl/close", { replId });
  }

  /** Fetch frames START to END, or to the bottom, of a debugger thread. */
  async debugBacktrace(
    threadId: number,
    start: number,
    end?: number,
  ): Promise<Frame[]> {
    const reply = await this.session.request<{ frames: unknown }>(
      "ide/debug/backtrace",
      { threadId, start, end },
    );
    return parseFrames(reply.frames);
  }

  /** Fetch the locals, package and source location of a frame. */
  async debugFrame(threadId: number, frame: number): Promise<FrameDetails> {
    return parseFrameDetails(
      await this.session.request("ide/debug/frame", { threadId, frame }),
    );
  }

  /** Invoke restart INDEX of LEVEL; the debugger events say what follows. */
  async debugRestart(
    threadId: number,
    level: number,
    index: number,
  ): Promise<void> {
    await this.session.request("ide/debug/restart", {
      threadId,
      level,
      index,
    });
  }

  /** Return to the previous debugger level. */
  async debugAbort(threadId: number): Promise<void> {
    await this.session.request("ide/debug/abort", { threadId });
  }

  /** Abandon the evaluation, whatever the level. */
  async debugQuit(threadId: number): Promise<void> {
    await this.session.request("ide/debug/quit", { threadId });
  }

  /** Use the continue restart. */
  async debugContinue(threadId: number): Promise<void> {
    await this.session.request("ide/debug/continue", { threadId });
  }

  /** Evaluate CODE in a frame; PPRINT asks for pretty-printed values. */
  async debugEval(
    threadId: number,
    frame: number,
    code: string,
    packageName?: string,
    pprint = false,
  ): Promise<{ ok: boolean; text: string }> {
    return this.session.request("ide/debug/eval", {
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
    await this.session.request("ide/debug/step", { threadId, frame, kind });
  }

  /** Return the value of CODE from a frame. */
  async debugReturnFrom(
    threadId: number,
    frame: number,
    code: string,
  ): Promise<void> {
    await this.session.request("ide/debug/returnFrom", {
      threadId,
      frame,
      code,
    });
  }

  /** Run a frame again from its start. */
  async debugRestartFrame(threadId: number, frame: number): Promise<void> {
    await this.session.request("ide/debug/restartFrame", { threadId, frame });
  }

  /** Toggle *break-on-signals*, and say what it is now. */
  async breakOnSignals(): Promise<string> {
    await this.connect();
    const reply = await this.session.request<{ message: string }>(
      "ide/debug/breakOnSignals",
    );
    return reply.message;
  }

  /** Inspect the value of CODE, in PACKAGE if given. */
  async inspectInit(
    code: string,
    packageName?: string,
  ): Promise<Inspected | undefined> {
    await this.connect();
    return parseInspected(
      await this.session.request("ide/inspect/init", {
        code,
        package: packageName,
      }),
    );
  }

  /** Inspect the value part INDEX of the object shown. */
  async inspectPart(index: number): Promise<Inspected | undefined> {
    return parseInspected(
      await this.session.request("ide/inspect/part", { index }),
    );
  }

  /** Go back to the previous object; undefined when there is none. */
  async inspectPop(): Promise<Inspected | undefined> {
    return parseInspected(await this.session.request("ide/inspect/pop"));
  }

  /** Go forward again after a pop; undefined when there is nothing. */
  async inspectNext(): Promise<Inspected | undefined> {
    return parseInspected(await this.session.request("ide/inspect/next"));
  }

  /** Fetch the object shown again. */
  async inspectReinspect(): Promise<Inspected | undefined> {
    return parseInspected(
      await this.session.request("ide/inspect/reinspect"),
    );
  }

  /** Print the object shown with more or less detail. */
  async inspectToggleVerbose(): Promise<Inspected | undefined> {
    return parseInspected(
      await this.session.request("ide/inspect/toggleVerbose"),
    );
  }

  /** Fetch parts FROM to TO of the object shown. */
  async inspectRange(from: number, to: number): Promise<Range> {
    return parseRange(
      await this.session.request("ide/inspect/range", { from, to }),
    );
  }

  /** Run action part INDEX; undefined when it asks for no refresh. */
  async inspectAction(index: number): Promise<Inspected | undefined> {
    return parseInspected(
      await this.session.request("ide/inspect/action", { index }),
    );
  }

  /** Evaluate CODE with * bound to the object shown. */
  async inspectEval(code: string): Promise<string> {
    const reply = await this.session.request<{ text: string }>(
      "ide/inspect/eval",
      { code },
    );
    return reply.text;
  }

  /** Describe the object shown, or its part INDEX. */
  async inspectDescribe(index?: number): Promise<string> {
    const reply = await this.session.request<{ text: string }>(
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
      await this.session.request("ide/inspect/frame", {
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
      await this.session.request("ide/inspect/frameVar", {
        threadId,
        frame,
        var: variable,
      }),
    );
  }

  /** Inspect the condition a debugger thread is handling. */
  async inspectCondition(threadId: number): Promise<Inspected | undefined> {
    return parseInspected(
      await this.session.request("ide/inspect/condition", { threadId }),
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
      await this.session.request("ide/inspect/replValue", {
        replId,
        entry,
        value,
      }),
    );
  }

  /** True while connected to slynk. */
  get connected(): boolean {
    return this.info !== undefined;
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
    if (!this.info) return [];
    return parseCompletions(
      await this.session.request("ide/complete", {
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
    if (!this.info) return undefined;
    const reply = await this.session.request<{ arglist: string | null }>(
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
    if (!this.info) return undefined;
    const reply = await this.session.request<{ text: string | null }>(
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
    if (!this.info) return [];
    return parseDefinitions(
      await this.session.request("ide/definitions", {
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
    if (!this.info) return [];
    return parseReferences(
      await this.session.request("ide/xref", {
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
    await this.session.request("ide/repl/syncPackage", {
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
    await this.connect();
    return parseCompileResult(
      await this.session.request("ide/compile", {
        code,
        position,
        file,
        package: packageName,
      }),
    );
  }

  /** Compile FILE, and load it when LOAD is true. */
  async compileFile(file: string, load: boolean): Promise<CompileResult> {
    await this.connect();
    return parseCompileResult(
      await this.session.request("ide/compileFile", { file, load }),
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
    await this.connect();
    return parseStickerCompile(
      await this.session.request("ide/stickers/compile", {
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
    if (!this.info || ids.length === 0) return;
    await this.session.request("ide/stickers/kill", { ids });
  }

  /** Describe every sticker the image knows; DEAD are forgotten. */
  async fetchStickers(dead: number[]): Promise<StickerInfo[]> {
    await this.connect();
    return parseStickers(
      await this.session.request("ide/stickers/fetch", { dead }),
    );
  }

  /** Move the playhead by SEARCH; DEAD stickers are forgotten. */
  async searchRecordings(
    search: Search,
    dead: number[],
  ): Promise<Playhead | { error: string }> {
    await this.connect();
    return parsePlayhead(
      await this.session.request("ide/stickers/search", {
        ...search,
        key: 1,
        dead,
      }),
    );
  }

  /** Forget the recordings, or the first HOWMANY; return what is left. */
  async forgetRecordings(dead: number[], howMany?: number): Promise<number> {
    await this.connect();
    const reply = await this.session.request<{ remaining: number }>(
      "ide/stickers/forget",
      { dead, howMany },
    );
    return reply.remaining;
  }

  /** Switch breaking on every sticker; return whether it is on now. */
  async toggleBreakOnStickers(): Promise<boolean> {
    await this.connect();
    const reply = await this.session.request<{ on: boolean }>(
      "ide/stickers/toggleBreak",
    );
    return reply.on === true;
  }

  /** Inspect the sticker ID, or the recording RECORDING's VALUE. */
  async inspectSticker(
    target: { sticker: number } | { recording: number; value?: number },
  ): Promise<Inspected | undefined> {
    await this.connect();
    return parseInspected(
      await this.session.request("ide/stickers/inspect", target),
    );
  }

  /** Disconnect, then stop slynk and clide. */
  async stop(): Promise<void> {
    await this.disconnect();
    await this.session.stop();
  }

  private async open(): Promise<ConnectionInfo> {
    await this.session.ensure();
    const slynk = this.slynk ?? (await this.startSlynkProcess());
    try {
      const info = await this.session.request<ConnectionInfo>("ide/connect", {
        port: slynk.port,
      });
      this.info = info;
      this.emit({ type: "connected", info });
      return info;
    } catch (error) {
      this.slynk = undefined;
      await slynk.stop();
      throw error;
    }
  }

  private async startSlynkProcess(): Promise<LispProcess> {
    const slynk = await startSlynk(await this.slynkLaunch());
    this.slynk = slynk;
    void slynk.exited.then(() => {
      if (this.slynk === slynk) {
        this.slynk = undefined;
        this.drop("slynk exited");
      }
    });
    return slynk;
  }

  private onNotification(method: string, params: unknown): void {
    if (method === "ide/disconnected") {
      const reason = text((params as Params | undefined)?.reason);
      this.drop(reason || "connection closed");
      return;
    }
    const event = parseNotification(method, params);
    if (event) this.emit(event);
  }

  /**
   * Forget the connection and report REASON. The slynk process, if
   * still running, is stopped unless STOP is false.
   */
  private drop(reason: string, stop = true): void {
    const had = this.info !== undefined;
    this.info = undefined;
    if (stop && this.slynk) {
      const slynk = this.slynk;
      this.slynk = undefined;
      void slynk.stop();
    }
    if (had) this.emit({ type: "disconnected", reason });
  }

  private emit(event: IdeEvent): void {
    this.listeners.forEach((listener) => listener(event));
  }
}
