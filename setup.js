import { createServer } from "http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { homedir, platform } from "os";
import { spawn } from "child_process";
import sql from "mssql";
import { buildTargets } from "./targets.js";

const here = dirname(fileURLToPath(import.meta.url));
const dbConfigPath = process.env.DBCONFIG_PATH || join(here, "db.config.json");
const examplePath = join(here, "db.config.example.json");
const serverPath = join(here, "server.js");
const htmlPath = join(here, "setup.html");
const port = Number(process.env.SETUP_PORT || 4599);

function claudeConfigPath() {
  const p = platform();
  if (p === "win32") return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  if (p === "darwin") return join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  return join(homedir(), ".config", "Claude", "claude_desktop_config.json");
}

function loadConfig() {
  const path = existsSync(dbConfigPath) ? dbConfigPath : examplePath;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function readClaudeConfig() {
  const p = claudeConfigPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

function isRegistered() {
  const c = readClaudeConfig();
  return Boolean(c.mcpServers && c.mcpServers["mssql-explorer"]);
}

function register() {
  const p = claudeConfigPath();
  mkdirSync(dirname(p), { recursive: true });
  const c = readClaudeConfig();
  if (!c.mcpServers) c.mcpServers = {};
  c.mcpServers["mssql-explorer"] = { command: "node", args: [serverPath], env: { DBCONFIG_PATH: dbConfigPath } };
  writeFileSync(p, JSON.stringify(c, null, 2));
  return p;
}

function snippet() {
  return { mcpServers: { "mssql-explorer": { command: "node", args: [serverPath], env: { DBCONFIG_PATH: dbConfigPath } } } };
}

async function testConnection(t) {
  const pool = new sql.ConnectionPool({
    server: t.host,
    port: Number(t.port) || 1433,
    database: t.database || undefined,
    user: t.user,
    password: t.password,
    options: t.options || { encrypt: true, trustServerCertificate: false },
    connectionTimeout: 8000,
    requestTimeout: 8000,
    pool: { max: 1, min: 0 }
  });
  try {
    await pool.connect();
    await pool.request().query("SELECT 1 AS ok");
    await pool.close();
    return { ok: true };
  } catch (error) {
    try { await pool.close(); } catch {}
    return { ok: false, error: error.message };
  }
}

function previewTargets(cfg) {
  return [...buildTargets(cfg).values()].map((t) => ({
    name: t.name,
    host: t.host,
    database: t.database,
    port: t.port,
    user: t.user,
    hasPassword: Boolean(t.password),
    access: t.access
  }));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => resolve(data));
  });
}

function sendJson(res, code, payload) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(readFileSync(htmlPath, "utf8"));
      return;
    }
    if (req.method === "GET" && req.url === "/api/state") {
      sendJson(res, 200, {
        config: loadConfig(),
        claudeConfigPath: claudeConfigPath(),
        serverPath,
        dbConfigPath,
        registered: isRegistered(),
        snippet: snippet()
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/save") {
      const body = JSON.parse((await readBody(req)) || "{}");
      writeFileSync(dbConfigPath, JSON.stringify(body, null, 2));
      sendJson(res, 200, { ok: true, path: dbConfigPath });
      return;
    }
    if (req.method === "POST" && req.url === "/api/register") {
      const path = register();
      sendJson(res, 200, { ok: true, path });
      return;
    }
    if (req.method === "POST" && req.url === "/api/preview") {
      const body = JSON.parse((await readBody(req)) || "{}");
      sendJson(res, 200, { ok: true, targets: previewTargets(body) });
      return;
    }
    if (req.method === "POST" && req.url === "/api/test") {
      const body = JSON.parse((await readBody(req)) || "{}");
      let target = body;
      if (body.config && body.name) {
        target = buildTargets(body.config).get(body.name);
        if (!target) { sendJson(res, 200, { ok: false, error: `Unknown connection '${body.name}'` }); return; }
      }
      const result = await testConnection(target);
      sendJson(res, 200, result);
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error.message });
  }
});

function openBrowser(url) {
  const p = platform();
  const cmd = p === "win32" ? "cmd" : p === "darwin" ? "open" : "xdg-open";
  const args = p === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {}
}

server.listen(port, () => {
  const url = `http://localhost:${port}`;
  console.log(`Setup UI running at ${url}`);
  console.log("Press Ctrl+C to stop.");
  openBrowser(url);
});
