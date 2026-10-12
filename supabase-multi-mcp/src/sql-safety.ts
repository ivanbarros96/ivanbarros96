// Heurística para avisar de SQL peligroso en la previsualización. No es un
// analizador de SQL: puede equivocarse con texto dentro de cadenas o con
// SQL dinámico. La protección real es la confirmación del usuario.

export function stripSqlComments(sql: string) {
  return sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

// Sustituye el contenido de cadenas e identificadores entre comillas para que
// un "where" dentro de un texto no engañe a las comprobaciones.
function blankQuoted(sql: string) {
  return sql
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, "''")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""');
}

const RULES: Array<[RegExp, string]> = [
  [/^\s*drop\s+(table|schema|database|view|materialized\s+view|function|procedure|trigger|policy|type|extension|index|sequence|role|owned)\b/i,
    "DROP: elimina objetos de la base de datos."],
  [/^\s*truncate\b/i, "TRUNCATE: vacía tablas completas."],
  [/^\s*delete\s+from\s+[^\s;]+\s*(returning\b|$)/i, "DELETE sin WHERE: borra todas las filas."],
  [/^\s*update\s+[^\s;]+\s+set\b(?![\s\S]*\bwhere\b)/i, "UPDATE sin WHERE: modifica todas las filas."],
  [/^\s*alter\s+table\b[\s\S]*\bdrop\s+(column\b|constraint\b|(?!default|not\b|identity|expression)[a-z_"])/i,
    "ALTER TABLE … DROP: elimina columnas o restricciones."],
  [/\bdisable\s+row\s+level\s+security\b/i, "Desactiva RLS: la tabla quedaría expuesta a la API."],
  [/^\s*(grant|revoke)\b/i, "GRANT/REVOKE: cambia permisos."],
  [/^\s*alter\s+(role|user)\b/i, "ALTER ROLE: cambia roles o contraseñas."],
  [/\b(auth|storage|realtime|supabase_functions|vault)\s*\.\s*[a-z_]+/i,
    "Toca esquemas internos de Supabase (auth, storage, realtime, vault…)."]
];

export function analyzeSql(sql: string) {
  const statements = blankQuoted(stripSqlComments(sql))
    .split(";")
    .map(s => s.trim())
    .filter(Boolean);

  const warnings = new Set<string>();
  for (const statement of statements) {
    for (const [pattern, message] of RULES) {
      if (pattern.test(statement)) warnings.add(message);
    }
  }
  return { statements: statements.length, warnings: [...warnings] };
}
