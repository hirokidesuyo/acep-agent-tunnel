import { WebSocketServer, WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import { AcepMessageSchema, type SenderRole } from "../protocol/types.js";

interface ChannelRoom {
  token: string;
  host: WebSocket | null;
  seeker: WebSocket | null;
}

export class RelayServer {
  private wss: WebSocketServer | null = null;
  private rooms = new Map<string, ChannelRoom>();

  private parseAuthParams(rawUrl: string | undefined): {
    channelId: string;
    token: string;
    role: SenderRole;
  } | null {
    let reqUrl: URL;
    try {
      reqUrl = new URL(rawUrl ?? "/", "ws://127.0.0.1");
    } catch {
      return null;
    }
    const channelId = reqUrl.searchParams.get("channel_id");
    const token = reqUrl.searchParams.get("token");
    const role = reqUrl.searchParams.get("role");

    if (!channelId || !token || (role !== "host" && role !== "seeker")) {
      return null;
    }
    return { channelId, token, role };
  }

  private isSocketActive(ws: WebSocket | null): boolean {
    return (
      ws !== null &&
      (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
    );
  }

  async start(port = 0): Promise<{ port: number; url: string }> {
    if (this.wss) {
      const addr = this.wss.address() as AddressInfo;
      return { port: addr.port, url: `ws://127.0.0.1:${addr.port}` };
    }

    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({
        host: "127.0.0.1",
        port,
        verifyClient: ({ req }, cb) => {
          const auth = this.parseAuthParams(req.url);
          if (!auth) {
            cb(false, 400, "Missing channel_id, token, or valid role");
            return;
          }

          const room = this.rooms.get(auth.channelId);
          if (room && room.token !== auth.token) {
            cb(false, 401, "Invalid token");
            return;
          }
          if (room && this.isSocketActive(room[auth.role])) {
            cb(false, 409, "Role already connected");
            return;
          }

          cb(true);
        },
      });
      this.wss = wss;

      const onStartupError = (err: Error) => {
        this.wss = null;
        reject(err);
      };

      wss.once("error", onStartupError);
      wss.once("listening", () => {
        wss.off("error", onStartupError);
        const addr = wss.address() as AddressInfo;
        resolve({ port: addr.port, url: `ws://127.0.0.1:${addr.port}` });
      });

      wss.on("connection", (ws, req) => {
        ws.on("error", () => {
          // Ignore individual client socket errors; close handler cleans up room state.
        });

        const auth = this.parseAuthParams(req.url);
        if (!auth) {
          ws.close(4000, "Missing channel_id, token, or valid role");
          return;
        }
        const { channelId, token, role } = auth;

        let room = this.rooms.get(channelId);
        if (!room) {
          room = { token, host: null, seeker: null };
          this.rooms.set(channelId, room);
        } else if (room.token !== token) {
          ws.close(4001, "Invalid token");
          return;
        } else if (this.isSocketActive(room[role])) {
          ws.close(4009, "Role already connected");
          return;
        }

        room[role] = ws;

        ws.on("message", (raw) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw.toString("utf8"));
          } catch {
            return;
          }
          const result = AcepMessageSchema.safeParse(parsed);
          if (!result.success) return;
          if (
            result.data.channel_id !== channelId ||
            result.data.sender_role !== role
          ) {
            return;
          }

          const peerRole: SenderRole = role === "host" ? "seeker" : "host";
          const peer = room?.[peerRole];
          if (peer && peer.readyState === WebSocket.OPEN) {
            peer.send(JSON.stringify(result.data));
          }
        });

        ws.on("close", () => {
          if (room && room[role] === ws) {
            room[role] = null;
            if (!room.host && !room.seeker) {
              this.rooms.delete(channelId);
            }
          }
        });
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.wss) return;
    const wss = this.wss;
    this.wss = null;
    this.rooms.clear();
    return new Promise((resolve) => {
      for (const client of wss.clients) {
        client.terminate();
      }
      wss.close(() => resolve());
    });
  }
}
