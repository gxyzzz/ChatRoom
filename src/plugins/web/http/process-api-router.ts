import { Router } from "express";
import type { WebRuntime } from "#plugins/web/runtime";
import { asyncRoute, requireString } from "#presentation/http/http-utils";

export function createProcessApiRouter(application: WebRuntime): Router {
  const router = Router();
  router.get("/processes", (_req, res) =>
    res.json(application.listProcesses()),
  );
  router.get("/processes/:processId/summary", (req, res) => {
    res.json(
      application.getProcessSummary(
        requireString(req.params.processId, "processId"),
      ),
    );
  });
  router.get("/processes/:processId/stream", (req, res) => {
    const processId = requireString(req.params.processId, "processId");
    // Validate and attach before flushing headers: invalid IDs return JSON 404.
    let closed = false;
    const write = (type: string, data: unknown) => {
      if (closed || res.destroyed) return;
      if (res.writableLength > 512 * 1024) {
        res.destroy(new Error("Process output stream is too slow"));
        return;
      }
      res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const { snapshot, unsubscribe } = application.processes.subscribeOutput(
      processId,
      (chunk, stream) => {
        if (!chunk) {
          const {
            stdout: _stdout,
            stderr: _stderr,
            ...status
          } = application.getProcess(processId);
          write("exit", status);
          res.end();
        } else {
          for (let offset = 0; offset < chunk.length; offset += 16 * 1024)
            write("output", {
              stream: stream ?? "stdout",
              bytes: chunk
                .subarray(offset, offset + 16 * 1024)
                .toString("base64"),
            });
        }
      },
    );
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "private, no-store, no-transform");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    write("snapshot", snapshot);
    if (snapshot.state !== "running") {
      res.end();
      unsubscribe();
      return;
    }

    const heartbeat = setInterval(() => write("ping", null), 15_000);
    heartbeat.unref();
    res.on("close", () => {
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
  router.get("/processes/:processId", (req, res) => {
    res.json(
      application.getProcess(requireString(req.params.processId, "processId")),
    );
  });
  router.post(
    "/processes/:processId/terminate",
    asyncRoute(async (req, res) => {
      res.json(
        await application.processKill(
          requireString(req.params.processId, "processId"),
          false,
        ),
      );
    }),
  );
  router.post(
    "/processes/:processId/kill",
    asyncRoute(async (req, res) => {
      res.json(
        await application.processKill(
          requireString(req.params.processId, "processId"),
          true,
        ),
      );
    }),
  );
  return router;
}
