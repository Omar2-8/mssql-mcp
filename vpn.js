import { spawn } from "child_process";
import net from "net";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function checkReachable(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

function resolveVpn(config) {
  const base = config.vpn || {};
  const mode = String(process.env.VPN_MODE || base.mode || "none").toLowerCase();
  return {
    mode,
    connectCommand: base.connectCommand || null,
    disconnectCommand: base.disconnectCommand || null,
    probeHost: process.env.VPN_PROBE_HOST || (base.probeTarget && base.probeTarget.host) || null,
    probePort: Number(process.env.VPN_PROBE_PORT || (base.probeTarget && base.probeTarget.port) || 0) || null,
    connectTimeoutMs: Number(process.env.VPN_CONNECT_TIMEOUT_MS || base.connectTimeoutMs || 120000),
    probeTimeoutMs: Number(base.probeTimeoutMs || 3000),
    probeIntervalMs: Number(base.probeIntervalMs || 2000),
    probeCacheMs: Number(base.probeCacheMs || 300000)
  };
}

const probeCache = new Map();

let connectPromise = null;
let vpnProcess = null;
let disconnectCommand = null;

function launch(command) {
  const [cmd, ...args] = command;
  const child = spawn(cmd, args, { stdio: "ignore", windowsHide: true });
  child.once("exit", () => { if (vpnProcess === child) vpnProcess = null; });
  child.once("error", () => { if (vpnProcess === child) vpnProcess = null; });
  vpnProcess = child;
  return child;
}

export async function ensureVpn(config, targetHost, targetPort = 1433) {
  const s = resolveVpn(config);
  if (s.mode === "none") return;
  const host = s.probeHost || targetHost;
  const port = s.probePort || targetPort;
  const cacheKey = `${host}:${port}`;
  const lastOk = probeCache.get(cacheKey);
  if (lastOk && Date.now() - lastOk < s.probeCacheMs) return;
  if (await checkReachable(host, port, s.probeTimeoutMs)) { probeCache.set(cacheKey, Date.now()); return; }
  probeCache.delete(cacheKey);
  if (s.mode === "command") {
    if (!Array.isArray(s.connectCommand) || s.connectCommand.length === 0) {
      throw new Error("vpn.mode is 'command' but vpn.connectCommand is not set.");
    }
    disconnectCommand = Array.isArray(s.disconnectCommand) && s.disconnectCommand.length ? s.disconnectCommand : null;
    if (!connectPromise) connectPromise = Promise.resolve().then(() => launch(s.connectCommand));
    await connectPromise;
  }
  const deadline = Date.now() + s.connectTimeoutMs;
  while (Date.now() < deadline) {
    if (await checkReachable(host, port, s.probeTimeoutMs)) { probeCache.set(cacheKey, Date.now()); return; }
    await delay(s.probeIntervalMs);
  }
  if (s.mode === "wait") {
    throw new Error(`Cannot reach ${host}:${port}. Connect your VPN (e.g. the Azure VPN Client, completing sign-in and MFA) and try again.`);
  }
  throw new Error(`VPN did not establish connectivity to ${host}:${port} within ${s.connectTimeoutMs}ms.`);
}

export function stopVpn() {
  const child = vpnProcess;
  const disconnect = disconnectCommand;
  vpnProcess = null;
  connectPromise = null;
  disconnectCommand = null;
  probeCache.clear();
  if (child) {
    try { child.kill(); } catch {}
  }
  if (Array.isArray(disconnect) && disconnect.length) {
    try { spawn(disconnect[0], disconnect.slice(1), { stdio: "ignore", windowsHide: true }).unref(); } catch {}
  }
}
