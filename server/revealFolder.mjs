/**
 * Opening a project folder from the bridge ("在访达中显示" / "Reveal in Finder").
 *
 * The bridge is a background process: on macOS `open` still creates the Finder window, but
 * it does **not** bring Finder forward, so the window appears behind the app and clicking the
 * path looks like a no-op. That is why the reveal is two steps — open the folder, then ask
 * Finder to activate itself.
 *
 * The command plan lives here (not inline in `server/index.mjs`) so the platform differences
 * and the ordering can be unit tested without spawning anything.
 */
import { spawn } from "node:child_process";

/** @typedef {{ command: string, args: string[], optional?: boolean }} RevealStep */

/**
 * The steps that open `path` in the platform's file manager.
 *
 * `optional: true` means "the folder window is already open; failing to raise it must not
 * fail the reveal".
 *
 * @returns {RevealStep[]}
 */
export function revealFolderCommands(path, platform = process.platform) {
  const opener =
    platform === "darwin"
      ? { command: "open", args: [path] }
      : platform === "win32"
        ? { command: "explorer.exe", args: [path] }
        : { command: "xdg-open", args: [path] };

  const steps = [opener];
  if (platform === "darwin") {
    steps.push({ command: "osascript", args: ["-e", 'tell application "Finder" to activate'], optional: true });
  }
  return steps;
}

function runStep(step, spawnImpl) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(step.command, step.args, { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Failed to run ${step.command}: ${step.args.join(" ")}`));
      }
    });
  });
}

/**
 * Run the reveal plan. The first failure of a non-optional step rejects; optional steps are
 * best-effort (a machine without AppleScript automation permission still opens the folder).
 */
export async function revealFolder(path, { spawnImpl = spawn, platform = process.platform } = {}) {
  for (const step of revealFolderCommands(path, platform)) {
    try {
      await runStep(step, spawnImpl);
    } catch (error) {
      if (!step.optional) {
        throw error;
      }
    }
  }
}