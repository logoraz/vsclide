import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEndpoint } from "../lib/endpoint";

test("a bare port means this machine", () => {
  assert.deepEqual(parseEndpoint("4005"), { host: "127.0.0.1", port: 4005 });
  assert.deepEqual(parseEndpoint(" :4005 "), {
    host: "127.0.0.1",
    port: 4005,
  });
});

test("host and port are split at the last colon", () => {
  assert.deepEqual(parseEndpoint("locutus.local:4006"), {
    host: "locutus.local",
    port: 4006,
  });
  assert.deepEqual(parseEndpoint("[::1]:4005"), { host: "[::1]", port: 4005 });
});

test("anything else is refused", () => {
  assert.equal(parseEndpoint(""), undefined);
  assert.equal(parseEndpoint("host"), undefined);
  assert.equal(parseEndpoint("host:"), undefined);
  assert.equal(parseEndpoint("host:0"), undefined);
  assert.equal(parseEndpoint("host:65536"), undefined);
  assert.equal(parseEndpoint("a b:4005"), undefined);
});
