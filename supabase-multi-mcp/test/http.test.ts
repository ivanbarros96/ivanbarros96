import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type { ResolvedProject } from "../src/config.js";
import { createHttpApp } from "../src/http.js";
import { createFakeSupabase } from "./fakeSupabase.js";

const TOKEN = "t".repeat(40);
const projects: ResolvedProject[] = [
  { id: "somos-luz", name: "Somos Luz", urlEnv: "", keyEnv: "", url: "https://aaaa.supabase.co", key: "key-a" }
];
const backend = {
  url: "https://aaaa.supabase.co", key: "key-a",
  tables: { perfiles: [{ id: 1, nombre: "Ana" }, { id: 2, nombre: "Luis" }] }
};

let base: string;
let app: ReturnType<typeof createHttpApp>;

before(async () => {
  app = createHttpApp(projects, { authToken: TOKEN, fetch: createFakeSupabase([backend]).fetch });
  await new Promise<void>(resolve => app.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});

after(() => new Promise<void>(resolve => app.close(() => resolve())));

async function connect(token: string) {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  }));
  return client;
}

function parse(result: Awaited<ReturnType<Client["callTool"]>>) {
  return JSON.parse((result.content as Array<{ text: string }>)[0].text);
}

test("rechaza tokens cortos al arrancar", () => {
  assert.throws(() => createHttpApp(projects, { authToken: "corto" }), /al menos/);
});

test("/health responde sin autenticación y sin datos", async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("sin token o con token incorrecto devuelve 401", async () => {
  const none = await fetch(`${base}/mcp`, { method: "POST", body: "{}" });
  assert.equal(none.status, 401);
  const wrong = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${"x".repeat(40)}` },
    body: "{}"
  });
  assert.equal(wrong.status, 401);
  await assert.rejects(connect("x".repeat(40)));
});

test("con token válido funcionan las herramientas", async () => {
  const client = await connect(TOKEN);
  const { body } = { body: parse(await client.callTool({ name: "read_records", arguments: { project_id: "somos-luz", table: "perfiles" } })) };
  assert.equal(body.total, 2);
  await client.close();
});

test("el token de borrado sobrevive entre peticiones HTTP", async () => {
  const client = await connect(TOKEN);
  const filters = [{ column: "id", operator: "eq", value: 2 }];
  const preview = parse(await client.callTool({
    name: "preview_delete", arguments: { project_id: "somos-luz", table: "perfiles", filters }
  }));
  const done = parse(await client.callTool({
    name: "delete_record",
    arguments: { project_id: "somos-luz", table: "perfiles", filters, confirmation_token: preview.confirmation_token }
  }));
  assert.equal(done.deleted, 1);
  assert.equal(backend.tables.perfiles.length, 1);
  await client.close();
});
