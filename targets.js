export function normalizeAccess(value) {
  const v = String(value || "read").toLowerCase();
  return ["read", "readwrite", "full"].includes(v) ? v : "read";
}

function applyTemplate(str, subs) {
  return String(str == null ? "" : str).replace(/\{(\w+)\}/g, (match, key) => (subs[key] !== undefined ? subs[key] : match));
}

function cartesian(axes) {
  return axes.reduce((acc, axis) => acc.flatMap((prefix) => axis.map((item) => prefix.concat([item]))), [[]]);
}

export function expandTemplate(tpl) {
  const vars = tpl.variables || {};
  const names = Object.keys(vars);
  const axes = names.map((n) => {
    const v = vars[n];
    if (Array.isArray(v)) return v.map((value) => ({ value: String(value), override: {} }));
    return Object.entries(v).map(([value, override]) => ({ value, override: override || {} }));
  });
  const combos = names.length ? cartesian(axes) : [[]];
  return combos.map((combo) => {
    const subs = {};
    let override = {};
    names.forEach((n, i) => {
      subs[n] = combo[i].value;
      override = Object.assign({}, override, combo[i].override);
    });
    const name = applyTemplate(tpl.nameTemplate || names.map((n) => subs[n]).join("-"), subs);
    const conn = {
      host: applyTemplate(tpl.hostTemplate, subs),
      database: applyTemplate(tpl.databaseTemplate, subs),
      port: override.port ?? tpl.port,
      auth: {
        type: (tpl.auth && tpl.auth.type) || "sql",
        user: override.user ?? (tpl.auth && tpl.auth.user),
        password: override.password ?? (tpl.auth && tpl.auth.password)
      },
      access: override.access || tpl.access,
      options: tpl.options
    };
    return { name, conn };
  });
}

function normalizeTarget(name, conn, defaults) {
  const auth = conn.auth || {};
  const dauth = defaults.auth || {};
  return {
    name,
    host: conn.host,
    port: conn.port || defaults.port || 1433,
    database: conn.database,
    user: auth.user ?? conn.user ?? dauth.user,
    password: auth.password ?? conn.password ?? dauth.password,
    access: normalizeAccess(conn.access || defaults.access || "read"),
    options: conn.options || defaults.options || { encrypt: true, trustServerCertificate: false }
  };
}

export function buildTargets(cfg) {
  const map = new Map();
  const defaults = cfg.defaults || {};
  for (const [name, conn] of Object.entries(cfg.connections || {})) {
    map.set(name, normalizeTarget(name, conn, defaults));
  }
  for (const tpl of cfg.templates || []) {
    for (const { name, conn } of expandTemplate(tpl)) {
      if (name) map.set(name, normalizeTarget(name, conn, defaults));
    }
  }
  return map;
}
