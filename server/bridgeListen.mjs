/**
 * One rule for the bridge's listening port, shared by the bridge and every host that starts it.
 *
 * Before this, dev probed ports itself (`canBind` + a 20-port scan, racing whoever grabbed the
 * port between the probe and the bind) while the packaged hosts pinned 6474 and let the bridge
 * `process.exit(1)` on `EADDRINUSE` - a window with no data and no message. Now the bridge owns
 * the choice (preferred port, else whatever the OS hands out) and announces the result on stdout;
 * hosts only discover it.
 */

export const DEFAULT_PREFERRED_PORT = 6474;
export const BRIDGE_URL_PREFIX = "PI_DESKTOP_BRIDGE_URL=";

/** The port the caller asked for, or the preferred one. `0` means "OS picks", and is honoured. */
export function preferredPort(env = process.env) {
  const raw = text(env.PI_DESKTOP_PORT) || text(env.ENGBUDDY_PORT);
  if (!raw) {
    return DEFAULT_PREFERRED_PORT;
  }
  const port = Number(raw);
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : DEFAULT_PREFERRED_PORT;
}

/**
 * An explicit request is a contract: if 6474 was named by the operator, failing to get it must
 * be loud rather than silently served on a random port.
 */
export function isPortExplicit(env = process.env) {
  return Boolean(text(env.PI_DESKTOP_PORT) || text(env.ENGBUDDY_PORT));
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function bridgeUrlFor(host, port) {
  const hostname = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${hostname}:${port}`;
}

/** Is this the "port is taken, try again" error we can recover from by asking for any port? */
export function shouldRetryWithEphemeralPort(error, explicit) {
  if (explicit) {
    return false;
  }
  const code = typeof error === "object" && error ? error.code ?? "" : "";
  return code === "EADDRINUSE" || /EADDRINUSE|already in use/i.test(String(error ?? ""));
}

/** What the bridge prints so a parent process can find it without guessing the port. */
export function bridgeUrlAnnouncement(url) {
  return `${BRIDGE_URL_PREFIX}${url}`;
}

/**
 * Pull the announced URL out of one stdout line. Returns "" for anything else, so a host can scan
 * a stream without treating a crash message as a port.
 */
export function parseBridgeUrlLine(line) {
  const text2 = typeof line === "string" ? line : "";
  const start = text2.indexOf(BRIDGE_URL_PREFIX);
  if (start < 0) {
    return "";
  }
  return text2.slice(start + BRIDGE_URL_PREFIX.length).trim().split(/\s+/)[0] ?? "";
}

/**
 * Scan a child's output for the announcement. Chunk boundaries are arbitrary, and a host must
 * never open its window on a port it invented - a timeout says so out loud instead of showing a
 * white screen (which is how the pinned-6474 bug hid).
 */
export function createBridgeUrlWatcher({ timeoutMs = 20000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let resolveUrl;
  let rejectUrl;
  let settled = false;
  let pending = "";
  const promise = new Promise((resolve, reject) => {
    resolveUrl = resolve;
    rejectUrl = reject;
  });
  const timer = setTimer(() => {
    fail(new Error(`the bridge did not announce its port within ${timeoutMs}ms`));
  }, timeoutMs);

  function fail(error) {
    if (settled) {
      return false;
    }
    settled = true;
    clearTimer(timer);
    rejectUrl(error);
    return true;
  }

  return {
    promise,
    /** Feed raw stdout: keeps a partial line between chunks. Returns the url when complete. */
    feed(chunk) {
      if (settled) {
        return "";
      }
      pending += typeof chunk === "string" ? chunk : String(chunk ?? "");
      let newline;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        const url = parseBridgeUrlLine(line);
        if (url) {
          settled = true;
          clearTimer(timer);
          resolveUrl(url);
          return url;
        }
      }
      return "";
    },
    /** The child died without announcing: surface it rather than hanging the host. */
    closed(reason) {
      return fail(new Error(`bridge exited before announcing its port${reason ? `: ${reason}` : ""}`));
    },
    dispose() {
      fail(new Error("bridge url watcher disposed"));
    },
  };
}

