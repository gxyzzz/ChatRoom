import { chmodSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

// node-pty 1.1.0 ships macOS prebuilt spawn-helper files without executable bits.
// Restore them at install time, while the package directory is writable.
if (process.platform === "darwin") {
  const require = createRequire(import.meta.url);
  let root;
  try {
    root = path.dirname(require.resolve("node-pty/package.json"));
  } catch (error) {
    if (error?.code !== "MODULE_NOT_FOUND") throw error;
  }
  if (root) {
    for (const arch of ["x64", "arm64"]) {
      const helper = path.join(
        root,
        "prebuilds",
        `darwin-${arch}`,
        "spawn-helper",
      );
      if (!existsSync(helper)) continue;
      const mode = statSync(helper).mode;
      if (!(mode & 0o111)) chmodSync(helper, mode | 0o111);
    }
  }
}
