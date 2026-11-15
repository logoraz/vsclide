import { ClideProcess, LaunchOptions, startClide } from "./process";
import { RpcClient } from "../lib/jsonrpc";

/**
 * One clide process and its authenticated connection, started on
 * first use and restarted after the process exits.
 */
export class Session {
  private starting: Promise<RpcClient> | undefined;
  private current: ClideProcess | undefined;

  constructor(private readonly options: LaunchOptions) {}

  /** Return the connected client, starting clide if needed. */
  ensure(): Promise<RpcClient> {
    if (!this.starting) {
      this.starting = this.start().catch((error) => {
        this.starting = undefined;
        throw error;
      });
    }
    return this.starting;
  }

  /** Close the connection and stop the process. */
  async stop(): Promise<void> {
    const starting = this.starting;
    const current = this.current;
    this.starting = undefined;
    this.current = undefined;
    const client = await starting?.catch(() => undefined);
    client?.close();
    await current?.stop();
  }

  private async start(): Promise<RpcClient> {
    const clide = await startClide(this.options);
    this.current = clide;
    void clide.exited.then(() => {
      if (this.current === clide) {
        this.current = undefined;
        this.starting = undefined;
      }
    });
    const client = await RpcClient.connect(clide.port);
    try {
      await client.request("initialize", { token: clide.token });
    } catch (error) {
      client.close();
      await clide.stop();
      throw error;
    }
    return client;
  }
}
