import { readFileSync } from "node:fs";

import { z } from "zod";

export const MAX_PROJECTS = 5;

const identifier = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

const projectSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, "El id solo admite minúsculas, números y guiones."),
  name: z.string().min(1),
  urlEnv: z.string().min(1),
  keyEnv: z.string().min(1),
  // Si se indica, solo estas tablas serán accesibles en el proyecto.
  allowedTables: z.array(z.string().regex(identifier)).min(1).optional(),
  // Si es true, se bloquean inserciones, actualizaciones y borrados.
  readOnly: z.boolean().optional()
});

const fileSchema = z.object({
  projects: z.array(projectSchema).min(1).max(MAX_PROJECTS)
});

export type ProjectConfig = z.infer<typeof projectSchema>;

export type ResolvedProject = ProjectConfig & {
  url: string;
  key: string;
};

const SUPABASE_URL = /^https:\/\/[a-z0-9-]+\.supabase\.co$/i;
const LOCAL_URL = /^http:\/\/(localhost|127\.0\.0\.1):\d+$/i;

export function parseProjects(
  raw: unknown,
  env: NodeJS.ProcessEnv
): ResolvedProject[] {
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `projects.json no es válido (entre 1 y ${MAX_PROJECTS} proyectos): ` +
      parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ")
    );
  }

  const ids = new Set<string>();
  const urls = new Map<string, string>();

  return parsed.data.projects.map(project => {
    if (ids.has(project.id)) {
      throw new Error(`ID de proyecto duplicado: ${project.id}`);
    }
    ids.add(project.id);

    // Se acepta también la URL de la API REST (…/rest/v1/) y se reduce a la base.
    const url = env[project.urlEnv]?.trim()
      .replace(/\/+$/, "")
      .replace(/\/rest\/v1$/, "");
    const key = env[project.keyEnv]?.trim();

    if (!url || !key) {
      throw new Error(
        `Faltan credenciales para el proyecto ${project.id} ` +
        `(${project.urlEnv} / ${project.keyEnv}).`
      );
    }

    if (!SUPABASE_URL.test(url) && !LOCAL_URL.test(url)) {
      throw new Error(`URL de Supabase no válida para ${project.id}.`);
    }

    // Dos entradas apuntando al mismo proyecto suele ser un error de copia
    // que mezclaría datos de clientes distintos.
    const previous = urls.get(url);
    if (previous) {
      throw new Error(
        `Los proyectos ${previous} y ${project.id} usan la misma URL.`
      );
    }
    urls.set(url, project.id);

    return { ...project, url, key };
  });
}

export function loadProjects(
  configPath: string,
  env: NodeJS.ProcessEnv = process.env
): ResolvedProject[] {
  const raw = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
  return parseProjects(raw, env);
}
