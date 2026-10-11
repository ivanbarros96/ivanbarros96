import { z } from "zod";

const IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function validateIdentifier(value: string, label: string): void {
  if (!IDENTIFIER.test(value)) {
    throw new Error(`${label} no válido: ${value}`);
  }
}

export function parseColumns(columns: string | undefined): string {
  if (columns === undefined || columns.trim() === "*") return "*";

  const list = columns.split(",").map(c => c.trim());
  for (const column of list) validateIdentifier(column, "Nombre de columna");
  return list.join(",");
}

const scalar = z.union([z.string(), z.number(), z.boolean()]);

export const filterSchema = z.object({
  column: z.string().min(1),
  operator: z.enum([
    "eq", "neq", "gt", "gte", "lt", "lte",
    "like", "ilike", "is", "in"
  ]),
  value: z.union([scalar, z.null(), z.array(scalar)])
});

export type Filter = z.infer<typeof filterSchema>;

// Mínimo común de los builders de PostgREST que usamos para filtrar.
export interface Filterable<T> {
  eq(column: string, value: unknown): T;
  neq(column: string, value: unknown): T;
  gt(column: string, value: unknown): T;
  gte(column: string, value: unknown): T;
  lt(column: string, value: unknown): T;
  lte(column: string, value: unknown): T;
  like(column: string, pattern: string): T;
  ilike(column: string, pattern: string): T;
  is(column: string, value: boolean | null): T;
  in(column: string, values: readonly unknown[]): T;
}

export function validateFilters(filters: Filter[]): void {
  for (const filter of filters) {
    validateIdentifier(filter.column, "Nombre de columna");
    const { operator, value } = filter;

    if (operator === "in") {
      if (!Array.isArray(value) || value.length === 0) {
        throw new Error("El filtro in requiere una lista no vacía.");
      }
    } else if (operator === "is") {
      if (value !== null && typeof value !== "boolean") {
        throw new Error("El operador is admite null o boolean.");
      }
    } else if (value === null) {
      throw new Error("Para comparar con null utiliza el operador is.");
    } else if (Array.isArray(value)) {
      throw new Error(`El operador ${operator} no admite listas.`);
    } else if (
      (operator === "like" || operator === "ilike") &&
      typeof value !== "string"
    ) {
      throw new Error(`El operador ${operator} requiere un texto.`);
    }
  }
}

export function applyFilters<T extends Filterable<T>>(
  query: T,
  filters: Filter[]
): T {
  validateFilters(filters);

  for (const { column, operator, value } of filters) {
    switch (operator) {
      case "in":
        query = query.in(column, value as unknown[]);
        break;
      case "is":
        query = query.is(column, value as boolean | null);
        break;
      case "like":
      case "ilike":
        query = query[operator](column, value as string);
        break;
      default:
        query = query[operator](column, value);
    }
  }

  return query;
}
