/**
 * Script of the debugger and inspector panel. It draws the state the
 * extension sends and sends back what the user does. It has no
 * knowledge of Lisp or of slynk.
 */

import type { DebugLevel, FrameDetails } from "../base/debugger";
import type { Part } from "../base/inspector";
import type { PanelMessage, PanelState } from "../base/panel";

interface VsCodeApi {
  postMessage(message: PanelMessage): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

/** Return the element with ID, which the page is known to have. */
function element<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

/** Return a new element of TAG with CLASSES and TEXT. */
function make(tag: string, classes = "", text = ""): HTMLElement {
  const created = document.createElement(tag);
  if (classes) created.className = classes;
  if (text) created.textContent = text;
  return created;
}

/** Return a button with LABEL that sends MESSAGE when clicked. */
function button(
  label: string,
  message: PanelMessage,
  title = "",
  disabled = false,
): HTMLButtonElement {
  const created = make("button", "", label) as HTMLButtonElement;
  created.title = title;
  created.disabled = disabled;
  created.addEventListener("click", () => vscode.postMessage(message));
  return created;
}

/** Make INPUT send what it holds when Enter is pressed, then clear it. */
function onEnter(input: HTMLInputElement, send: (text: string) => void): void {
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    const value = input.value.trim();
    if (value === "") return;
    send(value);
    input.value = "";
  });
}


/// Debugger

/** The level of STATE that the user is working in, or undefined. */
function currentLevel(state: PanelState): DebugLevel | undefined {
  const current = state.debug.current;
  return state.debug.levels.find(
    (level) =>
      level.threadId === current?.threadId && level.level === current?.level,
  );
}

/** Draw the chips that switch between the open levels. */
function renderLevels(state: PanelState, current: DebugLevel): void {
  const levels = element("levels");
  levels.replaceChildren();
  if (state.debug.levels.length < 2) return;
  for (const level of state.debug.levels) {
    const chip = button(
      `Level ${level.level} (thread ${level.threadId})`,
      { type: "switchLevel", threadId: level.threadId, level: level.level },
      level.condition.message,
    );
    chip.classList.toggle("active", level === current);
    levels.appendChild(chip);
  }
}

/** Draw the condition and the toolbar. */
function renderHeader(level: DebugLevel): void {
  const message = element("condition-message");
  message.textContent = level.condition.headline ?? level.condition.message;
  message.title = level.condition.message;
  element("condition-type").textContent = level.condition.type;
  const frame = level.selected;
  const restartable = level.frames.find((f) => f.index === frame)?.restartable;
  const toolbar = element("toolbar");
  toolbar.replaceChildren(
    button("Continue", { type: "continue" }, "Use the continue restart"),
    button("Abort", { type: "abort" }, "Return to the previous level"),
    button("Quit", { type: "quit" }, "Abandon the evaluation"),
    button("Step into", { type: "step", kind: "into" }, "Step into the frame"),
    button("Step next", { type: "step", kind: "next" }, "Step over"),
    button("Step out", { type: "step", kind: "out" }, "Step out of the frame"),
    button(
      "Restart frame",
      { type: "restartFrame" },
      "Run the selected frame again",
      restartable === false,
    ),
    button(
      "Inspect condition",
      { type: "inspectCondition" },
      "Inspect the condition object",
    ),
    button(
      "Break on errors",
      { type: "breakOnSignals" },
      "Toggle *break-on-signals*",
    ),
  );
}

/** Draw the restarts, numbered as the keys 0 to 9 invoke them. */
function renderRestarts(level: DebugLevel): void {
  const list = element("restarts");
  list.replaceChildren();
  level.restarts.forEach((restart, index) => {
    const row = make("div", "row restart");
    row.appendChild(make("span", "number", `${index}:`));
    row.appendChild(make("span", "name", `[${restart.name}]`));
    row.appendChild(make("span", "", restart.description));
    row.addEventListener("click", () =>
      vscode.postMessage({ type: "restart", index }),
    );
    list.appendChild(row);
  });
}

/** Draw the backtrace, keeping the scroll position. */
function renderFrames(level: DebugLevel): void {
  const list = element("frames");
  const scroll = list.scrollTop;
  list.replaceChildren();
  for (const frame of level.frames) {
    const row = make("div", "row frame");
    row.classList.toggle("selected", frame.index === level.selected);
    row.appendChild(make("span", "number", `${frame.index}:`));
    row.appendChild(make("span", "text", frame.text));
    row.addEventListener("click", () =>
      vscode.postMessage({ type: "selectFrame", index: frame.index }),
    );
    row.addEventListener("dblclick", () =>
      vscode.postMessage({ type: "openSource", index: frame.index }),
    );
    list.appendChild(row);
  }
  list.scrollTop = scroll;
  document.querySelectorAll(".toggle").forEach((header) =>
  header.addEventListener("click", () =>
    header.parentElement?.classList.toggle("collapsed"),
  ),
);

/** The nearest open section from SASH, going in DIRECTION (-1 or 1). */
function openSection(sash: Element, direction: -1 | 1): HTMLElement | null {
  const next = (node: Element | null) =>
    direction < 0 ? node?.previousElementSibling : node?.nextElementSibling;
  let node = next(sash) ?? null;
  while (node) {
    if (
      node.classList.contains("block") &&
      !node.classList.contains("collapsed")
    ) {
      return node as HTMLElement;
    }
    node = next(node) ?? null;
  }
  return null;
}

/** Smallest height, in pixels, a section keeps while resizing. */
const MIN_SECTION = 48;

/** Dragging a sash moves the space between the open sections around it. */
document.querySelectorAll<HTMLElement>(".sash").forEach((sash) =>
  sash.addEventListener("mousedown", (down: MouseEvent) => {
    const above = openSection(sash, -1);
    const below = openSection(sash, 1);
    if (!above || !below) return;
    down.preventDefault();
    const open = Array.from(
      document.querySelectorAll<HTMLElement>("#sections > .block"),
    ).filter((block) => !block.classList.contains("collapsed"));
    // Weights become pixel heights, so that only the two sections move.
    open.forEach((block) => {
      block.style.flex = `${block.offsetHeight} 1 0px`;
    });
    const above0 = above.offsetHeight;
    const below0 = below.offsetHeight;
    const move = (event: MouseEvent) => {
      const delta = Math.max(
        MIN_SECTION - above0,
        Math.min(below0 - MIN_SECTION, event.clientY - down.clientY),
      );
      above.style.flex = `${above0 + delta} 1 0px`;
      below.style.flex = `${below0 - delta} 1 0px`;
    };
    const stop = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", stop);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", stop);
  }),
);

element("more-frames").style.display = level.moreFrames ? "block" : "none";
}

/** Draw the details of the selected frame: source, locals, catch tags. */
function renderDetails(level: DebugLevel): void {
  const details = element("details");
  details.replaceChildren();
  const known: FrameDetails | undefined = level.details[level.selected];
  const title = make("div", "section", `Frame ${level.selected}`);
  title.appendChild(
    button(
      "Open source",
      { type: "openSource", index: level.selected },
      "Show the source of the frame",
    ),
  );
  details.appendChild(title);
  if (!known) {
    details.appendChild(make("div", "muted", "Loading..."));
    return;
  }
  if (known.location?.error) {
    details.appendChild(make("div", "muted", known.location.error));
  }
  details.appendChild(
    make("div", "muted", known.package ? `Package ${known.package}` : ""),
  );
  if (known.locals.length === 0) {
    details.appendChild(make("div", "muted", "[No locals]"));
  }
  known.locals.forEach((local, index) => {
    const row = make("div", "row local");
    const id = local.id === 0 ? "" : `#${local.id}`;
    row.appendChild(make("span", "name", `${local.name}${id}`));
    row.appendChild(make("span", "value", local.value));
    row.appendChild(
      button(
        "Inspect",
        { type: "inspectLocal", variable: index },
        "Inspect this value",
      ),
    );
    details.appendChild(row);
  });
  if (known.catchTags.length > 0) {
    details.appendChild(make("div", "section", "Catch tags"));
    for (const tag of known.catchTags) {
      details.appendChild(make("div", "row", tag));
    }
  }
}

/** Draw what was evaluated in frames of the level. */
function renderEvals(level: DebugLevel): void {
  const log = element("evals");
  log.replaceChildren();
  for (const entry of level.evals) {
    const block = make("div", "eval");
    block.appendChild(make("div", "code", `${entry.frame}> ${entry.code}`));
    block.appendChild(
      make("div", entry.ok ? "result" : "result error", entry.text),
    );
    log.appendChild(block);
  }
  log.scrollTop = log.scrollHeight;
}

/** Draw the debugger tab. */
function renderDebugger(state: PanelState): void {
  const level = currentLevel(state);
  element("debugger-empty").style.display = level ? "none" : "block";
  element("debugger-body").style.display = level ? "flex" : "none";
  if (!level) return;
  renderLevels(state, level);
  renderHeader(level);
  renderRestarts(level);
  renderFrames(level);
  renderDetails(level);
  renderEvals(level);
}


/// Inspector

/** Return the node that draws PART. */
function partNode(part: Part): Node {
  switch (part.kind) {
    case "value": {
      const link = make("a", "value", part.text);
      link.tabIndex = 0;
      link.addEventListener("click", () =>
        vscode.postMessage({ type: "part", index: part.index }),
      );
      return link;
    }
    case "action": {
      const action = make("a", "action", `[${part.text}]`);
      action.tabIndex = 0;
      action.addEventListener("click", () =>
        vscode.postMessage({ type: "action", index: part.index }),
      );
      return action;
    }
    case "label":
      return make("span", "label", part.text);
    default:
      return document.createTextNode(part.text);
  }
}

/** Draw the inspector tab. */
function renderInspector(state: PanelState): void {
  const { inspected, canGoBack, canGoForward, output } = state.inspect;
  element("inspector-empty").style.display = inspected ? "none" : "block";
  element("inspector-body").style.display = inspected ? "flex" : "none";
  element<HTMLButtonElement>("back").disabled = !canGoBack;
  element<HTMLButtonElement>("forward").disabled = !canGoForward;
  if (!inspected) return;
  element("inspected-title").textContent = inspected.title;
  const content = element("content");
  content.replaceChildren(...inspected.parts.map(partNode));
  element("more-parts").style.display = inspected.more ? "block" : "none";
  const shown = element("inspect-output");
  shown.style.display = output ? "block" : "none";
  shown.replaceChildren();
  if (output) {
    shown.appendChild(make("div", "section", output.label));
    shown.appendChild(make("pre", "", output.text));
  }
}


/// Connections

/**
 * Draw the connection switcher: a button naming the connection on view,
 * with a badge counting the debuggers waiting on the others, and the
 * pop-out list of every connection with its debugger and inspector.
 * Hidden while there is one connection, when the tabs say enough.
 */
function renderSwitcher(state: PanelState): void {
  const many = state.connections.length > 1;
  element("switcher").classList.toggle("shown", many);
  if (!many) {
    closeMenu();
    return;
  }
  const viewing = state.connections.find((c) => c.id === state.viewing);
  element("switch-name").textContent = viewing?.name ?? "Connections";
  const waiting = state.connections
    .filter((c) => c.id !== state.viewing)
    .reduce((total, c) => total + c.levels, 0);
  const badge = element("badge");
  badge.textContent = String(waiting);
  badge.style.display = waiting > 0 ? "inline-block" : "none";
  const menu = element("menu");
  menu.textContent = "";
  for (const connection of state.connections) {
    menu.appendChild(make("div", "group-name", connection.name));
    const entries: [PanelState["tab"], string][] = [
      [
        "debugger",
        connection.levels > 0
          ? `Debugger (${connection.levels})`
          : "Debugger",
      ],
      ["inspector", connection.inspecting ? "Inspector \u2022" : "Inspector"],
    ];
    for (const [tab, label] of entries) {
      const on = connection.id === state.viewing && tab === state.tab;
      const entry = make("div", on ? "entry active" : "entry", label);
      entry.addEventListener("click", () => {
        closeMenu();
        vscode.postMessage({ type: "view", connectionId: connection.id, tab });
      });
      menu.appendChild(entry);
    }
  }
}

/** Hide the pop-out list of connections. */
function closeMenu(): void {
  element("menu").classList.remove("open");
}


/// State

let lastTab: string | undefined;

/** Draw the whole page from STATE. */
function render(state: PanelState): void {
  for (const tab of ["debugger", "inspector"]) {
    element(`tab-${tab}`).classList.toggle("active", tab === state.tab);
    element(tab).style.display = tab === state.tab ? "flex" : "none";
  }
  const notice = element("notice");
  notice.textContent = state.notice ?? "";
  renderSwitcher(state);
  renderDebugger(state);
  renderInspector(state);
  if (lastTab !== state.tab) {
    lastTab = state.tab;
    if (state.tab === "inspector") element("inspect-code").focus();
  }
}


/// Page events

for (const tab of ["debugger", "inspector"] as const) {
  element(`tab-${tab}`).addEventListener("click", () =>
    vscode.postMessage({ type: "tab", tab }),
  );
}

element("switch").addEventListener("click", () =>
  element("menu").classList.toggle("open"),
);
/** A click outside the switcher, or Escape, closes its list. */
document.addEventListener("click", (event) => {
  if (!element("switcher").contains(event.target as Node)) closeMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeMenu();
});

element("more-frames").addEventListener("click", () =>
  vscode.postMessage({ type: "moreFrames" }),
);
element("more-parts").addEventListener("click", () =>
  vscode.postMessage({ type: "morePartsOfObject" }),
);

const evalInput = element<HTMLInputElement>("eval-code");
const pprint = element<HTMLInputElement>("pprint");
onEnter(evalInput, (code) =>
  vscode.postMessage({ type: "evalInFrame", code, pprint: pprint.checked }),
);
element("inspect-in-frame").addEventListener("click", () => {
  const code = evalInput.value.trim();
  if (code === "") return;
  vscode.postMessage({ type: "inspectInFrame", code });
  evalInput.value = "";
});
element("return-from").addEventListener("click", () => {
  const code = evalInput.value.trim();
  if (code === "") return;
  vscode.postMessage({ type: "returnFrom", code });
  evalInput.value = "";
});

onEnter(element<HTMLInputElement>("inspect-code"), (code) =>
  vscode.postMessage({ type: "inspect", code }),
);
onEnter(element<HTMLInputElement>("object-eval"), (code) =>
  vscode.postMessage({ type: "inspectEval", code }),
);
element("back").addEventListener("click", () =>
  vscode.postMessage({ type: "back" }),
);
element("forward").addEventListener("click", () =>
  vscode.postMessage({ type: "forward" }),
);
element("reinspect").addEventListener("click", () =>
  vscode.postMessage({ type: "reinspect" }),
);
element("verbose").addEventListener("click", () =>
  vscode.postMessage({ type: "verbose" }),
);
element("describe").addEventListener("click", () =>
  vscode.postMessage({ type: "describe" }),
);
element("close-inspector").addEventListener("click", () =>
  vscode.postMessage({ type: "closeInspector" }),
);

/** The keys 0 to 9 invoke restarts, as in SLY's debugger buffer. */
document.addEventListener("keydown", (event) => {
  const target = event.target as HTMLElement;
  if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
  if (event.ctrlKey || event.altKey || event.metaKey) return;
  if (!/^[0-9]$/.test(event.key)) return;
  if (element("debugger").style.display === "none") return;
  vscode.postMessage({ type: "restart", index: Number(event.key) });
});

window.addEventListener("message", (event: MessageEvent) => {
  const message = event.data as { type: string; state?: PanelState };
  if (message.type === "state" && message.state) render(message.state);
});

vscode.postMessage({ type: "ready" });
