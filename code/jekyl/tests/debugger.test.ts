import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  DebugLevel,
  DebugModel,
  parseFrameDetails,
  parseLevel,
} from "../base/debugger";
import { parseNotification } from "../base/ide";

/** Return a level of THREAD at LEVEL, with three frames. */
function level(threadId: number, depth: number): DebugLevel {
  return parseLevel({
    threadId,
    level: depth,
    condition: { message: "boom", type: "SIMPLE-ERROR" },
    restarts: [{ name: "ABORT", description: "Exit debugger." }],
    frames: [0, 1, 2].map((index) => ({
      index,
      text: `(frame ${index})`,
      restartable: index > 0,
    })),
  });
}

test("parseLevel reads the condition, restarts and frames", () => {
  const parsed = level(7, 1);
  assert.equal(parsed.threadId, 7);
  assert.equal(parsed.condition.message, "boom");
  assert.equal(parsed.restarts[0].name, "ABORT");
  assert.equal(parsed.frames.length, 3);
  assert.equal(parsed.frames[1].restartable, true);
  assert.equal(parsed.selected, 0);
  assert.equal(parsed.moreFrames, false);
});

test("parseLevel tolerates missing fields", () => {
  const parsed = parseLevel({});
  assert.deepEqual(parsed.frames, []);
  assert.equal(parsed.condition.message, "");
});

test("parseFrameDetails reads locals, tags and location", () => {
  const details = parseFrameDetails({
    locals: [{ name: "X", id: 0, value: "1" }],
    catchTags: ["TAG"],
    package: "CL-USER",
    location: { file: "/a.lisp", position: 5, snippet: "(foo)" },
  });
  assert.equal(details.locals[0].value, "1");
  assert.deepEqual(details.catchTags, ["TAG"]);
  assert.equal(details.location?.file, "/a.lisp");
  assert.equal(details.location?.line, null);
  assert.equal(parseFrameDetails({}).location, null);
});

test("opening a level makes it the current one", () => {
  const model = new DebugModel();
  assert.equal(model.debugging, false);
  model.open(level(1, 1));
  model.open(level(1, 2));
  assert.equal(model.debugging, true);
  assert.equal(model.current?.level, 2);
  model.activate(1, 1);
  assert.equal(model.current?.level, 1);
});

test("leaving a level also leaves the levels above it", () => {
  const model = new DebugModel();
  model.open(level(1, 1));
  model.open(level(1, 2));
  model.open(level(2, 1));
  model.leave(1, 1);
  assert.deepEqual(
    model.all.map((open) => `${open.threadId}:${open.level}`),
    ["2:1"],
  );
  model.leave(2, 1);
  assert.equal(model.debugging, false);
  assert.equal(model.current, undefined);
});

test("reopening a level replaces it", () => {
  const model = new DebugModel();
  model.open(level(1, 1));
  model.open(level(1, 1));
  assert.equal(model.all.length, 1);
});

test("clear forgets every level and tells the listeners", () => {
  const model = new DebugModel();
  let changes = 0;
  model.onChange(() => (changes += 1));
  model.open(level(1, 1));
  model.clear();
  model.clear();
  assert.equal(model.debugging, false);
  assert.equal(changes, 2);
});

test("selecting a frame and keeping its details", () => {
  const model = new DebugModel();
  model.open(level(1, 1));
  model.select(2);
  assert.equal(model.current?.selected, 2);
  const details = parseFrameDetails({ package: "CL-USER" });
  model.setDetails(1, 1, 2, details);
  assert.equal(model.current?.details[2].package, "CL-USER");
});

test("more frames are added in order without duplicates", () => {
  const model = new DebugModel();
  model.open(level(1, 1));
  const frame = (index: number) => ({
    index,
    text: `(frame ${index})`,
    restartable: false,
  });
  model.addFrames(1, 1, [frame(3), frame(2), frame(4)], 3);
  assert.deepEqual(
    model.current?.frames.map((f) => f.index),
    [0, 1, 2, 3, 4],
  );
  assert.equal(model.current?.moreFrames, true);
  model.addFrames(1, 1, [frame(5)], 3);
  assert.equal(model.current?.moreFrames, false);
});

test("evaluations are kept with their level", () => {
  const model = new DebugModel();
  model.open(level(1, 1));
  model.addEval(1, 1, { frame: 0, code: "x", ok: true, text: "1" });
  assert.equal(model.current?.evals.length, 1);
  model.addEval(9, 9, { frame: 0, code: "x", ok: true, text: "1" });
  assert.equal(model.current?.evals.length, 1);
});

test("notifications become debugger events", () => {
  const opened = parseNotification("ide/debug/open", {
    threadId: 3,
    level: 1,
    condition: { message: "m", type: "T" },
    restarts: [],
    frames: [],
  });
  assert.equal(opened?.type, "debugOpen");
  assert.deepEqual(
    parseNotification("ide/debug/return", {
      threadId: 3,
      level: 1,
      stepping: true,
    }),
    { type: "debugReturn", threadId: 3, level: 1, stepping: true },
  );
  assert.deepEqual(
    parseNotification("ide/debug/activate", { threadId: 3, level: 2 }),
    { type: "debugActivate", threadId: 3, level: 2 },
  );
});
