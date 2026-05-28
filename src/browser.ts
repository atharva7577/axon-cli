/**
 * Cross-platform "open a URL" — no `open` dep required.
 *
 * Returns true if the command appeared to spawn; false if the user is in a
 * headless shell or `--no-browser` was passed. Either way the URL is also
 * printed so the user can copy it.
 */

import { spawn } from "node:child_process";

export function openBrowser(url: string): boolean {
  // Honour the standard $BROWSER override + skip in obvious headless envs.
  if (process.env.AXON_NO_BROWSER === "1" || process.env.CI === "true") return false;

  const cmd =
    process.platform === "darwin" ? "open"   :
    process.platform === "win32"  ? "cmd"    :
                                    "xdg-open";
  const args =
    process.platform === "win32"  ? ["/c", "start", "", url] :
                                    [url];

  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true, shell: false });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
