import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams } from "node:child_process";
import test from "node:test";
import { ChatRoomError } from "../../src/core/errors/chatroom-error.js";
import { NativeComputerBackend } from "../../src/plugins/computer/computer-native-backend.js";
import { ComputerNativeHost } from "../../src/plugins/computer/computer-native-host.js";

test(
  "ComputerNativeHost handles broken helper stdin without crashing the server",
  {
    skip: process.platform === "win32",
  },
  async () => {
    const host = new ComputerNativeHost();
    const internal = host as unknown as {
      startPipeHelper(
        executable: string,
        platformName: string,
        env: NodeJS.ProcessEnv,
        generation: number,
      ): Promise<void>;
      child: ChildProcessWithoutNullStreams | null;
    };

    try {
      await internal.startPipeHelper("/bin/cat", "test", process.env, 0);
      const child = internal.child;
      assert.ok(child);
      child.stdin.emit(
        "error",
        Object.assign(new Error("write EPIPE"), { code: "EPIPE" }),
      );
      assert.equal(internal.child, null);
      assert.equal(child.killed, true);
    } finally {
      await host.dispose();
    }
  },
);

test(
  "Linux without an X11 session reports unavailable and retries detection",
  { skip: process.platform !== "linux" || Boolean(process.env.DISPLAY) },
  async () => {
    const host = new ComputerNativeHost();
    const backend = new NativeComputerBackend();
    const originalDisplay = process.env.DISPLAY;
    try {
      delete process.env.DISPLAY;
      await assert.rejects(host.request("status", {}), (error: unknown) => {
        assert.ok(error instanceof ChatRoomError);
        assert.equal(error.code, "UNSUPPORTED");
        assert.deepEqual(error.details, { reason: "no_x11_session" });
        return true;
      });
      assert.equal(
        (host as unknown as { child: ChildProcessWithoutNullStreams | null })
          .child,
        null,
      );

      const status = await backend.status();
      assert.equal(status.platform, "linux");
      assert.equal(status.helper, "unavailable");
      assert.equal(status.unavailableReason, "no_x11_session");
      assert.deepEqual(status.displays, []);

      // The next request re-reads the environment instead of caching failure.
      process.env.DISPLAY = ":199";
      const internal = host as unknown as {
        startHelper(platform: "linux", generation: number): Promise<void>;
        startPipeHelper(
          executable: string | null,
          platformName: string,
          env: NodeJS.ProcessEnv,
          generation: number,
        ): Promise<void>;
      };
      let recoveredDisplay: string | undefined;
      internal.startPipeHelper = async (_executable, _platform, env) => {
        recoveredDisplay = env.DISPLAY;
      };
      await internal.startHelper("linux", 0);
      assert.equal(recoveredDisplay, ":199");
    } finally {
      if (originalDisplay === undefined) delete process.env.DISPLAY;
      else process.env.DISPLAY = originalDisplay;
      await host.dispose();
      await backend.dispose();
    }
  },
);
