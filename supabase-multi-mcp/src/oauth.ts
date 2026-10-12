import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

// Servidor de autorización OAuth 2.1 mínimo para un único usuario.
// Permite añadir el MCP como conector personalizado de Claude (claude.ai),
// que no admite cabeceras fijas. No guarda estado: clientes, códigos y
// tokens van firmados con HMAC, así que sobreviven a reinicios.

export const MIN_PASSWORD_LENGTH = 12;
export const ACCESS_TOKEN_TTL_S = 60 * 60;
export const REFRESH_TOKEN_TTL_S = 30 * 24 * 60 * 60;
const CODE_TTL_S = 5 * 60;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const MAX_FORM_BYTES = 64 * 1024;

// Solo se entregan códigos a Claude o a clientes locales (Claude Code).
const ALLOWED_REDIRECTS = [
  /^https:\/\/claude\.ai\/api\/mcp\/auth_callback$/,
  /^https:\/\/claude\.com\/api\/mcp\/auth_callback$/,
  /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/[^#]*$/
];

export type OAuthOptions = {
  // URL pública del servidor, p. ej. https://mcp.midominio.com
  issuer: string;
  // Clave con la que se firman los tokens (MCP_AUTH_TOKEN).
  secret: string;
  // Contraseña que se pide en la pantalla de autorización.
  password: string;
  now?: () => number;
};

type Payload = Record<string, unknown> & { typ: string; exp?: number };

type Client = {
  client_id: string;
  redirect_uris: string[];
  client_name?: string;
  auth_method: string;
};

class OAuthError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
  }
}

const b64url = (data: Buffer | string) => Buffer.from(data).toString("base64url");
const sha256 = (value: string) => createHash("sha256").update(value).digest();

function safeEqual(a: string, b: string) {
  return timingSafeEqual(sha256(a), sha256(b));
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
}

function isAllowedRedirect(uri: string) {
  return ALLOWED_REDIRECTS.some(pattern => pattern.test(uri));
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    ...headers
  }).end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_FORM_BYTES) throw new OAuthError("invalid_request", "Cuerpo demasiado grande");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readParams(req: IncomingMessage) {
  const raw = await readBody(req);
  if ((req.headers["content-type"] ?? "").includes("application/json")) {
    const data = JSON.parse(raw || "{}") as Record<string, unknown>;
    return new URLSearchParams(
      Object.entries(data).filter(([, v]) => typeof v === "string") as [string, string][]
    );
  }
  return new URLSearchParams(raw);
}

export function createOAuth(options: OAuthOptions) {
  if (options.password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`La contraseña OAuth debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`);
  }

  const issuer = options.issuer.replace(/\/+$/, "");
  const resource = `${issuer}/mcp`;
  const now = options.now ?? Date.now;
  const seconds = () => Math.floor(now() / 1000);
  const key = sha256(`supabase-multi-mcp/oauth\0${options.secret}`);
  const usedCodes = new Map<string, number>();
  const failures = new Map<string, { count: number; until: number }>();

  function sign(payload: Payload) {
    const body = b64url(JSON.stringify(payload));
    return `${body}.${b64url(createHmac("sha256", key).update(body).digest())}`;
  }

  function verify(token: string, typ: string): Payload {
    const [body, mac, extra] = token.split(".");
    if (!body || !mac || extra !== undefined) throw new OAuthError("invalid_grant", "Token mal formado");
    const expected = b64url(createHmac("sha256", key).update(body).digest());
    if (!safeEqual(mac, expected)) throw new OAuthError("invalid_grant", "Firma no válida");
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Payload;
    if (payload.typ !== typ) throw new OAuthError("invalid_grant", "Tipo de token incorrecto");
    if (payload.exp !== undefined && payload.exp <= seconds()) {
      throw new OAuthError("invalid_grant", "Token caducado");
    }
    return payload;
  }

  function clientSecret(clientId: string) {
    return b64url(createHmac("sha256", key).update(`secret\0${clientId}`).digest());
  }

  function loadClient(clientId: string | null): Client {
    if (!clientId) throw new OAuthError("invalid_client", "Falta client_id", 401);
    try {
      const p = verify(clientId, "client");
      return {
        client_id: clientId,
        redirect_uris: p.r as string[],
        client_name: p.n as string | undefined,
        auth_method: p.a as string
      };
    } catch {
      throw new OAuthError("invalid_client", "client_id desconocido", 401);
    }
  }

  // Comprueba la autenticación del cliente en /token (none, post o basic).
  function authenticateClient(req: IncomingMessage, params: URLSearchParams) {
    let clientId = params.get("client_id");
    let secret = params.get("client_secret");
    const basic = /^Basic\s+(.+)$/i.exec(req.headers.authorization ?? "");
    if (basic) {
      const [id, pass] = Buffer.from(basic[1], "base64").toString("utf8").split(":");
      clientId = decodeURIComponent(id ?? "");
      secret = decodeURIComponent(pass ?? "");
    }
    const client = loadClient(clientId);
    if (client.auth_method !== "none") {
      if (!secret || !safeEqual(secret, clientSecret(client.client_id))) {
        throw new OAuthError("invalid_client", "client_secret incorrecto", 401);
      }
    }
    return client;
  }

  function checkResource(value: string | null) {
    if (value === null) return;
    const normalized = value.replace(/\/+$/, "");
    if (normalized !== resource && normalized !== issuer) {
      throw new OAuthError("invalid_target", "Recurso desconocido");
    }
  }

  function issueTokens(clientId: string, scope: string) {
    const cid = b64url(sha256(clientId));
    const exp = seconds() + ACCESS_TOKEN_TTL_S;
    return {
      access_token: sign({ typ: "access", cid, aud: resource, scope, exp, jti: b64url(randomBytes(9)) }),
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_S,
      refresh_token: sign({
        typ: "refresh", cid, scope, exp: seconds() + REFRESH_TOKEN_TTL_S, jti: b64url(randomBytes(9))
      }),
      scope
    };
  }

  // --- Limitación de intentos de contraseña ---

  function clientIp(req: IncomingMessage) {
    // Traefik añade la IP real al final de X-Forwarded-For.
    const forwarded = String(req.headers["x-forwarded-for"] ?? "").split(",").pop()!.trim();
    return forwarded || req.socket.remoteAddress || "desconocida";
  }

  function isLocked(ip: string) {
    const ipEntry = failures.get(ip);
    const global = failures.get("*");
    const t = now();
    return Boolean((ipEntry && ipEntry.until > t) || (global && global.until > t));
  }

  function recordFailure(ip: string) {
    const t = now();
    for (const [id, limit] of [[ip, MAX_FAILURES], ["*", MAX_FAILURES * 4]] as const) {
      const entry = failures.get(id);
      const count = entry && entry.until > t - LOCKOUT_MS ? entry.count + 1 : 1;
      failures.set(id, { count, until: count >= limit ? t + LOCKOUT_MS : t });
    }
  }

  // --- Páginas ---

  function page(res: ServerResponse, status: number, title: string, inner: string) {
    res.writeHead(status, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://claude.ai https://claude.com http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'",
      "referrer-policy": "no-referrer"
    }).end(`<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;background:#f4f4f5;color:#18181b;margin:0;padding:16px}
main{max-width:420px;margin:10vh auto;background:#fff;border-radius:12px;padding:28px;box-shadow:0 1px 3px #0002}
h1{font-size:1.25rem;margin:0 0 12px}p{line-height:1.5}code{word-break:break-all}
input{width:100%;box-sizing:border-box;padding:10px;font-size:1rem;margin:8px 0 16px;border:1px solid #d4d4d8;border-radius:8px}
.row{display:flex;gap:8px}button{flex:1;padding:10px;font-size:1rem;border-radius:8px;border:0;cursor:pointer}
.ok{background:#18181b;color:#fff}.no{background:#e4e4e7}.err{color:#b91c1c}
@media (prefers-color-scheme:dark){body{background:#18181b;color:#f4f4f5}main{background:#27272a}
input{background:#18181b;color:#f4f4f5;border-color:#3f3f46}.ok{background:#f4f4f5;color:#18181b}.no{background:#3f3f46;color:#f4f4f5}}</style>
</head><body><main>${inner}</main></body></html>`);
  }

  function consentPage(res: ServerResponse, client: Client, params: URLSearchParams, error?: string) {
    const fields = ["client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "scope", "resource"]
      .map(name => params.get(name) === null ? "" :
        `<input type="hidden" name="${name}" value="${escapeHtml(params.get(name)!)}">`)
      .join("");
    const who = escapeHtml(client.client_name || "Un cliente MCP");
    const host = escapeHtml(new URL(params.get("redirect_uri")!).host);
    page(res, error ? 401 : 200, "Autorizar acceso", `
<h1>Autorizar acceso a supabase-multi-mcp</h1>
<p><strong>${who}</strong> (${host}) quiere leer y modificar tus proyectos de Supabase.</p>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/authorize">${fields}
<label for="password">Contraseña del servidor MCP</label>
<input id="password" name="password" type="password" autocomplete="current-password" autofocus>
<div class="row"><button class="no" name="decision" value="deny">Cancelar</button>
<button class="ok" name="decision" value="allow">Autorizar</button></div></form>`);
  }

  function redirectWith(res: ServerResponse, redirectUri: string, values: Record<string, string | null>) {
    const target = new URL(redirectUri);
    for (const [name, value] of Object.entries(values)) {
      if (value !== null) target.searchParams.set(name, value);
    }
    res.writeHead(302, { location: target.toString(), "cache-control": "no-store" }).end();
  }

  // Valida la petición de autorización; los errores previos a conocer un
  // redirect_uri fiable se muestran en pantalla en lugar de redirigir.
  function validateAuthorize(params: URLSearchParams) {
    const client = loadClient(params.get("client_id"));
    const redirectUri = params.get("redirect_uri") ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0] : "");
    if (!client.redirect_uris.includes(redirectUri) || !isAllowedRedirect(redirectUri)) {
      throw new OAuthError("invalid_request", "redirect_uri no permitido");
    }
    params.set("redirect_uri", redirectUri);
    const problem =
      params.get("response_type") !== "code" ? "unsupported_response_type" :
      !params.get("code_challenge") || params.get("code_challenge_method") !== "S256" ? "invalid_request" :
      null;
    checkResource(params.get("resource"));
    return { client, redirectUri, problem };
  }

  // --- Endpoints ---

  async function handleAuthorize(req: IncomingMessage, res: ServerResponse, url: URL) {
    const params = req.method === "POST" ? await readParams(req) : url.searchParams;
    let checked: ReturnType<typeof validateAuthorize>;
    try {
      checked = validateAuthorize(params);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Petición no válida";
      console.error(`OAuth /authorize rechazado: ${message}`);
      page(res, 400, "Error", `<h1>No se puede autorizar</h1><p class="err">${escapeHtml(message)}</p>`);
      return;
    }
    const { client, redirectUri, problem } = checked;
    const state = params.get("state");
    if (problem) {
      console.error(`OAuth /authorize: ${problem}`);
      redirectWith(res, redirectUri, { error: problem, state });
      return;
    }

    if (req.method !== "POST") {
      consentPage(res, client, params);
      return;
    }

    if (params.get("decision") !== "allow") {
      console.error("OAuth /authorize: cancelado por el usuario");
      redirectWith(res, redirectUri, { error: "access_denied", state });
      return;
    }

    const ip = clientIp(req);
    if (isLocked(ip)) {
      consentPage(res, client, params, "Demasiados intentos fallidos. Espera 15 minutos.");
      return;
    }
    if (!safeEqual(params.get("password") ?? "", options.password)) {
      recordFailure(ip);
      console.error(`OAuth /authorize: contraseña incorrecta desde ${ip}`);
      consentPage(res, client, params, "Contraseña incorrecta.");
      return;
    }

    const code = sign({
      typ: "code",
      cid: b64url(sha256(client.client_id)),
      ru: redirectUri,
      cc: params.get("code_challenge"),
      scope: params.get("scope") ?? "mcp",
      exp: seconds() + CODE_TTL_S,
      jti: b64url(randomBytes(12))
    });
    redirectWith(res, redirectUri, { code, state, iss: issuer });
  }

  async function handleToken(req: IncomingMessage, res: ServerResponse) {
    const params = await readParams(req);
    const client = authenticateClient(req, params);
    const cid = b64url(sha256(client.client_id));
    checkResource(params.get("resource"));

    const grant = params.get("grant_type");
    if (grant === "authorization_code") {
      const code = verify(params.get("code") ?? "", "code");
      if (code.cid !== cid) throw new OAuthError("invalid_grant", "El código es de otro cliente");
      if (params.get("redirect_uri") !== null && params.get("redirect_uri") !== code.ru) {
        throw new OAuthError("invalid_grant", "redirect_uri distinto");
      }
      const verifier = params.get("code_verifier") ?? "";
      if (!safeEqual(b64url(sha256(verifier)), String(code.cc))) {
        throw new OAuthError("invalid_grant", "code_verifier incorrecto");
      }
      const jti = String(code.jti);
      for (const [id, exp] of usedCodes) if (exp <= seconds()) usedCodes.delete(id);
      if (usedCodes.has(jti)) throw new OAuthError("invalid_grant", "El código ya se usó");
      usedCodes.set(jti, Number(code.exp));
      sendJson(res, 200, issueTokens(client.client_id, String(code.scope)));
      return;
    }

    if (grant === "refresh_token") {
      const refresh = verify(params.get("refresh_token") ?? "", "refresh");
      if (refresh.cid !== cid) throw new OAuthError("invalid_grant", "El token es de otro cliente");
      sendJson(res, 200, issueTokens(client.client_id, String(refresh.scope)));
      return;
    }

    throw new OAuthError("unsupported_grant_type", "grant_type no admitido");
  }

  async function handleRegister(req: IncomingMessage, res: ServerResponse) {
    const raw = await readBody(req);
    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new OAuthError("invalid_client_metadata", "JSON no válido");
    }
    const uris = meta.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 ||
        !uris.every(u => typeof u === "string" && isAllowedRedirect(u))) {
      throw new OAuthError("invalid_redirect_uri", "Solo se admiten redirecciones de Claude o de localhost");
    }
    const method = typeof meta.token_endpoint_auth_method === "string" ? meta.token_endpoint_auth_method : "client_secret_basic";
    if (!["none", "client_secret_post", "client_secret_basic"].includes(method)) {
      throw new OAuthError("invalid_client_metadata", "token_endpoint_auth_method no admitido");
    }
    const name = typeof meta.client_name === "string" ? meta.client_name.slice(0, 100) : undefined;
    const issuedAt = seconds();
    console.error(`OAuth /register: "${name ?? "sin nombre"}", ${method}, ${uris.map(u => new URL(u).host).join(" ")}`);
    const clientId = sign({ typ: "client", r: uris, n: name, a: method, iat: issuedAt });
    sendJson(res, 201, {
      client_id: clientId,
      client_id_issued_at: issuedAt,
      ...(method === "none" ? {} : { client_secret: clientSecret(clientId), client_secret_expires_at: 0 }),
      redirect_uris: uris,
      client_name: name,
      token_endpoint_auth_method: method,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"]
    });
  }

  const resourceMetadataUrl = `${issuer}/.well-known/oauth-protected-resource/mcp`;

  return {
    resourceMetadataUrl,

    // Devuelve true si es un access token emitido aquí, vigente y para /mcp.
    verifyAccessToken(token: string) {
      try {
        return verify(token, "access").aud === resource;
      } catch {
        return false;
      }
    },

    // Atiende las rutas OAuth; devuelve false si la ruta no es suya.
    async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
      const { pathname } = url;
      const method = req.method ?? "GET";

      if (method === "OPTIONS" && (pathname.startsWith("/.well-known/") || pathname === "/token" || pathname === "/register")) {
        res.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "authorization, content-type, mcp-protocol-version"
        }).end();
        return true;
      }

      if (method === "GET" && (pathname === "/.well-known/oauth-protected-resource" ||
          pathname === "/.well-known/oauth-protected-resource/mcp")) {
        sendJson(res, 200, {
          resource,
          authorization_servers: [issuer],
          bearer_methods_supported: ["header"],
          scopes_supported: ["mcp"],
          resource_name: "supabase-multi-mcp"
        });
        return true;
      }

      if (method === "GET" && (pathname === "/.well-known/oauth-authorization-server" ||
          pathname === "/.well-known/openid-configuration")) {
        sendJson(res, 200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          registration_endpoint: `${issuer}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
          scopes_supported: ["mcp"],
          authorization_response_iss_parameter_supported: true
        });
        return true;
      }

      const routes: Record<string, { methods: string[]; run: () => Promise<void> }> = {
        "/authorize": { methods: ["GET", "POST"], run: () => handleAuthorize(req, res, url) },
        "/token": { methods: ["POST"], run: () => handleToken(req, res) },
        "/register": { methods: ["POST"], run: () => handleRegister(req, res) }
      };
      const route = routes[pathname];
      if (!route) return false;
      if (!route.methods.includes(method)) {
        sendJson(res, 405, { error: "invalid_request", error_description: "Método no permitido" },
          { allow: route.methods.join(", ") });
        return true;
      }

      try {
        await route.run();
      } catch (error) {
        if (res.headersSent) return true;
        if (error instanceof OAuthError) {
          console.error(`OAuth ${pathname}: ${error.code} (${error.message})`);
          sendJson(res, error.status, { error: error.code, error_description: error.message });
        } else {
          console.error("Error en OAuth:", error);
          sendJson(res, 500, { error: "server_error" });
        }
      }
      return true;
    }
  };
}

export type OAuth = ReturnType<typeof createOAuth>;
