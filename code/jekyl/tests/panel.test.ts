import { strict as assert } from "node:assert";
import { test } from "node:test";
import { DebugModel, parseLevel } from "../base/debugger";
import { InspectorModel } from "../base/inspector";
import { PanelUi, panelState } from "../base/panel";

const ui: PanelUi = { tab: "debugger", output: undefined, notice: undefined };

test("the state of an idle panel is empty", () => {
  const state = panelState(new DebugModel(), new InspectorModel(), ui);
  assert.equal(state.tab, "debugger");
  assert.deepEqual(state.debug.levels, []);
  assert.equal(state.debug.current, undefined);
  assert.equal(state.inspect.inspected, undefined);
  assert.equal(state.inspect.canGoBack, false);
});

test("the state names the current level and the shown object", () => {
  const debug = new DebugModel();
  debug.open(parseLevel({ threadId: 5, level: 2, frames: [] }));
  const inspector = new InspectorModel();
  inspector.start({ title: "x", id: 1, parts: [], end: 0, more: false });
  const state = panelState(debug, inspector, {
    ...ui,
    tab: "inspector",
    notice: "hi",
  });
  assert.deepEqual(state.debug.current, { threadId: 5, level: 2 });
  assert.equal(state.debug.levels.length, 1);
  assert.equal(state.inspect.inspected?.title, "x");
  assert.equal(state.tab, "inspector");
  assert.equal(state.notice, "hi");
});

test("the state is a copy of the levels list", () => {
  const debug = new DebugModel();
  debug.open(parseLevel({ threadId: 1, level: 1, frames: [] }));
  const state = panelState(debug, new InspectorModel(), ui);
  debug.clear();
  assert.equal(state.debug.levels.length, 1);
});
