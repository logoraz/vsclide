/** Where a slynk server listens. */
export interface Endpoint {
  host: string;
  port: number;
}

/** The host slynk listens on unless told otherwise: this machine. */
export const DEFAULT_HOST = "127.0.0.1";

/**
 * Read TEXT as the place of a slynk server: `host:port`, `:port` or a
 * bare port, which means this machine. Return undefined for anything
 * else, a port outside 1 to 65535 included.
 */
export function parseEndpoint(text: string): Endpoint | undefined {
  const trimmed = text.trim();
  const colon = trimmed.lastIndexOf(":");
  const host = colon < 0 ? "" : trimmed.slice(0, colon).trim();
  const digits = colon < 0 ? trimmed : trimmed.slice(colon + 1).trim();
  if (!/^\d+$/.test(digits)) return undefined;
  const port = Number(digits);
  if (port < 1 || port > 65535) return undefined;
  if (/\s/.test(host)) return undefined;
  return { host: host === "" ? DEFAULT_HOST : host, port };
}
