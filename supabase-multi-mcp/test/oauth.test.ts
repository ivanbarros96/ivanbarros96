import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type AddressInfo } from "node:net";
import { after, before, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type { ResolvedProject } from "../src/config.js";
import { createHttpApp } from "../src/http.js";
import { ACCESS_TOKEN_TTL_S } from "../src/oauth.js";
import { createFakeSupabase } from "./fakeSupabase.js";

const TOKEN = "t".repeat(40);
const PASSWORD = "contraseña-de-prueba";
const REDIRECT = "http://localhost:9876/callback";
const projects: ResolvedProject[] = [
  { id: "somos-luz", name: "Somos Luz", urlEnv: "", keyEnv: "", url: "https://aaaa.supabase.co", key: "key-a" }
];
const backend = {
  url: "https://aaaa.supabase.co", key: "key-a",
  tables: { perfiles: [{ id: 1, nombre: "Ana" }, { id: 2, nombre: "Luis" }] }
};

let base: string;
let clock = Date.now();
let app: ReturnType<typeof createHttpApp>;

async function freePort() {
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return port;
}

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  app = createHttpApp(projects, {
    authToken: TOKEN,
    oauth: { issuer: base, password: PASSWORD },
    fetch: createFakeSupabase([backend]).fetch,
    now: () => clock
  });
  await new Promise<void>(resolve => app.listen(port, "127.0.0.1", resolve));
});

after(() => new Promise<void>(resolve => app.close(() => resolve())));

const b64url = (value: string) => createHash("sha256").update(value).digest("base64url");

function memoryProvider(metadata: Partial<OAuthClientProvider["clientMetadata"]> = {}) {
  const store: Record<string, unknown> = {};
  const provider: OAuthClientProvider & { authorizationUrl?: URL } = {
    get redirectUrl() { return REDIRECT; },
    get clientMetadata() {
      return { redirect_uris: [REDIRECT], client_name: "Prueba", ...metadata };
    },
    clientInformation: () => store.client as never,
    saveClientInformation: info => { store.client = info; },
    tokens: () => store.tokens as never,
    saveTokens: tokens => { store.tokens = tokens; },
    redirectToAuthorization: url => { provider.authorizationUrl = url; },
    saveCodeVerifier: verifier => { store.verifier = verifier; },
    codeVerifier: () => store.verifier as string
  };
  return provider;
}

// Lee los campos ocultos del formulario igual que un navegador.
async function consentForm(authorizationUrl: URL) {
  const html = await (await fetch(authorizationUrl)).text();
  const form = new URLSearchParams();
  for (const [, name, value] of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) {
    form.set(name, value.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code))));
  }
  return form;
}

// Rellena la pantalla de autorización como lo haría el usuario.
async function submitConsent(authorizationUrl: URL, password: string, extra: Record<string, string> = {}) {
  const form = await consentForm(authorizationUrl);
  assert.ok(form.get("client_id"), "la pantalla no se mostró");
  form.set("password", password);
  form.set("decision", "allow");
  for (const [k, v] of Object.entries(extra)) form.set(k, v);
  return fetch(`${base}/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": extra.ip ?? "10.0.0.1" },
    body: form,
    redirect: "manual"
  });
}

async function authorizeWithSdk(provider: ReturnType<typeof memoryProvider>) {
  assert.equal(await auth(provider, { serverUrl: `${base}/mcp` }), "REDIRECT");
  const res = await submitConsent(provider.authorizationUrl!, PASSWORD);
  assert.equal(res.status, 302);
  const location = new URL(res.headers.get("location")!);
  assert.equal(`${location.origin}${location.pathname}`, REDIRECT);
  assert.equal(location.searchParams.get("state"), provider.authorizationUrl!.searchParams.get("state"));
  const code = location.searchParams.get("code")!;
  assert.equal(await auth(provider, { serverUrl: `${base}/mcp`, authorizationCode: code }), "AUTHORIZED");
  return code;
}

async function postToken(params: Record<string, string>) {
  const res = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params)
  });
  return { status: res.status, body: await res.json() as Record<string, string> };
}

async function register(body: unknown) {
  const res = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() as Record<string, string> };
}

// Cliente público (sin secreto) con un código ya emitido, para probar /token a mano.
async function publicClientWithCode(verifier = "v".repeat(50)) {
  const client = (await register({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" })).body;
  const authorizeUrl = new URL(`${base}/authorize`);
  authorizeUrl.search = new URLSearchParams({
    response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT,
    code_challenge: b64url(verifier), code_challenge_method: "S256", state: "xyz"
  }).toString();
  const res = await submitConsent(authorizeUrl, PASSWORD);
  const code = new URL(res.headers.get("location")!).searchParams.get("code")!;
  return { client, code, verifier };
}

function mcpCall(token: string) {
  return fetch(`${base}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
  });
}

test("publica los metadatos OAuth y el 401 indica dónde encontrarlos", async () => {
  const res = await fetch(`${base}/mcp`, { method: "POST", body: "{}" });
  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate")!, /resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource\/mcp"/);

  const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(prm.resource, `${base}/mcp`);
  assert.deepEqual(prm.authorization_servers, [base]);

  const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  assert.equal(as.issuer, base);
  assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
});

test("flujo completo con el cliente OAuth del SDK y llamada a una herramienta", async () => {
  const provider = memoryProvider();
  await authorizeWithSdk(provider);

  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: provider }));
  const result = await client.callTool({ name: "read_records", arguments: { project_id: "somos-luz", table: "perfiles" } });
  assert.equal(JSON.parse((result.content as Array<{ text: string }>)[0].text).total, 2);
  await client.close();
});

test("el token fijo sigue funcionando con OAuth activado", async () => {
  assert.equal((await mcpCall(TOKEN)).status, 200);
});

test("contraseña incorrecta: no hay código", async () => {
  const provider = memoryProvider();
  assert.equal(await auth(provider, { serverUrl: `${base}/mcp` }), "REDIRECT");
  const res = await submitConsent(provider.authorizationUrl!, "otra-contraseña", { ip: "10.0.0.2" });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("location"), null);
  assert.match(await res.text(), /Contraseña incorrecta/);
});

test("cancelar devuelve access_denied", async () => {
  const provider = memoryProvider();
  await auth(provider, { serverUrl: `${base}/mcp` });
  const form = await consentForm(provider.authorizationUrl!);
  form.set("decision", "deny");
  const res = await fetch(`${base}/authorize`, { method: "POST", body: form, redirect: "manual" });
  assert.equal(new URL(res.headers.get("location")!).searchParams.get("error"), "access_denied");
});

test("el código exige el code_verifier correcto y solo vale una vez", async () => {
  const { client, code, verifier } = await publicClientWithCode();
  const params = { grant_type: "authorization_code", client_id: client.client_id, code, redirect_uri: REDIRECT };

  const wrong = await postToken({ ...params, code_verifier: "x".repeat(50) });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.error, "invalid_grant");

  const ok = await postToken({ ...params, code_verifier: verifier });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.token_type, "Bearer");
  assert.equal((await mcpCall(ok.body.access_token)).status, 200);

  const reused = await postToken({ ...params, code_verifier: verifier });
  assert.equal(reused.body.error, "invalid_grant");
});

test("el refresh token renueva el acceso y el access token caduca", async () => {
  const { client, code, verifier } = await publicClientWithCode();
  const tokens = (await postToken({
    grant_type: "authorization_code", client_id: client.client_id, code, redirect_uri: REDIRECT, code_verifier: verifier
  })).body;

  // Un refresh token no sirve como access token.
  assert.equal((await mcpCall(tokens.refresh_token)).status, 401);

  const saved = clock;
  clock += (ACCESS_TOKEN_TTL_S + 1) * 1000;
  try {
    assert.equal((await mcpCall(tokens.access_token)).status, 401);
    const renewed = await postToken({ grant_type: "refresh_token", client_id: client.client_id, refresh_token: tokens.refresh_token });
    assert.equal(renewed.status, 200);
    assert.equal((await mcpCall(renewed.body.access_token)).status, 200);
  } finally {
    clock = saved;
  }
});

test("un token manipulado o de otro servidor se rechaza", async () => {
  const { client, code, verifier } = await publicClientWithCode();
  const { access_token } = (await postToken({
    grant_type: "authorization_code", client_id: client.client_id, code, redirect_uri: REDIRECT, code_verifier: verifier
  })).body;
  const [body, mac] = access_token.split(".");
  const payload = JSON.parse(Buffer.from(body, "base64url").toString());
  const forged = `${Buffer.from(JSON.stringify({ ...payload, exp: payload.exp + 1e6 })).toString("base64url")}.${mac}`;
  assert.equal((await mcpCall(forged)).status, 401);

  const other = createHttpApp(projects, { authToken: "o".repeat(40), oauth: { issuer: base, password: PASSWORD } });
  await new Promise<void>(resolve => other.listen(0, "127.0.0.1", resolve));
  const otherBase = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
  const res = await fetch(`${otherBase}/mcp`, { method: "POST", headers: { authorization: `Bearer ${access_token}` }, body: "{}" });
  assert.equal(res.status, 401);
  await new Promise<void>(resolve => other.close(() => resolve()));
});

test("solo se registran redirecciones de Claude o de localhost", async () => {
  const evil = await register({ redirect_uris: ["https://atacante.example/callback"] });
  assert.equal(evil.status, 400);
  assert.equal(evil.body.error, "invalid_redirect_uri");

  const claude = await register({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], client_name: "Claude" });
  assert.equal(claude.status, 201);
  assert.ok(claude.body.client_secret);
});

test("un redirect_uri distinto del registrado no recibe código", async () => {
  const client = (await register({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" })).body;
  const url = new URL(`${base}/authorize`);
  url.search = new URLSearchParams({
    response_type: "code", client_id: client.client_id, redirect_uri: "http://localhost:1/otra",
    code_challenge: b64url("v".repeat(50)), code_challenge_method: "S256"
  }).toString();
  const res = await fetch(url, { redirect: "manual" });
  assert.equal(res.status, 400);
  assert.equal(res.headers.get("location"), null);
});

test("la pantalla escapa el nombre del cliente", async () => {
  const client = (await register({ redirect_uris: [REDIRECT], client_name: "<script>x</script>", token_endpoint_auth_method: "none" })).body;
  const url = new URL(`${base}/authorize`);
  url.search = new URLSearchParams({
    response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT,
    code_challenge: b64url("v".repeat(50)), code_challenge_method: "S256"
  }).toString();
  const html = await (await fetch(url)).text();
  assert.ok(!html.includes("<script>x"));
  assert.match(html, /&#60;script&#62;/);
});

test("tras 5 fallos se bloquea esa IP aunque luego acierte", async () => {
  const provider = memoryProvider();
  await auth(provider, { serverUrl: `${base}/mcp` });
  for (let i = 0; i < 5; i++) {
    await submitConsent(provider.authorizationUrl!, "mala-contraseña", { ip: "10.9.9.9" });
  }
  const res = await submitConsent(provider.authorizationUrl!, PASSWORD, { ip: "10.9.9.9" });
  assert.equal(res.status, 401);
  assert.match(await res.text(), /Demasiados intentos/);

  const otherIp = await submitConsent(provider.authorizationUrl!, PASSWORD, { ip: "10.8.8.8" });
  assert.equal(otherIp.status, 302);
});
