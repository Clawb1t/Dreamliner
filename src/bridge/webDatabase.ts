import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  getTableName,
  like,
  or,
  sql,
  type Column,
  type SQL,
} from "drizzle-orm";
import { getTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core";
import { getDb } from "../db/client.js";
import * as schema from "../db/schema.js";

export type DbColumnMeta = {
  name: string;
  label: string;
  type: "string" | "number" | "boolean" | "datetime" | "json";
  searchable?: boolean;
};

export type DbTableMeta = {
  name: string;
  label: string;
  description: string;
  primaryKey: string[];
  columns: DbColumnMeta[];
  rowCount: number;
};

type TableDef = {
  name: string;
  label: string;
  description: string;
  table: SQLiteTable;
  guildId: Column;
  /** JS property names that form the row key (excluding guildId when composite). */
  keyFields: string[];
  columns: Array<DbColumnMeta & { column: Column; redact?: "omit" }>;
  defaultOrder?: { field: string; dir: "asc" | "desc" };
};

const LIST_PREVIEW_LEN = 180;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Optional nicer labels/descriptions; everything else is auto-discovered. */
const TABLE_META: Record<string, { label?: string; description?: string }> = {
  guild_configs: {
    label: "Guild config",
    description: "Stored YAML config snapshots for this server.",
  },
  mod_cases: {
    label: "Mod cases",
    description: "Infractions and moderation case history.",
  },
  tags: {
    label: "Tags",
    description: "Saved tag responses for this server.",
  },
  dream_commands: {
    label: "Custom commands",
    description: "Custom slash commands built on the dashboard.",
  },
  guild_log_events: {
    label: "Log events",
    description: "Persisted audit log events.",
  },
  welcome_join_messages: {
    label: "Welcome join messages",
    description: "Tracked join welcomes for wave tallies and early-leave deletes.",
  },
  passport_pending: {
    label: "Passport pending",
    description: "Members waiting to complete Passport verification.",
  },
  passport_verifications: {
    label: "Passport verifications",
    description: "Completed Passport verifications for this server.",
  },
  suggestions: {
    label: "Suggestions",
    description: "Community suggestions with review queue and voting.",
  },
  bot_avatar_requests: {
    label: "Bot brand requests",
    description: "Pending and resolved bot avatar/banner change requests.",
  },
  bot_guild_profiles: {
    label: "Bot guild profiles",
    description: "Stored per-server bot bio and related brand state.",
  },
  economy_global_accounts: {
    label: "Economy global accounts",
    description: "Bot-wide coin balances, earned by messages and daily claims.",
  },
  economy_server_accounts: {
    label: "Economy server accounts",
    description: "Per-guild currency balances, earned by messages and daily claims.",
  },
};

const OMIT_COLUMNS = new Set(["avatarPng", "avatar_png"]);

function humanize(name: string): string {
  return name
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function isSqliteTable(value: unknown): value is SQLiteTable {
  if (!value || typeof value !== "object") return false;
  try {
    getTableConfig(value as SQLiteTable);
    return true;
  } catch {
    return false;
  }
}

function detectType(jsName: string, column: Column): DbColumnMeta["type"] {
  const dataType = String((column as { dataType?: string }).dataType ?? "string");
  if (dataType === "boolean") return "boolean";
  if (dataType === "date") return "datetime";
  if (dataType === "json") return "json";
  if (dataType === "number") {
    if (/At$|at$|Date$|date$|Time$|time$/.test(jsName)) return "datetime";
    return "number";
  }
  if (
    /Json$|json$|payload|metadata|configYaml|userConfigYaml|defaultsSnapshotYaml|source$|definitionJson/i.test(
      jsName,
    )
  ) {
    return "json";
  }
  return "string";
}

function shouldOmit(jsName: string, sqlName: string): boolean {
  if (OMIT_COLUMNS.has(jsName) || OMIT_COLUMNS.has(sqlName)) return true;
  return /(?:^|_)(?:png|blob|binary|image_data)(?:$|_)/i.test(sqlName) || /Png$|Blob$/.test(jsName);
}

function isSearchable(type: DbColumnMeta["type"], jsName: string): boolean {
  if (type === "boolean" || type === "datetime") return false;
  if (shouldOmit(jsName, jsName)) return false;
  return true;
}

function pickDefaultOrder(keyFields: string[], columnNames: string[]): TableDef["defaultOrder"] {
  for (const candidate of ["updatedAt", "createdAt", "changedAt", "id", "suggestionNumber"]) {
    if (columnNames.includes(candidate)) {
      return { field: candidate, dir: "desc" };
    }
  }
  if (keyFields.includes("name")) return { field: "name", dir: "asc" };
  const first = keyFields[0] ?? columnNames[0];
  return first ? { field: first, dir: "asc" } : undefined;
}

function resolvePrimaryKeyFields(
  table: SQLiteTable,
  entries: Array<[string, Column]>,
): string[] {
  const bySqlName = new Map(entries.map(([js, column]) => [column.name, js]));

  // Inline `.primaryKey()` columns
  const inline = entries.filter(([, column]) => Boolean(column.primary)).map(([js]) => js);

  // Composite keys from `primaryKey({ columns: [...] })` (column.primary is false here)
  let composite: string[] = [];
  try {
    const cfg = getTableConfig(table);
    composite = (cfg.primaryKeys ?? []).flatMap((pk) =>
      pk.columns
        .map((column) => bySqlName.get(column.name))
        .filter((js): js is string => Boolean(js)),
    );
  } catch {
    composite = [];
  }

  const primaryJsNames = Array.from(new Set([...inline, ...composite]));
  let keyFields = primaryJsNames.filter((js) => js !== "guildId");
  if (keyFields.length === 0) {
    keyFields = primaryJsNames.length > 0 ? primaryJsNames : ["guildId"];
  }
  return keyFields;
}

function buildTableDef(table: SQLiteTable): TableDef | null {
  const columnsMap = getTableColumns(table);
  const guildId = (columnsMap as Record<string, Column | undefined>).guildId;
  if (!guildId) return null;

  const name = getTableName(table);
  const entries = Object.entries(columnsMap) as Array<[string, Column]>;
  const keyFields = resolvePrimaryKeyFields(table, entries);

  const columns: TableDef["columns"] = entries.map(([jsName, column]) => {
    const type = detectType(jsName, column);
    const omit = shouldOmit(jsName, column.name);
    return {
      column,
      name: jsName,
      label: humanize(jsName),
      type: omit ? "string" : type,
      searchable: !omit && isSearchable(type, jsName),
      redact: omit ? ("omit" as const) : undefined,
    };
  });

  const meta = TABLE_META[name] ?? {};
  const columnNames = columns.map((c) => c.name);

  return {
    name,
    label: meta.label ?? humanize(name),
    description: meta.description ?? `Auto-discovered table \`${name}\`.`,
    table,
    guildId,
    keyFields,
    columns,
    defaultOrder: pickDefaultOrder(keyFields, columnNames),
  };
}

function buildCatalog(): TableDef[] {
  const defs: TableDef[] = [];
  const seen = new Set<string>();

  for (const value of Object.values(schema)) {
    if (!isSqliteTable(value)) continue;
    const def = buildTableDef(value);
    if (!def || seen.has(def.name)) continue;
    seen.add(def.name);
    defs.push(def);
  }

  defs.sort((a, b) => a.label.localeCompare(b.label));
  return defs;
}

/** Rebuilt from schema on each access so new tables appear without a catalog edit. */
function getCatalog(): TableDef[] {
  return buildCatalog();
}

function getTable(tableName: string): TableDef | null {
  return getCatalog().find((entry) => entry.name === tableName) ?? null;
}

function serializeValue(
  value: unknown,
  meta: TableDef["columns"][number],
  mode: "list" | "detail",
): unknown {
  if (value == null) return null;
  if (meta.redact === "omit") {
    const bytes =
      typeof value === "string" ? Buffer.byteLength(value, "utf8") : String(value).length;
    return { omitted: true, bytes };
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "boolean" || typeof value === "number") return value;

  if (mode === "detail") {
    if (meta.type === "json" && typeof value === "string") {
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }
    return typeof value === "string" ? value : JSON.stringify(value);
  }

  // List mode: keep the grid readable, but never hide the full value in detail.
  let text = typeof value === "string" ? value : JSON.stringify(value);
  if (text.length > LIST_PREVIEW_LEN) {
    return `${text.slice(0, LIST_PREVIEW_LEN)}…`;
  }
  return text;
}

function serializeRow(
  row: Record<string, unknown>,
  def: TableDef,
  mode: "list" | "detail",
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const meta of def.columns) {
    out[meta.name] = serializeValue(row[meta.name], meta, mode);
  }
  out.__rowKey = encodeRowKey(row, def);
  return out;
}

const ROW_KEY_SEP = "\u001f";

function encodeRowKey(row: Record<string, unknown>, def: TableDef): string {
  return def.keyFields.map((field) => String(row[field] ?? "")).join(ROW_KEY_SEP);
}

function decodeRowKey(raw: string, def: TableDef): Record<string, string> | null {
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }
  const parts = decoded.split(ROW_KEY_SEP);
  if (parts.length !== def.keyFields.length) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < def.keyFields.length; i++) {
    out[def.keyFields[i]!] = parts[i] ?? "";
  }
  return out;
}

function columnByName(def: TableDef, field: string): Column | null {
  return def.columns.find((c) => c.name === field)?.column ?? null;
}

function buildSearchFilter(def: TableDef, q: string): SQL | undefined {
  const trimmed = q.trim().slice(0, 120);
  if (!trimmed) return undefined;
  const pattern = `%${trimmed.replace(/[%_]/g, "\\$&")}%`;
  const searchable = def.columns.filter((c) => c.searchable);
  if (searchable.length === 0) return undefined;
  const clauses = searchable.map((c) =>
    c.type === "number" ? sql`cast(${c.column} as text) like ${pattern}` : like(c.column, pattern),
  );
  return or(...clauses);
}

export async function listGuildDbTables(guildId: string): Promise<{ tables: DbTableMeta[] }> {
  const db = getDb();
  const tables: DbTableMeta[] = [];

  for (const def of getCatalog()) {
    const [row] = await db
      .select({ value: count() })
      .from(def.table)
      .where(eq(def.guildId, guildId));
    tables.push({
      name: def.name,
      label: def.label,
      description: def.description,
      primaryKey: def.keyFields,
      columns: def.columns.map(({ name, label, type, searchable }) => ({
        name,
        label,
        type,
        searchable: Boolean(searchable),
      })),
      rowCount: Number(row?.value ?? 0),
    });
  }

  return { tables };
}

export async function queryGuildDbTable(
  guildId: string,
  tableName: string,
  opts: { q?: string; limit?: number; offset?: number; orderBy?: string; order?: string },
): Promise<
  | {
      ok: true;
      table: string;
      label: string;
      description: string;
      columns: DbColumnMeta[];
      primaryKey: string[];
      rows: Record<string, unknown>[];
      total: number;
      limit: number;
      offset: number;
    }
  | { ok: false; status: number; error: string }
> {
  const def = getTable(tableName);
  if (!def) return { ok: false, status: 404, error: "Unknown table." };

  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(opts.limit) || DEFAULT_LIMIT));
  const offset = Math.max(0, Number(opts.offset) || 0);
  const orderField =
    (opts.orderBy && columnByName(def, opts.orderBy) ? opts.orderBy : null) ??
    def.defaultOrder?.field ??
    def.keyFields[0]!;
  const orderDir =
    opts.order === "asc" || opts.order === "desc"
      ? opts.order
      : (def.defaultOrder?.dir ?? "desc");
  const orderCol = columnByName(def, orderField)!;

  const filters: SQL[] = [eq(def.guildId, guildId)];
  const search = buildSearchFilter(def, opts.q ?? "");
  if (search) filters.push(search);
  const where = and(...filters)!;

  const db = getDb();
  const [totalRow] = await db.select({ value: count() }).from(def.table).where(where);
  const rows = await db
    .select()
    .from(def.table)
    .where(where)
    .orderBy(orderDir === "asc" ? asc(orderCol) : desc(orderCol))
    .limit(limit)
    .offset(offset);

  return {
    ok: true,
    table: def.name,
    label: def.label,
    description: def.description,
    columns: def.columns.map(({ name, label, type, searchable }) => ({
      name,
      label,
      type,
      searchable: Boolean(searchable),
    })),
    primaryKey: def.keyFields,
    rows: rows.map((row) => serializeRow(row as Record<string, unknown>, def, "list")),
    total: Number(totalRow?.value ?? 0),
    limit,
    offset,
  };
}

export async function getGuildDbRow(
  guildId: string,
  tableName: string,
  rowKey: string,
): Promise<
  | {
      ok: true;
      table: string;
      label: string;
      columns: DbColumnMeta[];
      primaryKey: string[];
      row: Record<string, unknown>;
    }
  | { ok: false; status: number; error: string }
> {
  const def = getTable(tableName);
  if (!def) return { ok: false, status: 404, error: "Unknown table." };

  const decoded = decodeRowKey(rowKey, def);
  if (!decoded) return { ok: false, status: 400, error: "Invalid row key." };

  const filters: SQL[] = [eq(def.guildId, guildId)];
  for (const field of def.keyFields) {
    const column = columnByName(def, field);
    if (!column) return { ok: false, status: 500, error: "Invalid table catalog." };
    const raw = decoded[field] ?? "";
    const meta = def.columns.find((c) => c.name === field);
    const value = meta?.type === "number" ? Number(raw) : raw;
    if (meta?.type === "number" && !Number.isFinite(value as number)) {
      return { ok: false, status: 400, error: "Invalid row key." };
    }
    filters.push(eq(column, value as never));
  }

  const db = getDb();
  const [row] = await db
    .select()
    .from(def.table)
    .where(and(...filters))
    .limit(1);

  if (!row) return { ok: false, status: 404, error: "Row not found." };

  return {
    ok: true,
    table: def.name,
    label: def.label,
    columns: def.columns.map(({ name, label, type, searchable }) => ({
      name,
      label,
      type,
      searchable: Boolean(searchable),
    })),
    primaryKey: def.keyFields,
    row: serializeRow(row as Record<string, unknown>, def, "detail"),
  };
}
