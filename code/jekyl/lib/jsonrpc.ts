import * as net from "node:net";

/** JSON-RPC 2.0 message as exchanged with clide. */
export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Error codes shared with clide (see clide/lib/jsonrpc.lisp). */
export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  Unauthorized: -32001,
  NotConnected: -32002,
  SlynkFailure: -32003,
} as const;

/** An error reply from clide. */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

const HEADER_END = "\r\n\r\n";

/**
 * Frame MESSAGE with a Content-Length header.
 * The length counts UTF-8 bytes, not characters.
 */
export function encodeMessage(message: object): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.from(`Content-Length: ${body.length}${HEADER_END}`);
  return Buffer.concat([header, body]);
}

/**
 * Remove every complete message from the front of BUFFER.
 * Returns the parsed messages and the unconsumed remainder.
 * Throws when a header block has no Content-Length or a body is not
 * valid JSON; the stream cannot be resynchronized after that.
 */
export function decodeMessages(buffer: Buffer): {
  messages: JsonRpcMessage[];
  rest: Buffer;
} {
  const messages: JsonRpcMessage[] = [];
  let rest = buffer;
  for (;;) {
    const end = rest.indexOf(HEADER_END);
    if (end < 0) break;
    const match = /content-length:\s*(\d+)/i.exec(
      rest.subarray(0, end).toString("latin1"),
    );
    if (!match) throw new Error("message has no Content-Length header");
    const start = end + HEADER_END.length;
    const length = Number(match[1]);
    if (rest.length < start + length) break;
    messages.push(
      JSON.parse(rest.subarray(start, start + length).toString("utf8")),
    );
    rest = rest.subarray(start + length);
  }
  return { messages, rest };
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

/** Called for each notification clide sends. */
export type NotificationListener = (method: string, params: unknown) => void;

/**
 * JSON-RPC client over one loopback connection to clide.
 * Requests resolve with the reply's result or reject with RpcError.
 * Notifications from clide go to the listeners added with
 * onNotification.
 */
export class RpcClient {
  /** Resolves when the connection has closed. */
  readonly closed: Promise<void>;

  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buffer: Buffer = Buffer.alloc(0);
  private listeners = new Set<NotificationListener>();

  private constructor(private readonly socket: net.Socket) {
    this.closed = new Promise((resolve) => socket.once("close", resolve));
    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("error", (error) => this.failAll(error));
    socket.on("close", () => this.failAll(new Error("connection closed")));
  }

  /**
   * Open a connection to clide on HOST and PORT.
   * The caller must send initialize with the session token first.
   */
  static connect(port: number, host = "127.0.0.1"): Promise<RpcClient> {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host, port });
      socket.once("error", reject);
      socket.once("connect", () => {
        socket.removeListener("error", reject);
        resolve(new RpcClient(socket));
      });
    });
  }

  /** Send a request and resolve with its result. */
  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.socket.destroyed) {
        reject(new Error("connection closed"));
        return;
      }
      const id = this.nextId++;
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.socket.write(
        encodeMessage({ jsonrpc: "2.0", id, method, params }),
      );
    });
  }

  /** Call LISTENER for each notification; return a function that stops it. */
  onNotification(listener: NotificationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Close the connection; outstanding requests are rejected. */
  close(): void {
    this.socket.destroy();
  }

  private onData(chunk: Buffer): void {
    try {
      const { messages, rest } = decodeMessages(
        Buffer.concat([this.buffer, chunk]),
      );
      this.buffer = rest;
      messages.forEach((message) => this.dispatch(message));
    } catch (error) {
      this.failAll(error as Error);
      this.socket.destroy();
    }
  }

  private dispatch(message: JsonRpcMessage): void {
    if (typeof message.method === "string" && message.id === undefined) {
      for (const listener of this.listeners) {
        try {
          listener(message.method, message.params);
        } catch {
          // A faulty listener must not stop the others or the decoder.
        }
      }
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(
        new RpcError(
          message.error.code,
          message.error.message,
          message.error.data,
        ),
      );
    } else {
      pending.resolve(message.result);
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
