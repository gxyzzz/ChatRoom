import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultTerminalArgs,
  defaultTerminalShell,
} from "#plugins/process/infrastructure/terminal-shell";

test("terminal starts the native interactive shell", () => {
  assert.equal(
    defaultTerminalShell("darwin", { SHELL: "/bin/zsh" }),
    "/bin/zsh",
  );
  assert.equal(defaultTerminalShell("linux", {}), "/bin/sh");
  assert.equal(
    defaultTerminalShell("win32", {
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      SHELL: "/bin/bash",
    }),
    "C:\\Windows\\System32\\cmd.exe",
  );
  assert.equal(defaultTerminalShell("win32", {}), "cmd.exe");
});

test("macOS terminal uses an interactive login shell", () => {
  assert.deepEqual(defaultTerminalArgs("darwin"), ["-l"]);
  assert.deepEqual(defaultTerminalArgs("linux"), []);
  assert.deepEqual(defaultTerminalArgs("win32"), []);
});
