import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import type { Duplex } from "node:stream";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function matchesNoProxy(hostname: string, noProxyRaw?: string): boolean {
  if (!noProxyRaw) return false;
  const host = hostname.toLowerCase();
  const entries = noProxyRaw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  for (const entry of entries) {
    if (entry === "*") return true;
    const entryHost = entry.replace(/:\d+$/, "");
    if (host === entryHost) return true;
    const suffix = entryHost.startsWith(".") ? entryHost : `.${entryHost}`;
    if (host.endsWith(suffix)) return true;
  }
  return false;
}

/**
 * Resolves the outbound HTTP/HTTPS proxy URL for a given `ws://` or `wss://` target
 * using standard environment variables (`HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, `NO_PROXY`).
 */
export function resolveProxyUrl(
  targetUrl: string,
  env: NodeJS.ProcessEnv = process.env,
  options: { bypassLocalhost?: boolean } = {},
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return null;
  }

  const hostname = parsed.hostname.toLowerCase();
  if (options.bypassLocalhost !== false && LOCAL_HOSTS.has(hostname)) {
    return null;
  }

  const noProxy = env.NO_PROXY ?? env.no_proxy;
  if (matchesNoProxy(hostname, noProxy)) {
    return null;
  }

  const isSecure = parsed.protocol === "wss:" || parsed.protocol === "https:";
  const candidate = isSecure
    ? env.HTTPS_PROXY ??
      env.https_proxy ??
      env.ALL_PROXY ??
      env.all_proxy ??
      env.HTTP_PROXY ??
      env.http_proxy
    : env.HTTP_PROXY ?? env.http_proxy ?? env.ALL_PROXY ?? env.all_proxy;

  const trimmed = candidate?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Creates a Node.js `http.Agent` / `https.Agent` that establishes an HTTP CONNECT
 * tunnel through the specified proxy before upgrading to WebSocket (with TLS for `wss://`).
 */
export function createProxyAgent(targetUrl: string, proxyUrl: string): http.Agent {
  const target = new URL(targetUrl);
  const proxy = new URL(proxyUrl);
  const isTargetSecure =
    target.protocol === "wss:" || target.protocol === "https:";
  const isProxySecure = proxy.protocol === "https:";

  if (proxy.protocol !== "http:" && proxy.protocol !== "https:") {
    throw new Error(
      `Unsupported proxy protocol "${proxy.protocol}": expected http: or https:`,
    );
  }

  const targetPort = Number(target.port) || (isTargetSecure ? 443 : 80);
  const proxyPort = Number(proxy.port) || (isProxySecure ? 443 : 80);
  const connectAuthority = `${target.hostname}:${targetPort}`;

  const BaseAgent = isTargetSecure ? https.Agent : http.Agent;
  const agent = new BaseAgent({ keepAlive: false });

  (
    agent as unknown as {
      createConnection: (
        options: https.RequestOptions,
        callback: (err: Error | null, socket?: Duplex) => void,
      ) => void;
    }
  ).createConnection = (options, callback) => {
    const headers: Record<string, string> = {
      Host: connectAuthority,
    };
    if (proxy.username || proxy.password) {
      const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
      headers["Proxy-Authorization"] = `Basic ${Buffer.from(credentials).toString("base64")}`;
    }

    const requestFn = isProxySecure ? https.request : http.request;
    const req = requestFn({
      host: proxy.hostname,
      port: proxyPort,
      method: "CONNECT",
      path: connectAuthority,
      headers,
    });

    let done = false;
    const finish = (err: Error | null, socket?: Duplex) => {
      if (done) return;
      done = true;
      callback(err, socket);
    };

    req.once("connect", (res, socket, head) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        finish(
          new Error(
            `Proxy CONNECT to ${connectAuthority} failed with status ${res.statusCode}`,
          ),
        );
        return;
      }

      if (head.length > 0) {
        socket.unshift(head);
      }

      if (isTargetSecure) {
        const tlsSocket = tls.connect({
          socket,
          servername: target.hostname,
          rejectUnauthorized: options.rejectUnauthorized ?? true,
        });
        tlsSocket.once("error", (err) => finish(err));
        finish(null, tlsSocket);
      } else {
        finish(null, socket);
      }
    });

    req.once("error", (err) => {
      finish(err);
    });

    req.end();
  };

  return agent;
}
