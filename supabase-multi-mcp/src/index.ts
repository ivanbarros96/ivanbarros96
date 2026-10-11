import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadProjects } from "./config.js";
import { createServer } from "./server.js";

// Claude Code puede lanzar el proceso desde cualquier carpeta, así que
// .env y projects.json se resuelven siempre respecto a este archivo.
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

dotenv.config({ path: path.join(rootDir, ".env"), quiet: true });

const projects = loadProjects(path.join(rootDir, "projects.json"));
const server = createServer(projects);

await server.connect(new StdioServerTransport());

// STDOUT está reservado para el protocolo MCP; los logs van a STDERR.
console.error(
  `supabase-multi-mcp listo con ${projects.length} proyecto(s): ` +
  projects.map(p => p.id).join(", ")
);
