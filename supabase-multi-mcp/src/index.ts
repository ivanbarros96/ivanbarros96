import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadProjects } from "./config.js";
import { createHttpApp } from "./http.js";
import { createServer } from "./server.js";

// Claude Code puede lanzar el proceso desde cualquier carpeta, así que
// .env y projects.json se resuelven siempre respecto a este archivo.
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

dotenv.config({ path: path.join(rootDir, ".env"), quiet: true });

const projects = loadProjects(
  process.env.PROJECTS_FILE ?? path.join(rootDir, "projects.json")
);
const summary = `${projects.length} proyecto(s): ${projects.map(p => p.id).join(", ")}`;

if (process.env.MCP_TRANSPORT === "http") {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? "0.0.0.0";
  const authToken = process.env.MCP_AUTH_TOKEN ?? "";
  // OAuth (conectores de claude.ai) se activa al conocer la URL pública.
  const publicUrl = process.env.PUBLIC_URL ||
    (process.env.MCP_DOMAIN ? `https://${process.env.MCP_DOMAIN}` : "");
  const oauth = publicUrl
    ? { issuer: publicUrl, password: process.env.OAUTH_PASSWORD || authToken }
    : undefined;
  const app = createHttpApp(projects, { authToken, oauth });

  app.listen(port, host, () => {
    console.error(`supabase-multi-mcp (HTTP) en http://${host}:${port}/mcp con ${summary}`);
    console.error(oauth ? `OAuth activo en ${oauth.issuer}` : "OAuth desactivado (sin PUBLIC_URL ni MCP_DOMAIN)");
  });

  const shutdown = () => app.close(() => process.exit(0));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
} else {
  await createServer(projects).connect(new StdioServerTransport());
  // STDOUT está reservado para el protocolo MCP; los logs van a STDERR.
  console.error(`supabase-multi-mcp listo con ${summary}`);
}
