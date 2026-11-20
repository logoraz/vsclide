import { ClideProcess, LaunchOptions, startClide } from "./process";
import { NotificationListener, RpcClient } from "../lib/jsonrpc";

/**
 * One clide process and its authenticated connection, started on
 * first use and restarted after the process exits.
 */
export class Session {
  private starting: Promise<RpcClient> | undefined;
  private current: ClideProcess | undefined;
  private readonly notificationListeners = new Set<NotificationListener>();
  private readonly exitListeners = new Set<() => void>();

  /**
   * LAUNCH is called each time clide has to be started; it may first
   * have to prepare, as by installing dependencies.
   */
  constructor(
    private readonly launch: () => LaunchOptions | Promise<LaunchOptions>,
  ) {}

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

  /** Start clide if needed, send a request and return its result. */
  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const client = await this.ensure();
    return client.request<T>(method, params);
  }

  /**
   * Call LISTENER for each notification clide sends, across restarts.
   * Returns a function that removes the listener.
   */
  onNotification(listener: NotificationListener): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  /** Call LISTENER when the clide process exits for any reason. */
  onExit(listener: () => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
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
    const clide = await startClide(await this.launch());
    this.current = clide;
    void clide.exited.then(() => {
      if (this.current === clide) {
        this.current = undefined;
        this.starting = undefined;
        this.exitListeners.forEach((listener) => listener());
      }
    });
    const client = await RpcClient.connect(clide.port);
    client.onNotification((method, params) => {
      this.notificationListeners.forEach((listener) =>
        listener(method, params),
      );
    });
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
