import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { Router } from "express";
import { ChatRoomError } from "#core/errors/chatroom-error";
import {
  asyncRoute,
  bodyRecord,
  requireString,
} from "#presentation/http/http-utils";
import type { WebRuntime } from "#plugins/web/runtime";
import {
  defaultTerminalShell,
  defaultTerminalArgs,
} from "#plugins/process/infrastructure/terminal-shell";

const MAX_RUNNING = 8;
const MAX_SESSIONS = 24;
const MAX_INPUT_BYTES = 16 * 1024;
const MAX_BACKLOG = 512 * 1024;
const validSize = (n: unknown): n is number =>
  Number.isInteger(n) && (n as number) >= 2 && (n as number) <= 500;

type Session = {
  id: string;
  processId: string;
  shell: string;
  createdAt: string;
};

/** PTY I/O over the existing V2 HTTP stream transport; no extra socket/protocol. */
export function createTerminalApiRouter(app: WebRuntime): Router {
  const router = Router();
  const sessions = new Map<string, Session>();
  const describe = (s: Session) => ({
    ...s,
    state: app.processes.read(s.processId).state,
  });
  function requireSession(id: string): Session {
    const session = sessions.get(id);
    if (!session) throw new ChatRoomError("NOT_FOUND", "Terminal not found");
    return session;
  }
  router.get("/terminal/sessions", (_req, res) => {
    res.json([...sessions.values()].reverse().map(describe));
  });
  router.post(
    "/terminal/sessions",
    asyncRoute(async (req, res) => {
      const body = bodyRecord(req.body);
      const cols = body.cols ?? 80;
      const rows = body.rows ?? 24;
      if (!validSize(cols) || !validSize(rows))
        throw new ChatRoomError("INVALID_INPUT", "Invalid terminal dimensions");
      const running = [...sessions.values()].filter(
        (s) => app.processes.read(s.processId).state === "running",
      ).length;
      if (running >= MAX_RUNNING || sessions.size >= MAX_SESSIONS)
        throw new ChatRoomError("CONFLICT", "Too many terminal sessions");
      const shell = defaultTerminalShell();
      const snapshot = await app.processes.start(
        {
          command: shell,
          args: defaultTerminalArgs(),
          cwd: homedir(),
          pty: true,
          cols,
          rows,
          env: {
            ...process.env,
            TERM: "xterm-256color",
            COLORTERM: "truecolor",
          },
          timeoutMs: 0,
        },
        { source: "gui", action: "start" },
      );
      const session: Session = {
        id: randomUUID(),
        processId: snapshot.processId,
        shell,
        createdAt: snapshot.startedAt,
      };
      sessions.set(session.id, session);
      res.status(201).json(describe(session));
    }),
  );
  router.post("/terminal/sessions/:id/input", (req, res) => {
    const session = requireSession(requireString(req.params.id, "id"));
    const body = bodyRecord(req.body);
    const data = requireString(body.data, "data");
    if (Buffer.byteLength(data, "utf8") > MAX_INPUT_BYTES)
      throw new ChatRoomError("INVALID_INPUT", "Terminal input too large");
    app.processes.write(session.processId, data);
    res.status(204).end();
  });
  router.post("/terminal/sessions/:id/resize", (req, res) => {
    const session = requireSession(requireString(req.params.id, "id"));
    const body = bodyRecord(req.body);
    if (!validSize(body.cols) || !validSize(body.rows))
      throw new ChatRoomError("INVALID_INPUT", "Invalid terminal dimensions");
    app.processes.resize(session.processId, body.cols, body.rows);
    res.status(204).end();
  });
  router.delete(
    "/terminal/sessions/:id",
    asyncRoute(async (req, res) => {
      const session = requireSession(requireString(req.params.id, "id"));
      if (app.processes.read(session.processId).state === "running")
        await app.processKill(session.processId, false);
      sessions.delete(session.id);
      res.status(204).end();
    }),
  );
  router.get("/terminal/sessions/:id/stream", (req, res) => {
    const session = requireSession(requireString(req.params.id, "id"));
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "private, no-store, no-transform");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    let finished = false;
    const write = (type: string, payload: unknown) => {
      if (finished || res.destroyed) return;
      if (res.writableLength > MAX_BACKLOG) {
        res.destroy(new Error("Terminal stream is too slow"));
        return;
      }
      res.write(
        "event: " + type + "\n" + "data: " + JSON.stringify(payload) + "\n\n",
      );
    };
    // Attach before taking snapshot: no output gap between backlog and live bytes.
    const { snapshot, unsubscribe } = app.processes.subscribeOutput(
      session.processId,
      (chunk) => {
        if (!chunk) {
          write("exit", describe(session));
          res.end();
          return;
        }
        for (let offset = 0; offset < chunk.length; offset += 16 * 1024)
          write(
            "output",
            chunk.subarray(offset, offset + 16 * 1024).toString("base64"),
          );
      },
    );
    write("snapshot", {
      output: Buffer.from(snapshot.stdout, "utf8").toString("base64"),
      state: snapshot.state,
    });
    if (snapshot.state !== "running") {
      write("exit", describe(session));
      unsubscribe();
      res.end();
      return;
    }
    const heartbeat = setInterval(() => write("ping", null), 15000);
    heartbeat.unref();
    res.on("close", () => {
      finished = true;
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
  return router;
}
