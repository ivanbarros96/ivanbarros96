import { createHash, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server } from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import type { ResolvedProject } from "./config.js";
import { createOAuth, type OAuthOptions } from "./oauth.js";
import { createServer, createState, type ServerOptions } from "./server.js";

export const MIN_TOKEN_LENGTH = 32;
const MAX_BODY_BYTES = 1024 * 1024;

export type HttpOptions = ServerOptions & {
  authToken: string;
  // Si se indica, activa OAuth para conectores de claude.ai.
  oauth?: Omit<OAuthOptions, "secret" | "now">;
};

function digest(value: string) {
  return createHash("sha256").update(value).digest();
}

function bearerToken(req: IncomingMessage) {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
  return match === null ? null : match[1].trim();
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("too_large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(res: import("node:http").ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

function rpcError(message: string) {
  return { jsonrpc: "2.0", error: { code: -32000, message }, id: null };
}

export function createHttpApp(
  projects: ResolvedProject[],
  options: HttpOptions
): Server {
  if (options.authToken.length < MIN_TOKEN_LENGTH) {
    throw new Error(`MCP_AUTH_TOKEN debe tener al menos ${MIN_TOKEN_LENGTH} caracteres.`);
  }

  const expected = digest(options.authToken);
  const state = options.state ?? createState(projects, options);
  const oauth = options.oauth
    ? createOAuth({ ...options.oauth, secret: options.authToken, now: options.now })
    : undefined;

  // Vale el token fijo (Claude Code) o un access token OAuth (claude.ai).
  function isAuthorized(req: IncomingMessage) {
    const token = bearerToken(req);
    if (token === null) return false;
    // Comparar resúmenes de igual longitud evita filtrar el token por tiempos.
    if (timingSafeEqual(digest(token), expected)) return true;
    return oauth?.verifyAccessToken(token) ?? false;
  }

  return createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const { pathname } = url;

    // Una línea por petición (sin cabeceras ni cuerpo) para diagnosticar conexiones.
    if (pathname !== "/health") {
      const agent = String(req.headers["user-agent"] ?? "-").slice(0, 60);
      res.on("finish", () => console.error(`${req.method} ${pathname} -> ${res.statusCode} [${agent}]`));
    }

    if (pathname === "/health" && req.method === "GET") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (oauth && pathname !== "/mcp" && await oauth.handle(req, res, url)) return;

    if (pathname !== "/mcp") {
      sendJson(res, 404, { error: "not_found" });
      return;
    }

    if (!isAuthorized(req)) {
      res.setHeader("www-authenticate", oauth
        ? `Bearer resource_metadata="${oauth.resourceMetadataUrl}"`
        : "Bearer");
      sendJson(res, 401, rpcError("Unauthorized"));
      return;
    }

    // Modo sin sesión: cada POST es independiente; GET/DELETE no aplican.
    if (req.method !== "POST") {
      res.setHeader("allow", "POST");
      sendJson(res, 405, rpcError("Method not allowed"));
      return;
    }

    let body: unknown;
    try {
      body = await readJson(req);
    } catch (error) {
      const tooLarge = error instanceof Error && error.message === "too_large";
      sendJson(res, tooLarge ? 413 : 400, rpcError(tooLarge ? "Payload too large" : "Invalid JSON"));
      return;
    }

    const server = createServer(projects, { ...options, state });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      console.error("Error procesando la petición MCP:", error);
      if (!res.headersSent) sendJson(res, 500, rpcError("Internal server error"));
    }
  });
}
