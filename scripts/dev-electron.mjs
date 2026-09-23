// `npm run electron:dev` = what tauri.conf.json's `beforeDevCommand` + `devUrl`
// do for the Tauri shell: bring up the dev stack (bun bridge + vite) and attach
// the Electron shell to it. If a dev stack is already answering on 5176 we just
// attach, so re-running the command is cheap.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const devStack = join(rootDir, "scripts", "dev.mjs");
const electronBin = join(rootDir, "node_modules", ".bin", "electron");
const devUrl = process.env.PI_DESKTOP_DEV_URL?.trim() || "http://127.0.0.1:5176";
// Escape hatch for the shell process itself, e.g.
//   PI_DESKTOP_ELECTRON_ARGS=--remote-debugging-port=9223 npm run electron:dev
const extraShellArgs = (process.env.PI_DESKTOP_ELECTRON_ARGS ?? "").trim().split(/\s+/).filter(Boolean);

const children = [];
let exiting = false;

if (await isUp(devUrl)) {
  console.log(`[electron:dev] attaching to the dev server already running at ${devUrl}`);
} else {
  console.log(`[electron:dev] starting bridge + vite (${devUrl})...`);
  const stack = spawnChild(process.execPath, [devStack], { stdio: "inherit" });
  // A dead stack (port taken, bun missing) must not leave the shell staring at
  // an origin that will never answer.
  stack.on("exit", (code, signal) => {
    if (!exiting) {
      console.error(`[electron:dev] dev stack exited (code=${code} signal=${signal ?? "none"})`);
      shutdown(code ?? 1);
    }
  });

  if (!(await waitFor(devUrl, 45000))) {
    console.error(`[electron:dev] the dev server did not come up on ${devUrl}.`);
    console.error("[electron:dev] if vite landed on another port, pass PI_DESKTOP_DEV_URL accordingly.");
    shutdown(1);
  }
}

const shell = spawnChild(electronBin, ["src-electron", ...extraShellArgs], {
  stdio: "inherit",
  env: { ...process.env, PI_DESKTOP_DEV_URL: devUrl },
});

shell.on("exit", (code, signal) => shutdown(code ?? (signal ? 1 : 0)));

function spawnChild(command, args, options) {
  const child = spawn(command, args, { cwd: rootDir, ...options });
  children.push(child);
  return child;
}

function shutdown(code) {
  if (exiting) {
    return;
  }

  exiting = true;
  for (const child of children) {
    if (!child.killed && child.exitCode === null) {
      child.kill("SIGTERM");
    }
  }

  process.exitCode = code;
  setTimeout(() => process.exit(code), 50);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

async function isUp(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 800);
    await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isUp(url)) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  return false;
}
