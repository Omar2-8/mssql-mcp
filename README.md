# mssql-explorer-mcp

A Model Context Protocol (MCP) server for querying SQL Server / Azure SQL databases from Claude. Define any number of named connections (directly or from a naming template), set a read / read-write / full access level per connection, and optionally have the server detect or bring up a VPN before connecting.

## Tools

- `list_connections` — list configured connections and their access level.
- `list_tables` — list base tables for a connection.
- `describe_table` — list columns of a table for a connection.
- `get_schema` — full schema for a connection in one call: tables, columns (type, nullability, IDENTITY, PK, defaults) and foreign keys; optional table filter. Prefer this over repeated `describe_table` calls.
- `search_schema` — find tables/columns by name pattern across one, several, or all connections in a single call; unreachable connections are reported per entry, not fatal.
- `run_query` — run SQL against a connection; allowed statements depend on that connection's access level. Multi-statement batches (full access) return every result set.
- `run_batch` — run up to 20 queries, each against its own connection, in parallel in one call; per-query access enforcement and error reporting. Useful for cross-environment checks.

Connectivity probes are cached (`vpn.probeCacheMs`, default 5 minutes), so repeated calls skip the VPN reachability check.

## Requirements

- Node.js 18+.
- Network access to the target SQL servers (directly, or via the optional VPN feature).

## Quick setup (recommended)

```bash
npm install
npm run setup
```

`npm run setup` opens a local page in your browser. There you define your connections (name, host, database, credentials, access level), test each one with a real connection check, configure the VPN, save your `db.config.json`, and connect the server to Claude Desktop with one click. Nothing you enter leaves your machine.

After clicking **Connect to Claude Desktop**, fully quit and reopen Claude Desktop so it picks up the server.

## Manual setup

```bash
npm install
cp db.config.example.json db.config.json
```

Edit `db.config.json` (see below). `db.config.json` is gitignored and must never be committed. By default the server looks for it next to `server.js`; override with `DBCONFIG_PATH`.

Then add the server to Claude Desktop's `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mssql-explorer": {
      "command": "node",
      "args": ["/absolute/path/to/server.js"],
      "env": { "DBCONFIG_PATH": "/absolute/path/to/db.config.json" }
    }
  }
}
```

## Configuration

Connections can be defined explicitly, generated from templates, or both. Both are merged into a flat set of named connections.

### defaults

Applied to any connection that doesn't set its own value.

```json
"defaults": { "port": 1433, "access": "read", "options": { "encrypt": true, "trustServerCertificate": false } }
```

### connections (explicit)

Each entry is a self-contained connection with any name you choose.

```json
"connections": {
  "my-app-dev": {
    "host": "server.database.windows.net",
    "database": "AppDatabase",
    "auth": { "type": "sql", "user": "username", "password": "secret" },
    "access": "readwrite"
  }
}
```

### templates (optional)

Generate many connections from a naming pattern. `{var}` placeholders are substituted from `variables`. A variable is either a list of values, or a map of value to per-value overrides (such as a password or access level).

```json
"templates": [
  {
    "nameTemplate": "{module}/{env}",
    "hostTemplate": "sql-{env}.database.windows.net",
    "databaseTemplate": "db-{module}-{env}",
    "auth": { "type": "sql", "user": "username" },
    "access": "read",
    "variables": {
      "env": { "dev": { "password": "secret", "access": "readwrite" }, "prod": { "password": "secret" } },
      "module": ["orders", "inventory"]
    }
  }
]
```

The example above produces four connections: `orders/dev`, `orders/prod`, `inventory/dev`, `inventory/prod`.

## Access levels

Set per connection (or as a default). `run_query` enforces them:

- `read` — `SELECT` / `WITH` only. Single statement.
- `readwrite` — also `INSERT` / `UPDATE` / `DELETE` / `MERGE`. Single statement. No DDL or `EXEC`.
- `full` — also DDL (`CREATE` / `DROP` / `ALTER` / `TRUNCATE`), `EXEC`, and stored procedures. Multiple statements allowed.

## VPN

The `vpn.mode` setting controls network handling:

- `none` — the database is directly reachable; do nothing.
- `wait` — before connecting, probe the database; if it is unreachable, return a clear "connect your VPN" message. Use this when you connect the VPN yourself (for example the **Azure VPN Client** for Entra ID / OAuth P2S, which requires an interactive sign-in with MFA that cannot be automated). The server keeps probing until the tunnel is up or the timeout is reached.
- `command` — before connecting, run a configured command to bring up the VPN, then probe until reachable. For OAuth VPNs this launches the client and a sign-in / MFA window appears for you to complete; for certificate-based VPNs it can connect non-interactively.

```json
"vpn": {
  "mode": "wait",
  "connectCommand": ["azurevpn", "-c", "C:\\path\\profile.xml", "-n", "MyVPN"],
  "disconnectCommand": [],
  "probeTarget": { "host": "", "port": 1433 },
  "connectTimeoutMs": 120000,
  "probeTimeoutMs": 3000,
  "probeIntervalMs": 2000
}
```

Notes:

- **Entra ID / OAuth VPNs cannot be fully automated.** MFA sign-in requires a human. `wait` (you connect manually) is the most robust; `command` triggers the sign-in window then waits.
- `probeTarget` is optional; if omitted, each connection's own host/port is probed.
- Environment overrides: `VPN_MODE`, `VPN_PROBE_HOST`, `VPN_PROBE_PORT`, `VPN_CONNECT_TIMEOUT_MS`.
- VPN profiles, certificates, and keys must never be committed. They are gitignored.

## Security

- **Never commit secrets.** `db.config.json`, `.env`, VPN profiles, certificates and keys are gitignored. Use `db.config.example.json` as the public template.
- **Rotate credentials before publishing.** If real credentials were ever committed in the past, they remain in git history even after being removed. Rotate any password that has been in a tracked file, and consider rewriting history or publishing a fresh repository.
- **Prefer Entra ID (Azure AD) auth** over SQL passwords where possible.
- Give each connection the least access it needs; keep production connections `read`.

## License

Add a license before publishing.
