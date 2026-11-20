/**
 * Script of the mREPL webview. It draws what the extension sends, one
 * transcript and one tab per REPL, and sends back what the user types.
 * It has no knowledge of Lisp.
 */

interface VsCodeApi {
  postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

/** Messages from the extension; replId is absent for ones to all REPLs. */
type Incoming =
  | { type: "add"; replId: number; title: string }
  | { type: "remove"; replId: number }
  | { type: "select"; replId?: number }
  | { type: "output"; replId: number; text: string; first?: boolean }
  | { type: "prompt"; replId: number; text: string }
  | { type: "values"; replId: number; values: ReplValue[] }
  | { type: "aborted"; replId: number; message: string }
  | { type: "notice"; replId?: number; text: string }
  | { type: "problem"; text?: string }
  | { type: "clear"; replId?: number };

/** A value a REPL returned: what to show, and where slynk keeps it. */
interface ReplValue {
  text: string;
  entry: number;
  value: number;
}

/** Everything the page keeps for one REPL. */
interface Repl {
  title: string;
  transcript: HTMLElement;
  tab: HTMLElement;
  prompt: string;
  entries: string[];
  position: number;
  draft: string;
  /** True until the first input; output until then is the greeting. */
  greeting: boolean;
}

const vscode = acquireVsCodeApi();
const transcripts = document.getElementById("transcripts") as HTMLElement;
const tabs = document.getElementById("tabs") as HTMLElement;
const input = document.getElementById("input") as HTMLTextAreaElement;
const promptLabel = document.getElementById("prompt") as HTMLElement;
const interrupt = document.getElementById("interrupt") as HTMLButtonElement;
const empty = document.getElementById("empty") as HTMLElement;
const emptyText = empty.textContent ?? "";

const repls = new Map<number, Repl>();
let active: number | undefined;

/** Append VALUE, which a click inspects, to the transcript of REPL. */
function appendValue(repl: Repl, replId: number, value: ReplValue): void {
  const block = document.createElement("div");
  block.className = "value inspectable";
  block.title = "Click to inspect";
  block.textContent = value.text;
  block.addEventListener("click", () =>
    vscode.postMessage({
      type: "inspect",
      replId,
      entry: value.entry,
      value: value.value,
    }),
  );
  repl.transcript.appendChild(block);
  repl.transcript.scrollTop = repl.transcript.scrollHeight;
}

/** Append a block of CLASS to the transcript of REPL and scroll to it. */
function append(repl: Repl, className: string, text: string): void {
  if (text === "") return;
  const last = repl.transcript.lastElementChild;
  const joins = className === "output" || className === "banner";
  if (joins && last?.classList.contains(className)) {
    last.textContent += text;
  } else {
    const block = document.createElement("div");
    block.className = className;
    block.textContent = text;
    repl.transcript.appendChild(block);
  }
  repl.transcript.scrollTop = repl.transcript.scrollHeight;
}

/** Make REPL ID the active one: show its transcript, prompt and draft. */
function select(id: number | undefined): void {
  const previous = active === undefined ? undefined : repls.get(active);
  if (previous) previous.draft = input.value;
  active = id !== undefined && repls.has(id) ? id : undefined;
  for (const [replId, repl] of repls) {
    const on = replId === active;
    repl.transcript.classList.toggle("active", on);
    repl.tab.classList.toggle("active", on);
  }
  const repl = active === undefined ? undefined : repls.get(active);
  input.disabled = repl === undefined;
  empty.style.display = repls.size === 0 ? "block" : "none";
  promptLabel.textContent = repl?.prompt ?? "";
  input.value = repl?.draft ?? "";
  tabs.classList.toggle("shown", repls.size > 1);
  if (repl) input.focus();
}

/** Add the tab and transcript of a new REPL. */
function add(id: number, title: string): void {
  if (repls.has(id)) return;
  const transcript = document.createElement("div");
  transcript.className = "transcript";
  transcripts.appendChild(transcript);

  const tab = document.createElement("div");
  tab.className = "tab";
  const label = document.createElement("span");
  label.textContent = title;
  const close = document.createElement("span");
  close.className = "close";
  close.textContent = "×";
  close.title = "Close";
  tab.append(label, close);
  tabs.appendChild(tab);
  tab.addEventListener("click", () => {
    select(id);
    vscode.postMessage({ type: "select", replId: id });
  });
  close.addEventListener("click", (event) => {
    event.stopPropagation();
    vscode.postMessage({ type: "close", replId: id });
  });

  repls.set(id, {
    title,
    transcript,
    tab,
    prompt: "CL-USER>",
    entries: [],
    position: 0,
    draft: "",
    greeting: true,
  });
  select(id);
}

/** Remove the tab and transcript of REPL ID. */
function remove(id: number): void {
  const repl = repls.get(id);
  if (!repl) return;
  repl.transcript.remove();
  repl.tab.remove();
  repls.delete(id);
  if (active === id) active = undefined;
}

/** Send the contents of the input box to the active REPL. */
function submit(): void {
  const repl = active === undefined ? undefined : repls.get(active);
  const text = input.value;
  if (!repl || active === undefined || text.trim() === "") return;
  append(repl, "input", `${repl.prompt} ${text}`);
  repl.greeting = false;
  repl.entries.push(text);
  repl.position = repl.entries.length;
  input.value = "";
  repl.draft = "";
  vscode.postMessage({ type: "send", replId: active, text });
}

/** Step through the history: DIRECTION is -1 for older, 1 for newer. */
function recall(repl: Repl, direction: number): void {
  const end = repl.entries.length;
  if (repl.position === end) repl.draft = input.value;
  repl.position = Math.max(0, Math.min(end, repl.position + direction));
  input.value =
    repl.position === end ? repl.draft : repl.entries[repl.position];
}

input.addEventListener("keydown", (event) => {
  const repl = active === undefined ? undefined : repls.get(active);
  if (!repl || active === undefined) return;
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    submit();
  } else if (event.key === "ArrowUp" && input.selectionStart === 0) {
    event.preventDefault();
    recall(repl, -1);
  } else if (
    event.key === "ArrowDown" &&
    input.selectionEnd === input.value.length
  ) {
    event.preventDefault();
    recall(repl, 1);
  } else if (event.key === "c" && event.ctrlKey) {
    vscode.postMessage({ type: "interrupt", replId: active });
  }
});

interrupt.addEventListener("click", () => {
  if (active !== undefined) {
    vscode.postMessage({ type: "interrupt", replId: active });
  }
});

/** Return the REPLs a message is for: the one named, else all. */
function targets(replId: number | undefined): Repl[] {
  if (replId === undefined) return [...repls.values()];
  const repl = repls.get(replId);
  return repl ? [repl] : [];
}

window.addEventListener("message", (event: MessageEvent<Incoming>) => {
  const message = event.data;
  switch (message.type) {
    case "add":
      add(message.replId, message.title);
      break;
    case "remove":
      remove(message.replId);
      break;
    case "select":
      select(message.replId);
      break;
    case "output":
      targets(message.replId).forEach((repl) =>
        append(
          repl,
          message.first || repl.greeting ? "banner" : "output",
          message.text,
        ),
      );
      break;
    case "prompt":
      targets(message.replId).forEach((repl) => {
        repl.prompt = message.text;
        if (repls.get(active ?? -1) === repl) {
          promptLabel.textContent = message.text;
        }
      });
      break;
    case "values":
      targets(message.replId).forEach((repl) =>
        message.values.forEach((value) =>
          appendValue(repl, message.replId, value),
        ),
      );
      break;
    case "aborted":
      targets(message.replId).forEach((repl) =>
        append(repl, "error", message.message || "Evaluation aborted"),
      );
      break;
    case "notice":
      targets(message.replId).forEach((repl) =>
        append(repl, "notice", message.text),
      );
      break;
    case "problem":
      // Shown in place of "No mREPL open", for a start that failed.
      empty.textContent = message.text ?? emptyText;
      break;
    case "clear":
      targets(message.replId).forEach((repl) => {
        repl.transcript.textContent = "";
      });
      break;
  }
});

select(undefined);
vscode.postMessage({ type: "ready" });
