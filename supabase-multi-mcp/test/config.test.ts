import assert from "node:assert/strict";
import { test } from "node:test";

import { parseProjects } from "../src/config.js";

const env = {
  A_URL: "https://aaaa.supabase.co",
  A_KEY: "key-a",
  B_URL: "https://bbbb.supabase.co/",
  B_KEY: "key-b"
};

const project = (id: string, prefix: string) => ({
  id,
  name: id,
  urlEnv: `${prefix}_URL`,
  keyEnv: `${prefix}_KEY`
});

test("carga proyectos válidos y normaliza la URL", () => {
  const projects = parseProjects(
    { projects: [project("somos-luz", "A"), project("cliente-1", "B")] },
    env
  );
  assert.equal(projects.length, 2);
  assert.equal(projects[1].url, "https://bbbb.supabase.co");
  assert.equal(projects[0].key, "key-a");
});

test("rechaza 0 o más de 5 proyectos", () => {
  assert.throws(() => parseProjects({ projects: [] }, env), /entre 1 y 5/);
  const six = Array.from({ length: 6 }, (_, i) => project(`p${i}`, "A"));
  assert.throws(() => parseProjects({ projects: six }, env), /entre 1 y 5/);
});

test("rechaza ids duplicados o con formato inválido", () => {
  assert.throws(
    () => parseProjects({ projects: [project("a", "A"), project("a", "B")] }, env),
    /duplicado/
  );
  assert.throws(() => parseProjects({ projects: [project("Somos Luz", "A")] }, env));
});

test("rechaza credenciales ausentes", () => {
  assert.throws(
    () => parseProjects({ projects: [project("x", "MISSING")] }, env),
    /Faltan credenciales/
  );
});

test("rechaza URLs que no son de Supabase", () => {
  assert.throws(
    () => parseProjects(
      { projects: [project("x", "A")] },
      { A_URL: "https://evil.example.com", A_KEY: "k" }
    ),
    /URL de Supabase no válida/
  );
});

test("rechaza dos proyectos con la misma URL", () => {
  assert.throws(
    () => parseProjects(
      { projects: [project("a", "A"), project("b", "B")] },
      { ...env, B_URL: env.A_URL }
    ),
    /misma URL/
  );
});

test("acepta la URL de la API REST y la reduce a la base", () => {
  const [p] = parseProjects(
    { projects: [project("x", "A")] },
    { A_URL: "https://aaaa.supabase.co/rest/v1/", A_KEY: "k" }
  );
  assert.equal(p.url, "https://aaaa.supabase.co");
});
