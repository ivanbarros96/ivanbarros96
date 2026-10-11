import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { ResolvedProject } from "../src/config.js";
import { createServer, DELETE_TOKEN_TTL_MS } from "../src/server.js";
import { createFakeSupabase, type FakeProject } from "./fakeSupabase.js";

let fake: ReturnType<typeof createFakeSupabase>;
let backends: FakeProject[];
let client: Client;
let clock: number;

const projects: ResolvedProject[] = [
  { id: "somos-luz", name: "Somos Luz", urlEnv: "", keyEnv: "", url: "https://aaaa.supabase.co", key: "key-a" },
  { id: "cliente-1", name: "Cliente 1", urlEnv: "", keyEnv: "", url: "https://bbbb.supabase.co", key: "key-b" },
  {
    id: "solo-lectura", name: "Solo lectura", urlEnv: "", keyEnv: "",
    url: "https://cccc.supabase.co", key: "key-c",
    readOnly: true, allowedTables: ["publica"]
  }
];

beforeEach(async () => {
  backends = [
    {
      url: "https://aaaa.supabase.co", key: "key-a",
      tables: {
        perfiles: [
          { id: 1, nombre: "Ana", activo: true },
          { id: 2, nombre: "Luis", activo: false },
          { id: 3, nombre: "Eva", activo: true }
        ]
      }
    },
    { url: "https://bbbb.supabase.co", key: "key-b", tables: { pedidos: [{ id: 10, total: 5 }] } },
    { url: "https://cccc.supabase.co", key: "key-c", tables: { publica: [{ id: 1 }], secreta: [{ id: 1 }] } }
  ];
  fake = createFakeSupabase(backends);
  clock = 1_000_000;

  const server = createServer(projects, { fetch: fake.fetch, now: () => clock });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientTransport);
});

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  let body: any;
  try {
    body = JSON.parse(content[0].text);
  } catch {
    body = { ok: false, error: content[0].text };
  }
  return { isError: result.isError === true, body };
}

test("expone las herramientas esperadas", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map(t => t.name).sort(),
    ["create_record", "delete_record", "list_projects", "list_tables",
      "preview_delete", "read_records", "update_record"]
  );
});

test("list_projects no expone URLs ni claves", async () => {
  const { body } = await call("list_projects");
  assert.equal(body.length, 3);
  const text = JSON.stringify(body);
  assert.ok(!text.includes("key-a") && !text.includes("supabase.co"));
});

test("list_tables devuelve las tablas de cada proyecto sin cruces", async () => {
  const a = await call("list_tables", { project_id: "somos-luz" });
  const b = await call("list_tables", { project_id: "cliente-1" });
  assert.deepEqual(a.body.tables, ["perfiles"]);
  assert.deepEqual(b.body.tables, ["pedidos"]);
});

test("cada proyecto usa solo su propia URL y clave", async () => {
  await call("read_records", { project_id: "somos-luz", table: "perfiles" });
  await call("read_records", { project_id: "cliente-1", table: "pedidos" });
  for (const req of fake.requests) {
    const backend = backends.find(b => req.url.startsWith(b.url));
    assert.ok(backend, `petición a un host inesperado: ${req.url}`);
    assert.equal(req.apikey, backend.key);
  }
  assert.ok(fake.requests.some(r => r.url.startsWith("https://aaaa")));
  assert.ok(fake.requests.some(r => r.url.startsWith("https://bbbb")));
});

test("un project_id inválido se rechaza sin hacer peticiones", async () => {
  const result = await call("read_records", { project_id: "otro", table: "perfiles" });
  assert.equal(result.isError, true);
  assert.equal(fake.requests.length, 0);
});

test("read_records aplica filtros, límite y total", async () => {
  const { body } = await call("read_records", {
    project_id: "somos-luz",
    table: "perfiles",
    filters: [{ column: "activo", operator: "is", value: true }],
    limit: 1
  });
  assert.equal(body.total, 2);
  assert.equal(body.returned, 1);
  assert.equal(body.data[0].nombre, "Ana");
});

test("read_records rechaza identificadores peligrosos", async () => {
  const bad = await call("read_records", { project_id: "somos-luz", table: "perfiles;drop" });
  assert.equal(bad.isError, true);
  const cols = await call("read_records", { project_id: "somos-luz", table: "perfiles", columns: "id,secret:auth(*)" });
  assert.equal(cols.isError, true);
  assert.equal(fake.requests.length, 0);
});

test("create_record inserta en el proyecto correcto", async () => {
  const { body } = await call("create_record", {
    project_id: "cliente-1",
    table: "pedidos",
    data: { id: 11, total: 7 }
  });
  assert.equal(body.inserted, 1);
  assert.equal(backends[1].tables.pedidos.length, 2);
  assert.equal(backends[0].tables.perfiles.length, 3);
});

test("update_record exige filtros y respeta max_rows", async () => {
  const noFilters = await call("update_record", {
    project_id: "somos-luz", table: "perfiles", filters: [], data: { activo: false }
  });
  assert.equal(noFilters.isError, true);

  const tooMany = await call("update_record", {
    project_id: "somos-luz", table: "perfiles",
    filters: [{ column: "activo", operator: "is", value: true }],
    data: { activo: false }
  });
  assert.equal(tooMany.isError, true);
  assert.match(tooMany.body.error, /coinciden con 2 filas/);
  assert.equal(backends[0].tables.perfiles[0].activo, true);

  const ok = await call("update_record", {
    project_id: "somos-luz", table: "perfiles",
    filters: [{ column: "id", operator: "eq", value: 2 }],
    data: { activo: true }
  });
  assert.equal(ok.body.affected, 1);
  assert.equal(backends[0].tables.perfiles[1].activo, true);
});

test("delete_record sin token válido no borra nada", async () => {
  const filters = [{ column: "id", operator: "eq", value: 1 }];
  const result = await call("delete_record", {
    project_id: "somos-luz", table: "perfiles", filters, confirmation_token: "inventado"
  });
  assert.equal(result.isError, true);
  assert.equal(backends[0].tables.perfiles.length, 3);
});

test("borrado en dos pasos: preview + token de un solo uso", async () => {
  const filters = [{ column: "id", operator: "eq", value: 1 }];
  const preview = await call("preview_delete", { project_id: "somos-luz", table: "perfiles", filters });
  assert.equal(preview.body.matches, 1);
  assert.equal(preview.body.rows[0].nombre, "Ana");
  assert.equal(backends[0].tables.perfiles.length, 3);

  const token = preview.body.confirmation_token;
  const done = await call("delete_record", {
    project_id: "somos-luz", table: "perfiles", filters, confirmation_token: token
  });
  assert.equal(done.body.deleted, 1);
  assert.equal(backends[0].tables.perfiles.length, 2);

  const reuse = await call("delete_record", {
    project_id: "somos-luz", table: "perfiles", filters, confirmation_token: token
  });
  assert.equal(reuse.isError, true);
});

test("el token no sirve para otros filtros ni otro proyecto", async () => {
  const filters = [{ column: "id", operator: "eq", value: 1 }];
  const preview = await call("preview_delete", { project_id: "somos-luz", table: "perfiles", filters });
  const result = await call("delete_record", {
    project_id: "somos-luz", table: "perfiles",
    filters: [{ column: "id", operator: "gt", value: 0 }],
    confirmation_token: preview.body.confirmation_token
  });
  assert.equal(result.isError, true);
  assert.equal(backends[0].tables.perfiles.length, 3);

  const preview2 = await call("preview_delete", { project_id: "somos-luz", table: "perfiles", filters });
  const other = await call("delete_record", {
    project_id: "cliente-1", table: "perfiles", filters,
    confirmation_token: preview2.body.confirmation_token
  });
  assert.equal(other.isError, true);
  assert.equal(backends[0].tables.perfiles.length, 3);
});

test("el token caduca", async () => {
  const filters = [{ column: "id", operator: "eq", value: 1 }];
  const preview = await call("preview_delete", { project_id: "somos-luz", table: "perfiles", filters });
  clock += DELETE_TOKEN_TTL_MS + 1;
  const result = await call("delete_record", {
    project_id: "somos-luz", table: "perfiles", filters,
    confirmation_token: preview.body.confirmation_token
  });
  assert.equal(result.isError, true);
  assert.match(result.body.error, /caducado/);
  assert.equal(backends[0].tables.perfiles.length, 3);
});

test("se aborta el borrado si los datos cambiaron tras la previsualización", async () => {
  const filters = [{ column: "activo", operator: "is", value: true }];
  const preview = await call("preview_delete", { project_id: "somos-luz", table: "perfiles", filters });
  assert.equal(preview.body.matches, 2);
  backends[0].tables.perfiles.push({ id: 4, nombre: "Nuevo", activo: true });
  const result = await call("delete_record", {
    project_id: "somos-luz", table: "perfiles", filters,
    confirmation_token: preview.body.confirmation_token
  });
  assert.equal(result.isError, true);
  assert.equal(backends[0].tables.perfiles.length, 4);
});

test("readOnly y allowedTables se respetan", async () => {
  const tables = await call("list_tables", { project_id: "solo-lectura" });
  assert.deepEqual(tables.body.tables, ["publica"]);

  const hidden = await call("read_records", { project_id: "solo-lectura", table: "secreta" });
  assert.equal(hidden.isError, true);

  const write = await call("create_record", { project_id: "solo-lectura", table: "publica", data: { id: 2 } });
  assert.equal(write.isError, true);
  assert.equal(backends[2].tables.publica.length, 1);
});
