/** Select the OS default interactive shell for a local terminal session. */
export function defaultTerminalShell(
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return platform === "win32"
    ? env.ComSpec || env.COMSPEC || "cmd.exe"
    : env.SHELL || "/bin/sh";
}

/** macOS Terminal starts an interactive login shell; match its PATH initialization. */
export function defaultTerminalArgs(platform = process.platform): string[] {
  return platform === "darwin" ? ["-l"] : [];
}
