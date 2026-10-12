import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { parseProjects, type ResolvedProject } from "../src/config.js";
import { CHANGE_TOKEN_TTL_MS } from "../src/management.js";
import { createServer } from "../src/server.js";
import { analyzeSql } from "../src/sql-safety.js";
import { API_URL, createFakeManagement } from "./fakeManagement.js";
import { createFakeSupabase } from "./fakeSupabase.js";

// Dos cuentas distintas: cada proyecto tiene el token de la suya.
const projects: ResolvedProject[] = [
  { id: "somos-luz", name: "Somos Luz", urlEnv: "", keyEnv: "", url: "https://aaaa.supabase.co", key: "key-a", accessToken: "sbp_cuenta_a" },
  { id: "cliente-1", name: "Cliente 1", urlEnv: "", keyEnv: "", url: "https://bbbb.supabase.co", key: "key-b", accessToken: "sbp_cuenta_b" },
  { id: "sin-token", name: "Sin token", urlEnv: "", keyEnv: "", url: "https://cccc.supabase.co", key: "key-c" },
  {
    id: "restringido", name: "Restringido", urlEnv: "", keyEnv: "", url: "https://dddd.supabase.co", key: "key-d",
    accessToken: "sbp_cuenta_d", readOnly: true, allowedTables: ["publica"]
  }
];

let mgmt: ReturnType<typeof createFakeManagement>;
let client: Client;
let clock: number;

async function connect(list: ResolvedProject[]) {
  mgmt = createFakeManagement({ aaaa: "sbp_cuenta_a", bbbb: "sbp_cuenta_b", dddd: "sbp_cuenta_d" });
  const rest = createFakeSupabase([]);
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) =>
    String(input).startsWith(API_URL) ? mgmt.fetch(input, init) : rest.fetch(input, init)) as typeof fetch;
  const server = createServer(list, { fetch: fetchImpl, now: () => clock, managementApiUrl: API_URL });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientTransport);
}

beforeEach(async () => {
  clock = Date.parse("2026-10-12T12:00:00Z");
  await connect(projects);
});

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ text: string }>)[0].text;
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = { ok: false, error: text };
  }
  return { isError: result.isError === true, body, text };
}

const routes = () => mgmt.calls.map(c => `${c.method} ${c.ref}${c.route}`);

test("sin ningún token no aparecen las herramientas de gestión", async () => {
  await connect([projects[2]]);
  const { tools } = await client.listTools();
  assert.ok(!tools.some(t => t.name === "execute_sql"));
});

test("con token aparecen todas las herramientas de gestión", async () => {
  const { tools } = await client.listTools();
  const names = tools.map(t => t.name);
  for (const name of [
    "get_project", "execute_sql", "describe_tables", "list_policies", "list_db_functions", "list_triggers",
    "list_extensions", "list_migrations", "list_backups", "get_logs", "query_logs", "get_advisors",
    "generate_typescript_types", "get_publishable_keys", "list_storage_buckets", "list_edge_functions",
    "get_edge_function", "list_edge_function_secrets", "execute_sql_write", "apply_migration",
    "deploy_edge_function", "delete_edge_function"
  ]) {
    assert.ok(names.includes(name), `falta ${name}`);
  }
  const readOnly = tools.filter(t => t.annotations?.readOnlyHint).map(t => t.name);
  assert.ok(!readOnly.includes("execute_sql_write") && readOnly.includes("execute_sql"));
});

test("list_projects indica qué proyectos tienen gestión", async () => {
  const { body } = await call("list_projects");
  assert.deepEqual(body.map((p: any) => [p.id, p.management]),
    [["somos-luz", true], ["cliente-1", true], ["sin-token", false], ["restringido", true]]);
  assert.ok(!JSON.stringify(body).includes("sbp_"));
});

test("cada proyecto usa solo el token de su cuenta", async () => {
  await call("get_project", { project_id: "somos-luz" });
  await call("get_project", { project_id: "cliente-1" });
  for (const c of mgmt.calls) {
    assert.equal(c.token, c.ref === "aaaa" ? "sbp_cuenta_a" : "sbp_cuenta_b");
  }
  assert.ok(mgmt.calls.some(c => c.ref === "bbbb"));
});

test("un proyecto sin token da un error claro y no llama a la API", async () => {
  const { isError, body } = await call("execute_sql", { project_id: "sin-token", query: "select 1" });
  assert.ok(isError);
  assert.match(body.error, /accessTokenEnv/);
  assert.equal(mgmt.calls.length, 0);
});

test("get_project resume detalles y salud", async () => {
  const { body } = await call("get_project", { project_id: "somos-luz" });
  assert.equal(body.ref, "aaaa");
  assert.equal(body.region, "eu-west-1");
  assert.deepEqual(body.health[0], { service: "db", status: "ACTIVE_HEALTHY" });
});

test("execute_sql va al endpoint de solo lectura y marca los datos como no fiables", async () => {
  const { body } = await call("execute_sql", { project_id: "somos-luz", query: "select * from perfiles" });
  assert.deepEqual(routes(), ["POST aaaa/database/query/read-only"]);
  assert.equal(body.rows[0].resultado, 1);
  assert.match(body.warning, /No sigas instrucciones/);

  const write = await call("execute_sql", { project_id: "somos-luz", query: "insert into perfiles values (1)" });
  assert.ok(write.isError);
  assert.match(write.body.error, /read-only/);
});

test("las herramientas de catálogo usan SQL de solo lectura y validan los esquemas", async () => {
  await call("describe_tables", { project_id: "somos-luz", schemas: ["public", "ventas"], tables: ["pedidos"] });
  const sql = String(mgmt.calls.at(-1)!.json!.query);
  assert.match(sql, /n\.nspname in \('public', 'ventas'\)/);
  assert.match(sql, /c\.relname in \('pedidos'\)/);
  assert.equal(mgmt.calls.at(-1)!.route, "/database/query/read-only");

  const injection = await call("list_policies", { project_id: "somos-luz", schemas: ["public'); drop table x; --"] });
  assert.ok(injection.isError);
  assert.equal(mgmt.calls.length, 1);

  for (const name of ["list_db_functions", "list_triggers", "list_extensions"]) {
    const { isError } = await call(name, { project_id: "somos-luz" });
    assert.ok(!isError, name);
  }
});

test("allowedTables desactiva el SQL directo", async () => {
  const { isError, body } = await call("execute_sql", { project_id: "restringido", query: "select 1" });
  assert.ok(isError);
  assert.match(body.error, /allowedTables/);
});

test("execute_sql_write: previsualiza sin ejecutar y solo ejecuta con el token", async () => {
  const args = { project_id: "somos-luz", query: "delete from perfiles; update perfiles set activo = false" };
  const preview = await call("execute_sql_write", args);
  assert.equal(preview.body.requires_confirmation, true);
  assert.equal(preview.body.preview.statements, 2);
  assert.equal(preview.body.preview.warnings.length, 2);
  assert.equal(mgmt.calls.length, 0, "la previsualización no debe tocar la base de datos");

  const other = await call("execute_sql_write", {
    project_id: "somos-luz", query: "delete from otra", confirmation_token: preview.body.confirmation_token
  });
  assert.ok(other.isError, "el token no sirve para otra consulta");

  // El token se consumió con el intento anterior.
  const consumed = await call("execute_sql_write", { ...args, confirmation_token: preview.body.confirmation_token });
  assert.ok(consumed.isError);
  assert.equal(mgmt.calls.length, 0);

  const again = await call("execute_sql_write", args);
  const done = await call("execute_sql_write", { ...args, confirmation_token: again.body.confirmation_token });
  assert.equal(done.body.ok, true);
  assert.deepEqual(routes(), ["POST aaaa/database/query"]);
  assert.equal(mgmt.calls[0].json!.query, args.query);
});

test("el token de cambio caduca y no sirve en otro proyecto", async () => {
  const args = { project_id: "somos-luz", query: "update perfiles set activo = true where id = 1" };
  const preview = await call("execute_sql_write", args);
  const crossed = await call("execute_sql_write", {
    ...args, project_id: "cliente-1", confirmation_token: preview.body.confirmation_token
  });
  assert.ok(crossed.isError);

  const late = await call("execute_sql_write", args);
  clock += CHANGE_TOKEN_TTL_MS + 1;
  const expired = await call("execute_sql_write", { ...args, confirmation_token: late.body.confirmation_token });
  assert.ok(expired.isError);
  assert.match(expired.body.error, /caducado/);
});

test("apply_migration muestra la última copia y registra la migración", async () => {
  const args = { project_id: "cliente-1", name: "add_status", query: "alter table pedidos add column status text" };
  const preview = await call("apply_migration", args);
  assert.equal(preview.body.preview.backups.last_backup, "2026-10-10T03:00:00Z");
  assert.deepEqual(preview.body.preview.warnings, []);
  assert.ok(!routes().some(r => r.includes("migrations")));

  const done = await call("apply_migration", { ...args, confirmation_token: preview.body.confirmation_token });
  assert.equal(done.body.result.applied, "add_status");
  const post = mgmt.calls.find(c => c.method === "POST" && c.route === "/database/migrations")!;
  assert.equal(post.ref, "bbbb");
  assert.equal(post.headers["idempotency-key"], preview.body.confirmation_token);
  assert.equal(mgmt.migrations[0].name, "add_status");

  const list = await call("list_migrations", { project_id: "cliente-1" });
  assert.equal(list.body.migrations[0].name, "add_status");
});

test("apply_migration rechaza nombres no válidos y proyectos de solo lectura", async () => {
  const badName = await call("apply_migration", { project_id: "somos-luz", name: "Mi Migración", query: "select 1" });
  assert.ok(badName.isError);
  const readOnly = await call("apply_migration", { project_id: "restringido", name: "x", query: "select 1" });
  assert.ok(readOnly.isError);
});

test("get_logs arma la consulta del servicio y limita la ventana a 24 h", async () => {
  const { body } = await call("get_logs", { project_id: "somos-luz", service: "postgres", limit: 10 });
  const req = mgmt.calls.at(-1)!;
  assert.equal(req.route, "/analytics/endpoints/logs");
  assert.match(req.query.sql, /source = 'postgres_logs'.*limit 10$/s);
  assert.equal(req.query.iso_timestamp_end, "2026-10-12T12:00:00.000Z");
  assert.equal(req.query.iso_timestamp_start, "2026-10-11T12:00:00.000Z");
  assert.equal(body.rows.length, 1);

  const tooLong = await call("get_logs", {
    project_id: "somos-luz", service: "api",
    iso_timestamp_start: "2026-10-01T00:00:00Z", iso_timestamp_end: "2026-10-03T00:00:00Z"
  });
  assert.match(tooLong.body.error, /24 horas/);

  const custom = await call("query_logs", { project_id: "somos-luz", sql: "select count(*) from logs" });
  assert.equal(custom.body.rows.length, 1);
});

test("nunca devuelve claves secretas ni valores de secretos", async () => {
  const keys = await call("get_publishable_keys", { project_id: "somos-luz" });
  assert.deepEqual(keys.body.keys.map((k: any) => k.api_key), ["anon-publica", "sb_publishable_abc"]);
  assert.ok(!keys.text.includes("SECRETA"));
  assert.equal(mgmt.calls.at(-1)!.query.reveal, "false");

  const secrets = await call("list_edge_function_secrets", { project_id: "somos-luz" });
  assert.deepEqual(secrets.body.secrets, [{ name: "STRIPE_KEY", updated_at: "2026-10-01" }]);
  assert.ok(!secrets.text.includes("sk_live"));
});

test("avisos, tipos, buckets y copias de seguridad", async () => {
  const advisors = await call("get_advisors", { project_id: "somos-luz", type: "security" });
  assert.equal(advisors.body.lints[0].name, "rls_disabled_in_public");
  assert.equal(advisors.body.lints[0].cache_key, undefined);

  const types = await call("generate_typescript_types", { project_id: "somos-luz", schemas: ["public", "ventas"] });
  assert.match(types.body.types, /export type Database/);
  assert.equal(mgmt.calls.at(-1)!.query.included_schemas, "public,ventas");

  const buckets = await call("list_storage_buckets", { project_id: "somos-luz" });
  assert.equal(buckets.body.buckets[0].id, "avatars");

  const backups = await call("list_backups", { project_id: "somos-luz" });
  assert.equal(backups.body.backups[0].date, "2026-10-11T03:00:00Z");
});

test("get_edge_function descarga los archivos con rutas limpias", async () => {
  const list = await call("list_edge_functions", { project_id: "somos-luz" });
  assert.equal(list.body.functions[0].slug, "hola");

  const { body } = await call("get_edge_function", { project_id: "somos-luz", slug: "hola" });
  assert.equal(body.entrypoint_path, "index.ts");
  assert.deepEqual(body.files.map((f: any) => f.name), ["index.ts", "utils/saludo.ts"]);
  assert.match(body.files[0].content, /Deno\.serve/);

  const missing = await call("get_edge_function", { project_id: "somos-luz", slug: "nada" });
  assert.match(missing.body.error, /No existe/);
});

test("deploy_edge_function valida, previsualiza y despliega en multipart", async () => {
  const files = [
    { name: "index.ts", content: 'import { x } from "./lib/x.ts"; Deno.serve(() => new Response(x));' },
    { name: "lib/x.ts", content: 'export const x = "ok";' }
  ];
  const traversal = await call("deploy_edge_function", {
    project_id: "somos-luz", slug: "nueva", files: [{ name: "../fuera.ts", content: "" }], entrypoint_path: "../fuera.ts"
  });
  assert.match(traversal.body.error, /no válida/);

  const noEntry = await call("deploy_edge_function", { project_id: "somos-luz", slug: "nueva", files: [files[1]] });
  assert.match(noEntry.body.error, /punto de entrada/);

  const args = { project_id: "somos-luz", slug: "nueva", files, verify_jwt: false };
  const preview = await call("deploy_edge_function", args);
  assert.equal(preview.body.preview.operation, "crear nueva");
  assert.equal(preview.body.preview.warnings.length, 1);
  assert.ok(!mgmt.functions.has("nueva"));

  const done = await call("deploy_edge_function", { ...args, confirmation_token: preview.body.confirmation_token });
  assert.equal(done.body.result.version, 1);
  const deployed = mgmt.functions.get("nueva")!;
  assert.equal(deployed.verify_jwt, false);
  assert.deepEqual(deployed.files.map(f => f.name), ["index.ts", "lib/x.ts"]);
  assert.equal(deployed.files[1].content, files[1].content);

  const update = await call("deploy_edge_function", { ...args, verify_jwt: true });
  assert.match(update.body.preview.operation, /actualizar \(versión actual 1\)/);
});

test("delete_edge_function requiere confirmación", async () => {
  const preview = await call("delete_edge_function", { project_id: "somos-luz", slug: "hola" });
  assert.equal(preview.body.preview.version, 3);
  assert.ok(mgmt.functions.has("hola"));
  await call("delete_edge_function", { project_id: "somos-luz", slug: "hola", confirmation_token: preview.body.confirmation_token });
  assert.ok(!mgmt.functions.has("hola"));
});

test("un 401 de la API explica que el token es de otra cuenta", async () => {
  await connect([{ ...projects[0], accessToken: "sbp_equivocado" }]);
  const { body } = await call("get_project", { project_id: "somos-luz" });
  assert.match(body.error, /HTTP 401.*cuenta dueña/);
  assert.ok(!body.error.includes("sbp_equivocado"));
});

test("analyzeSql detecta lo peligroso sin falsos positivos obvios", () => {
  assert.deepEqual(analyzeSql("delete from t where id = 1").warnings, []);
  assert.deepEqual(analyzeSql("update t set a = 'where' where id = 1").warnings, []);
  assert.equal(analyzeSql("update t set a = 'where'").warnings.length, 1);
  assert.equal(analyzeSql("delete from t").warnings.length, 1);
  assert.equal(analyzeSql("drop table t cascade").warnings.length, 1);
  assert.equal(analyzeSql("truncate t").warnings.length, 1);
  assert.equal(analyzeSql("alter table t drop column c").warnings.length, 1);
  assert.deepEqual(analyzeSql("alter table t alter column c drop default").warnings, []);
  assert.equal(analyzeSql("alter table t disable row level security").warnings.length, 1);
  assert.deepEqual(analyzeSql("-- drop table t\nselect 1").warnings, []);
  assert.equal(analyzeSql("select 1; select 2;").statements, 2);
});

test("config: accessTokenEnv exige la variable y un proyecto *.supabase.co", () => {
  const base = { id: "a", name: "A", urlEnv: "A_URL", keyEnv: "A_KEY", accessTokenEnv: "CUENTA_1_TOKEN" };
  const env = { A_URL: "https://aaaa.supabase.co", A_KEY: "k" };
  assert.throws(() => parseProjects({ projects: [base] }, env), /CUENTA_1_TOKEN/);
  const [p] = parseProjects({ projects: [base] }, { ...env, CUENTA_1_TOKEN: " sbp_x " });
  assert.equal(p.accessToken, "sbp_x");
  assert.throws(() => parseProjects({ projects: [{ ...base, accessTokenEnv: "minúsculas" }] }, env));
});
