import { strict as assert } from "node:assert";
import * as net from "node:net";
import { test } from "node:test";
import { RpcClient } from "../lib/jsonrpc";

/** Start a server that accepts and never answers; return it and its port. */
function silentServer(): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve) => {
    const server = net.createServer(() => undefined);
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as net.AddressInfo).port });
    });
  });
}

test("a request with a timeout rejects when no reply comes", async () => {
  const { server, port } = await silentServer();
  const client = await RpcClient.connect(port);
  try {
    await assert.rejects(
      client.request("initialize", {}, 50),
      /initialize did not answer within 0.05 s/,
    );
  } finally {
    client.close();
    server.close();
  }
});
