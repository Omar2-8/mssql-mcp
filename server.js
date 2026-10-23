import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import sql from "mssql";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { ensureVpn, stopVpn } from "./vpn.js";
import { buildTargets } from "./targets.js";

const configPath = process.env.DBCONFIG_PATH || join(dirname(fileURLToPath(import.meta.url)), "db.config.json");
const config = JSON.parse(readFileSync(configPath, "utf8"));

const pools = new Map();

const targets = buildTargets(config);

function getTarget(name) {
  const t = targets.get(name);
  if (!t) throw new Error(`Unknown connection '${name}'. Available: ${[...targets.keys()].join(", ")}`);
  return t;
}

function createPool(t) {
  const pool = new sql.ConnectionPool({
    server: t.host,
    port: t.port,
    database: t.database,
    user: t.user,
    password: t.password,
    options: t.options,
    pool: { max: 4, min: 0, idleTimeoutMillis: 30000 },
    connectionTimeout: 30000,
    requestTimeout: 60000
  });
  return pool.connect().then(() => pool).catch((err) => { pools.delete(t.name); throw err; });
}

async function getPool(name) {
  const t = getTarget(name);
  await ensureVpn(config, t.host, t.port);
  if (!pools.has(name)) pools.set(name, createPool(t));
  return pools.get(name);
}

function enforceAccess(rawQuery, access) {
  const query = String(rawQuery || "").trim().replace(/;+\s*$/, "");
  if (query.length === 0) throw new Error("sql is required.");
  const multi = /;/.test(query);
  const isRead = /^(select|with)\b/i.test(query);
  const dml = /\b(insert|update|delete|merge)\b/i.test(query);
  const ddl = /\b(create|drop|alter|truncate|grant|revoke|backup|restore)\b/i.test(query);
  const exec = /\b(exec|execute)\b/i.test(query) || /\b(sp_|xp_)/i.test(query);
  if (access === "read") {
    if (multi) throw new Error("Read-only connection: only a single statement is allowed.");
    if (!isRead || dml || ddl || exec) throw new Error("Read-only connection: only SELECT/WITH queries are allowed.");
    return { query, expectRows: true };
  }
  if (access === "readwrite") {
    if (multi) throw new Error("Read-write connection: only a single statement is allowed.");
    if (ddl) throw new Error("Read-write connection: DDL (CREATE/DROP/ALTER/TRUNCATE) requires a full-access connection.");
    if (exec) throw new Error("Read-write connection: EXEC/stored procedures require a full-access connection.");
    return { query, expectRows: isRead };
  }
  return { query, expectRows: isRead };
}

function asText(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function formatType(c) {
  const t = c.typ;
  if (["nvarchar", "nchar"].includes(t)) return `${t}(${c.len === -1 ? "MAX" : c.len / 2})`;
  if (["varchar", "char", "binary", "varbinary"].includes(t)) return `${t}(${c.len === -1 ? "MAX" : c.len})`;
  if (["decimal", "numeric"].includes(t)) return `${t}(${c.prec},${c.scal})`;
  return t;
}

function formatColumn(c) {
  let s = `${c.col} ${formatType(c)}`;
  if (c.ident) s += " IDENTITY";
  if (c.pk) s += " PK";
  if (c.nul) s += " NULL";
  if (c.dflt && c.dflt.length <= 40) s += ` DEFAULT ${c.dflt}`;
  return s;
}

async function getSchema(pool, target, tablesFilter, schemaName) {
  const req = pool.request();
  let where = "1=1";
  if (schemaName) { req.input("sch", sql.NVarChar, schemaName); where += " AND s.name = @sch"; }
  if (Array.isArray(tablesFilter) && tablesFilter.length) {
    const names = tablesFilter.map((t, i) => { req.input(`t${i}`, sql.NVarChar, String(t)); return `@t${i}`; });
    where += ` AND t.name IN (${names.join(",")})`;
  }
  const cols = await req.query(`
    SELECT s.name AS sch, t.name AS tbl, c.name AS col, ty.name AS typ, c.max_length AS len, c.precision AS prec, c.scale AS scal,
           c.is_nullable AS nul, c.is_identity AS ident, dc.definition AS dflt,
           CASE WHEN pkc.column_id IS NOT NULL THEN 1 ELSE 0 END AS pk
    FROM sys.tables t
    JOIN sys.schemas s ON s.schema_id = t.schema_id
    JOIN sys.columns c ON c.object_id = t.object_id
    JOIN sys.types ty ON ty.user_type_id = c.user_type_id
    LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id
    LEFT JOIN (
      SELECT ic.object_id, ic.column_id
      FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
      WHERE i.is_primary_key = 1
    ) pkc ON pkc.object_id = t.object_id AND pkc.column_id = c.column_id
    WHERE ${where}
    ORDER BY s.name, t.name, c.column_id`);
  const fks = await pool.request().query(`
    SELECT sp.name AS sch, tp.name AS tbl, cp.name AS col, sr.name AS rsch, tr.name AS rtbl, cr.name AS rcol
    FROM sys.foreign_key_columns fkc
    JOIN sys.tables tp ON tp.object_id = fkc.parent_object_id
    JOIN sys.schemas sp ON sp.schema_id = tp.schema_id
    JOIN sys.columns cp ON cp.object_id = fkc.parent_object_id AND cp.column_id = fkc.parent_column_id
    JOIN sys.tables tr ON tr.object_id = fkc.referenced_object_id
    JOIN sys.schemas sr ON sr.schema_id = tr.schema_id
    JOIN sys.columns cr ON cr.object_id = fkc.referenced_object_id AND cr.column_id = fkc.referenced_column_id`);
  const fkMap = new Map();
  for (const f of fks.recordset) {
    const key = `${f.sch}.${f.tbl}`;
    if (!fkMap.has(key)) fkMap.set(key, []);
    fkMap.get(key).push(`${f.col} -> ${f.rsch}.${f.rtbl}.${f.rcol}`);
  }
  const tables = new Map();
  for (const c of cols.recordset) {
    const key = `${c.sch}.${c.tbl}`;
    if (!tables.has(key)) tables.set(key, { table: key, columns: [], foreignKeys: fkMap.get(key) || [] });
    tables.get(key).columns.push(formatColumn(c));
  }
  return { connection: target.name, database: target.database, tables: [...tables.values()] };
}

function capRows(rows, maxRows) {
  const cap = Math.min(Math.max(Number(maxRows) || 100, 1), 5000);
  return { totalRows: rows.length, returnedRows: Math.min(rows.length, cap), rows: rows.slice(0, cap) };
}

function shapeResult(target, result, expectRows, maxRows) {
  const base = { connection: target.name, database: target.database, access: target.access };
  const sets = (result.recordsets || []).map((rs) => capRows(rs || [], maxRows));
  if (!expectRows) {
    const out = { ...base, rowsAffected: result.rowsAffected };
    if (sets.length === 1) Object.assign(out, sets[0]);
    else if (sets.length > 1) out.resultSets = sets;
    return out;
  }
  if (sets.length <= 1) return { ...base, ...(sets[0] || capRows([], maxRows)) };
  return { ...base, resultSets: sets };
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

async function searchConnection(name, pattern, maxPerConnection) {
  const target = getTarget(name);
  const pool = await getPool(name);
  const req = pool.request().input("p", sql.NVarChar, `%${pattern}%`);
  const result = await req.query(`
    SELECT TOP ${maxPerConnection} s.name AS sch, t.name AS tbl, NULL AS col FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id WHERE t.name LIKE @p
    UNION ALL
    SELECT TOP ${maxPerConnection} s.name, t.name, c.name FROM sys.columns c JOIN sys.tables t ON t.object_id = c.object_id JOIN sys.schemas s ON s.schema_id = t.schema_id WHERE c.name LIKE @p
    ORDER BY sch, tbl, col`);
  const tables = [];
  const columns = [];
  for (const r of result.recordset) {
    if (r.col == null) tables.push(`${r.sch}.${r.tbl}`);
    else columns.push(`${r.sch}.${r.tbl}.${r.col}`);
  }
  return { connection: target.name, database: target.database, tables, columns };
}

const connectionEnum = [...targets.keys()];

const tools = [
  { name: "list_connections", description: "List available database connections and their access level (read, readwrite, full).", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "list_tables", description: "List base tables for a connection.", inputSchema: { type: "object", properties: { connection: { type: "string", enum: connectionEnum } }, required: ["connection"], additionalProperties: false } },
  { name: "describe_table", description: "List columns of a table for a connection.", inputSchema: { type: "object", properties: { connection: { type: "string", enum: connectionEnum }, table: { type: "string" }, schema: { type: "string" } }, required: ["connection", "table"], additionalProperties: false } },
  { name: "get_schema", description: "Full schema for a connection in one call: every table with columns (type, nullability, IDENTITY, PK, defaults) and foreign keys. Optionally filter to specific tables. Prefer this over repeated describe_table calls.", inputSchema: { type: "object", properties: { connection: { type: "string", enum: connectionEnum }, tables: { type: "array", items: { type: "string" } }, schema: { type: "string" } }, required: ["connection"], additionalProperties: false } },
  { name: "search_schema", description: "Find tables and columns whose name matches a pattern, across one, several, or all connections in a single call. Use this to locate which database holds something instead of exploring connections one by one. Returns per-connection matches; connections that fail (VPN, auth) are reported, not fatal.", inputSchema: { type: "object", properties: { pattern: { type: "string" }, connections: { type: "array", items: { type: "string", enum: connectionEnum } }, maxPerConnection: { type: "number" } }, required: ["pattern"], additionalProperties: false } },
  { name: "run_query", description: "Run SQL against a connection. Allowed statements depend on the connection access level: read = SELECT/WITH only; readwrite = also INSERT/UPDATE/DELETE/MERGE; full = also DDL, EXEC, and multi-statement batches. Multi-statement batches return every result set, so prefer one batched call over several calls.", inputSchema: { type: "object", properties: { connection: { type: "string", enum: connectionEnum }, sql: { type: "string" }, maxRows: { type: "number" } }, required: ["connection", "sql"], additionalProperties: false } },
  { name: "run_batch", description: "Run several queries, each against its own connection, in parallel in a single call. Use for cross-database or cross-environment work (e.g. the same check on dev/uat/ppd/prd, or a lookup in one DB plus a write in another). Per-query access enforcement; failures are reported per query, not fatal.", inputSchema: { type: "object", properties: { queries: { type: "array", items: { type: "object", properties: { connection: { type: "string", enum: connectionEnum }, sql: { type: "string" }, maxRows: { type: "number" } }, required: ["connection", "sql"], additionalProperties: false }, minItems: 1, maxItems: 20 } }, required: ["queries"], additionalProperties: false } }
];

const instructions = "Minimize round trips: call get_schema once per connection instead of repeated describe_table calls (it includes IDENTITY, PK, FK, defaults); use search_schema to find which connection holds a table or column; use run_batch for queries spanning multiple connections; on full-access connections combine statements into one run_query call, every result set is returned.";

const server = new Server({ name: "mssql-explorer", version: "3.2.0" }, { capabilities: { tools: {} }, instructions });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    if (name === "list_connections") {
      return asText([...targets.values()].map((t) => ({ connection: t.name, host: t.host, database: t.database, access: t.access })));
    }

    if (name === "search_schema") {
      const pattern = String(args?.pattern || "").trim();
      if (!pattern) throw new Error("pattern is required.");
      const maxPer = Math.min(Math.max(Number(args?.maxPerConnection) || 50, 1), 500);
      const names = Array.isArray(args?.connections) && args.connections.length ? args.connections : [...targets.keys()];
      const results = await mapLimit(names, 6, async (n) => {
        try { return await searchConnection(n, pattern, maxPer); }
        catch (err) { return { connection: n, error: err.message }; }
      });
      const hits = results.filter((r) => (r.tables && r.tables.length) || (r.columns && r.columns.length));
      const errors = results.filter((r) => r.error);
      return asText({ pattern, searched: names.length, matches: hits, errors });
    }

    if (name === "run_batch") {
      const queries = args?.queries;
      if (!Array.isArray(queries) || !queries.length) throw new Error("queries is required.");
      if (queries.length > 20) throw new Error("Maximum 20 queries per batch.");
      const results = await mapLimit(queries, 6, async (q) => {
        try {
          const t = getTarget(q?.connection);
          const { query, expectRows } = enforceAccess(q?.sql, t.access);
          const p = await getPool(q.connection);
          const result = await p.request().query(query);
          return { ok: true, ...shapeResult(t, result, expectRows, q?.maxRows) };
        } catch (err) {
          return { ok: false, connection: q?.connection, error: err.message };
        }
      });
      return asText({ results });
    }

    const target = getTarget(args?.connection);
    const pool = await getPool(args?.connection);

    if (name === "list_tables") {
      const result = await pool.request().query("SELECT TABLE_SCHEMA, TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_SCHEMA, TABLE_NAME");
      return asText(result.recordset);
    }

    if (name === "describe_table") {
      if (!args?.table) throw new Error("table is required.");
      const result = await pool.request()
        .input("schema", sql.NVarChar, args?.schema || "dbo")
        .input("table", sql.NVarChar, args.table)
        .query("SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @schema AND TABLE_NAME = @table ORDER BY ORDINAL_POSITION");
      return asText(result.recordset);
    }

    if (name === "get_schema") {
      return asText(await getSchema(pool, target, args?.tables, args?.schema));
    }

    if (name === "run_query") {
      const { query, expectRows } = enforceAccess(args?.sql, target.access);
      const result = await pool.request().query(query);
      return asText(shapeResult(target, result, expectRows, args?.maxRows));
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (error) {
    return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
  }
});

for (const signal of ["exit", "SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopVpn();
    if (signal !== "exit") process.exit(0);
  });
}

const transport = new StdioServerTransport();
await server.connect(transport);
