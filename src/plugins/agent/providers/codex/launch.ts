import { existsSync } from "node:fs";
import { win32 } from "node:path";

interface CodexLaunch {
  command: string;
  args: string[];
}

interface CodexLaunchOptions {
  platform?: NodeJS.Platform;
  path?: string;
  nodeExecutable?: string;
  exists?: (path: string) => boolean;
}

/**
 * npm exposes codex.cmd on Windows, which child_process.spawn cannot execute
 * without a shell. Launch the installed JS entry point directly with Node.
 * Prefer an actual executable when one is present earlier on PATH.
 */
export function resolveCodexLaunch({
  platform = process.platform,
  path = process.env.PATH ?? "",
  nodeExecutable = process.execPath,
  exists = existsSync,
}: CodexLaunchOptions = {}): CodexLaunch {
  if (platform !== "win32") return { command: "codex", args: [] };

  for (const entry of path.split(";")) {
    const directory = entry.trim().replace(/^"|"$/g, "");
    if (!directory) continue;

    const executable = win32.join(directory, "codex.exe");
    if (exists(executable)) return { command: executable, args: [] };

    const npmShim = win32.join(directory, "codex.cmd");
    const npmEntry = win32.join(
      directory,
      "node_modules",
      "@openai",
      "codex",
      "bin",
      "codex.js",
    );
    if (exists(npmShim) && exists(npmEntry))
      return { command: nodeExecutable, args: [npmEntry] };
  }

  return { command: "codex", args: [] };
}
