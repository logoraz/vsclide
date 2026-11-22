import { DebugLevel, DebugModel } from "./debugger";
import { Inspected, InspectorModel } from "./inspector";

/** The tabs of the panel. */
export type Tab = "debugger" | "inspector";

/** Text the user asked for about the inspected object, shown below it. */
export interface InspectOutput {
  label: string;
  text: string;
}

/** What the user interface keeps besides the two models. */
export interface PanelUi {
  tab: Tab;
  output: InspectOutput | undefined;
  /** A passing message, such as what break-on-signals is now. */
  notice: string | undefined;
}

/** What the page lists of a connection, in its grouped list. */
export interface ConnectionSummary {
  id: number;
  name: string;
  /** How many debugger levels are open on it. */
  levels: number;
  /** Whether an object is being inspected on it. */
  inspecting: boolean;
}

/** Everything the page needs to draw itself. */
export interface PanelState {
  /** The connections, grouped in the page's list; one hides the list. */
  connections: ConnectionSummary[];
  /** The connection whose debugger and inspector the page shows. */
  viewing: number | undefined;
  tab: Tab;
  notice: string | undefined;
  debug: {
    levels: DebugLevel[];
    /** The thread and level the user is working in, if any. */
    current: { threadId: number; level: number } | undefined;
  };
  inspect: {
    inspected: Inspected | undefined;
    canGoBack: boolean;
    canGoForward: boolean;
    output: InspectOutput | undefined;
  };
}

/** Return the state of the panel from its parts. */
export function panelState(
  debug: DebugModel,
  inspector: InspectorModel,
  ui: PanelUi,
  connections: ConnectionSummary[] = [],
  viewing?: number,
): PanelState {
  const current = debug.current;
  return {
    connections,
    viewing,
    tab: ui.tab,
    notice: ui.notice,
    debug: {
      levels: [...debug.all],
      current: current && {
        threadId: current.threadId,
        level: current.level,
      },
    },
    inspect: {
      inspected: inspector.current,
      canGoBack: inspector.canGoBack,
      canGoForward: inspector.canGoForward,
      output: ui.output,
    },
  };
}

/** Messages the page sends to the extension. */
export type PanelMessage =
  | { type: "ready" }
  | { type: "tab"; tab: Tab }
  | { type: "view"; connectionId: number; tab: Tab }
  | { type: "restart"; index: number }
  | { type: "abort" }
  | { type: "quit" }
  | { type: "continue" }
  | { type: "step"; kind: "into" | "next" | "out" }
  | { type: "selectFrame"; index: number }
  | { type: "moreFrames" }
  | { type: "openSource"; index: number }
  | { type: "evalInFrame"; code: string; pprint: boolean }
  | { type: "returnFrom"; code: string }
  | { type: "restartFrame" }
  | { type: "inspectLocal"; variable: number }
  | { type: "inspectInFrame"; code: string }
  | { type: "inspectCondition" }
  | { type: "switchLevel"; threadId: number; level: number }
  | { type: "breakOnSignals" }
  | { type: "inspect"; code: string }
  | { type: "part"; index: number }
  | { type: "back" }
  | { type: "forward" }
  | { type: "reinspect" }
  | { type: "verbose" }
  | { type: "action"; index: number }
  | { type: "morePartsOfObject" }
  | { type: "inspectEval"; code: string }
  | { type: "describe"; index?: number }
  | { type: "closeInspector" };
