import { createHash, randomBytes } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ResolvedProject } from "./config.js";
import { registerManagementTools, type PendingChange } from "./management.js";
import { errorResult, jsonResult } from "./results.js";
import {
  applyFilters,
  filterSchema,
  parseColumns,
  validateFilters,
  validateIdentifier,
  type Filter
} from "./filters.js";

export const MAX_ROWS = 100;
export const DELETE_TOKEN_TTL_MS = 5 * 60 * 1000;

type Fetch = typeof fetch;

export type ServerOptions = {
  fetch?: Fetch;
  now?: () => number;
  // URL de la Management API (solo se cambia en las pruebas).
  managementApiUrl?: string;
  // En modo HTTP se crea un McpServer por petición; compartir el estado
  // mantiene los clientes y los tokens de borrado entre peticiones.
  state?: ServerState;
};

type Entry = {
  project: ResolvedProject;
  client: SupabaseClient;
};

type PendingDelete = {
  fingerprint: string;
  count: number;
  expiresAt: number;
};

export type ServerState = {
  fetch: Fetch;
  entries: Map<string, Entry>;
  pendingDeletes: Map<string, PendingDelete>;
  pendingChanges: Map<string, PendingChange>;
};

export function createState(
  projects: ResolvedProject[],
  options: { fetch?: Fetch } = {}
): ServerState {
  const fetchImpl: Fetch = options.fetch ?? fetch;

  const entries = new Map<string, Entry>();
  for (const project of projects) {
    entries.set(project.id, {
      project,
      client: createClient(project.url, project.key, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { fetch: fetchImpl }
      })
    });
  }

  return { fetch: fetchImpl, entries, pendingDeletes: new Map(), pendingChanges: new Map() };
}

function fingerprint(projectId: string, table: string, filters: Filter[]) {
  return createHash("sha256")
    .update(JSON.stringify([projectId, table, filters]))
    .digest("hex");
}

export function createServer(
  projects: ResolvedProject[],
  options: ServerOptions = {}
): McpServer {
  const now = options.now ?? Date.now;
  const state = options.state ?? createState(projects, options);
  const { entries, pendingDeletes } = state;
  const fetchImpl = state.fetch;

  function getEntry(projectId: string): Entry {
    const entry = entries.get(projectId);
    if (!entry) throw new Error(`Proyecto no registrado: ${projectId}`);
    return entry;
  }

  function checkTable(entry: Entry, table: string) {
    validateIdentifier(table, "Tabla");
    const allowed = entry.project.allowedTables;
    if (allowed && !allowed.includes(table)) {
      throw new Error(
        `La tabla ${table} no está autorizada en ${entry.project.id}.`
      );
    }
  }

  function checkWritable(entry: Entry) {
    if (entry.project.readOnly) {
      throw new Error(`El proyecto ${entry.project.id} es de solo lectura.`);
    }
  }

  async function countMatches(entry: Entry, table: string, filters: Filter[]) {
    const query = entry.client
      .from(table)
      .select("*", { count: "exact", head: true });
    const { count, error } = await applyFilters(query, filters);
    if (error) throw error;
    return count ?? 0;
  }

  const ids = projects.map(p => p.id) as [string, ...string[]];
  const projectId = z.enum(ids).describe(
    "Proyecto de destino. Usa list_projects para ver los disponibles."
  );
  const table = z.string().describe("Nombre de la tabla (esquema public).");
  const row = z.record(z.string(), z.unknown());

  const server = new McpServer({ name: "supabase-multi-mcp", version: "1.0.0" });

  server.registerTool(
    "list_projects",
    {
      description: "Lista los proyectos de Supabase configurados en este MCP.",
      inputSchema: {},
      annotations: { readOnlyHint: true }
    },
    async () => jsonResult(projects.map(p => ({
      id: p.id,
      name: p.name,
      readOnly: p.readOnly ?? false,
      allowedTables: p.allowedTables ?? "todas",
      // true si tiene token de gestión: SQL, migraciones, logs, Edge Functions…
      management: Boolean(p.accessToken)
    })))
  );

  server.registerTool(
    "list_tables",
    {
      description: "Lista las tablas expuestas por la API REST del proyecto.",
      inputSchema: { project_id: projectId },
      annotations: { readOnlyHint: true }
    },
    async ({ project_id }) => {
      try {
        const { project } = getEntry(project_id);
        const response = await fetchImpl(`${project.url}/rest/v1/`, {
          headers: {
            apikey: project.key,
            Authorization: `Bearer ${project.key}`,
            Accept: "application/openapi+json"
          }
        });

        if (!response.ok) {
          throw new Error(`Supabase REST respondió HTTP ${response.status}.`);
        }

        const schema = await response.json() as {
          paths?: Record<string, unknown>;
        };

        let tables = Object.keys(schema.paths ?? {})
          .filter(p => /^\/[a-zA-Z_][a-zA-Z0-9_]*$/.test(p))
          .map(p => p.slice(1))
          .sort();

        if (project.allowedTables) {
          const allowed = project.allowedTables;
          tables = tables.filter(t => allowed.includes(t));
        }

        return jsonResult({ project_id, tables });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "read_records",
    {
      description:
        `Consulta registros con filtros opcionales (máximo ${MAX_ROWS} por llamada).`,
      inputSchema: {
        project_id: projectId,
        table,
        columns: z.string().optional()
          .describe('Columnas separadas por comas, o "*" (por defecto).'),
        filters: z.array(filterSchema).optional(),
        order_by: z.string().optional(),
        ascending: z.boolean().default(true),
        limit: z.number().int().min(1).max(MAX_ROWS).default(20),
        offset: z.number().int().min(0).default(0)
      },
      annotations: { readOnlyHint: true }
    },
    async ({ project_id, table, columns, filters, order_by, ascending, limit, offset }) => {
      try {
        const entry = getEntry(project_id);
        checkTable(entry, table);

        let query = entry.client
          .from(table)
          .select(parseColumns(columns), { count: "exact" });
        query = applyFilters(query, filters ?? []);

        if (order_by) {
          validateIdentifier(order_by, "Columna de orden");
          query = query.order(order_by, { ascending });
        }

        const { data, count, error } = await query.range(offset, offset + limit - 1);
        if (error) throw error;

        return jsonResult({
          project_id,
          table,
          total: count,
          returned: data.length,
          offset,
          data
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "create_record",
    {
      description: `Inserta uno o varios registros (máximo ${MAX_ROWS}) en una tabla.`,
      inputSchema: {
        project_id: projectId,
        table,
        data: z.union([row, z.array(row).min(1).max(MAX_ROWS)])
      },
      annotations: { readOnlyHint: false, destructiveHint: false }
    },
    async ({ project_id, table, data }) => {
      try {
        const entry = getEntry(project_id);
        checkTable(entry, table);
        checkWritable(entry);

        const { data: rows, error } = await entry.client
          .from(table)
          .insert(data)
          .select();
        if (error) throw error;

        return jsonResult({ ok: true, project_id, table, inserted: rows.length, data: rows });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "update_record",
    {
      description:
        "Actualiza registros que cumplan los filtros (obligatorios). " +
        `Se rechaza si afectaría a más de max_rows filas (por defecto 1, máximo ${MAX_ROWS}).`,
      inputSchema: {
        project_id: projectId,
        table,
        filters: z.array(filterSchema).min(1),
        data: row,
        max_rows: z.number().int().min(1).max(MAX_ROWS).default(1)
      },
      annotations: { readOnlyHint: false, destructiveHint: true }
    },
    async ({ project_id, table, filters, data, max_rows }) => {
      try {
        const entry = getEntry(project_id);
        checkTable(entry, table);
        checkWritable(entry);
        validateFilters(filters);

        if (Object.keys(data).length === 0) {
          throw new Error("Debes indicar al menos un campo para actualizar.");
        }
        for (const column of Object.keys(data)) {
          validateIdentifier(column, "Nombre de columna");
        }

        const matches = await countMatches(entry, table, filters);
        if (matches > max_rows) {
          throw new Error(
            `Los filtros coinciden con ${matches} filas y max_rows es ${max_rows}. ` +
            "Ajusta los filtros o aumenta max_rows de forma explícita."
          );
        }

        const query = applyFilters(entry.client.from(table).update(data), filters);
        const { data: rows, error } = await query.select();
        if (error) throw error;

        return jsonResult({ ok: true, project_id, table, affected: rows.length, data: rows });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "preview_delete",
    {
      description:
        "Paso 1 de 2 para borrar: muestra las filas que se eliminarían y " +
        "devuelve un confirmation_token de un solo uso válido 5 minutos. " +
        "Enseña la previsualización al usuario y espera su aprobación antes de llamar a delete_record.",
      inputSchema: {
        project_id: projectId,
        table,
        filters: z.array(filterSchema).min(1)
      },
      annotations: { readOnlyHint: true }
    },
    async ({ project_id, table, filters }) => {
      try {
        const entry = getEntry(project_id);
        checkTable(entry, table);
        checkWritable(entry);

        let query = entry.client.from(table).select("*", { count: "exact" });
        query = applyFilters(query, filters);
        const { data, count, error } = await query.range(0, MAX_ROWS - 1);
        if (error) throw error;

        const total = count ?? data.length;
        if (total === 0) {
          return jsonResult({ ok: true, project_id, table, matches: 0, rows: [] });
        }
        if (total > MAX_ROWS) {
          throw new Error(
            `Los filtros coinciden con ${total} filas; el máximo por borrado es ${MAX_ROWS}.`
          );
        }

        for (const [token, pending] of pendingDeletes) {
          if (pending.expiresAt <= now()) pendingDeletes.delete(token);
        }

        const token = randomBytes(16).toString("hex");
        pendingDeletes.set(token, {
          fingerprint: fingerprint(project_id, table, filters),
          count: total,
          expiresAt: now() + DELETE_TOKEN_TTL_MS
        });

        return jsonResult({
          ok: true,
          project_id,
          table,
          matches: total,
          rows: data,
          confirmation_token: token,
          expires_in_seconds: DELETE_TOKEN_TTL_MS / 1000
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "delete_record",
    {
      description:
        "Paso 2 de 2: elimina las filas previsualizadas con preview_delete. " +
        "Requiere exactamente el mismo proyecto, tabla y filtros, y el confirmation_token devuelto.",
      inputSchema: {
        project_id: projectId,
        table,
        filters: z.array(filterSchema).min(1),
        confirmation_token: z.string().min(1)
      },
      annotations: { readOnlyHint: false, destructiveHint: true }
    },
    async ({ project_id, table, filters, confirmation_token }) => {
      try {
        const entry = getEntry(project_id);
        checkTable(entry, table);
        checkWritable(entry);
        validateFilters(filters);

        const pending = pendingDeletes.get(confirmation_token);
        // El token se consume siempre, aunque falle la validación.
        pendingDeletes.delete(confirmation_token);

        if (!pending || pending.expiresAt <= now()) {
          throw new Error("Token de confirmación inválido o caducado. Ejecuta preview_delete de nuevo.");
        }
        if (pending.fingerprint !== fingerprint(project_id, table, filters)) {
          throw new Error("El token no corresponde a este proyecto, tabla y filtros.");
        }

        const current = await countMatches(entry, table, filters);
        if (current !== pending.count) {
          throw new Error(
            `Los datos cambiaron desde la previsualización (${pending.count} → ${current} filas). ` +
            "Ejecuta preview_delete de nuevo."
          );
        }

        const query = applyFilters(entry.client.from(table).delete(), filters);
        const { data: rows, error } = await query.select();
        if (error) throw error;

        return jsonResult({ ok: true, project_id, table, deleted: rows.length, data: rows });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  if (projects.some(p => p.accessToken)) {
    registerManagementTools(server, projects, {
      projectId,
      fetch: fetchImpl,
      now,
      pendingChanges: state.pendingChanges,
      apiUrl: options.managementApiUrl
    });
  }

  return server;
}
