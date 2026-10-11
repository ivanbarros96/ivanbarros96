// PostgREST mínimo en memoria para probar el MCP sin tocar bases reales.
// Solo implementa lo que usa el servidor: select/insert/update/delete,
// filtros eq/neq/gt/lt/in/is, conteo exacto, rango y la raíz OpenAPI.

type Row = Record<string, unknown>;

export type FakeProject = {
  url: string;
  key: string;
  tables: Record<string, Row[]>;
};

export type RecordedRequest = {
  method: string;
  url: string;
  apikey: string | null;
};

function parseValue(raw: string): unknown {
  if (raw === "null") return null;
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw.replace(/^"(.*)"$/, "$1");
}

function matches(row: Row, params: URLSearchParams): boolean {
  for (const [column, expr] of params) {
    if (["select", "limit", "offset", "order", "columns"].includes(column)) continue;
    const dot = expr.indexOf(".");
    const op = expr.slice(0, dot);
    const raw = expr.slice(dot + 1);
    const value = row[column];

    switch (op) {
      case "eq": if (value !== parseValue(raw)) return false; break;
      case "neq": if (value === parseValue(raw)) return false; break;
      case "gt": if (!((value as number) > (parseValue(raw) as number))) return false; break;
      case "lt": if (!((value as number) < (parseValue(raw) as number))) return false; break;
      case "is": if (value !== parseValue(raw)) return false; break;
      case "in": {
        const list = raw.replace(/^\(|\)$/g, "").split(",").map(parseValue);
        if (!list.includes(value)) return false;
        break;
      }
      default: throw new Error(`Operador no soportado en el fake: ${op}`);
    }
  }
  return true;
}

export function createFakeSupabase(projects: FakeProject[]) {
  const requests: RecordedRequest[] = [];

  const fetchImpl = async (
    input: string | URL | Request,
    init: RequestInit = {}
  ): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    const apikey = headers.get("apikey");
    requests.push({ method, url: url.toString(), apikey });

    const project = projects.find(p => url.origin === new URL(p.url).origin);
    if (!project || apikey !== project.key) {
      return new Response(JSON.stringify({ message: "Invalid API key" }), { status: 401 });
    }

    if (url.pathname === "/rest/v1/" || url.pathname === "/rest/v1") {
      const paths: Record<string, unknown> = { "/": {} };
      for (const name of Object.keys(project.tables)) paths[`/${name}`] = {};
      paths["/rpc/some_function"] = {};
      return Response.json({ paths });
    }

    const table = url.pathname.replace(/^\/rest\/v1\//, "");
    const rows = project.tables[table];
    if (!rows) {
      return new Response(
        JSON.stringify({ message: `relation "public.${table}" does not exist` }),
        { status: 404 }
      );
    }

    const params = url.searchParams;
    const prefer = headers.get("prefer") ?? "";
    const selected = rows.filter(r => matches(r, params));

    const respond = (data: Row[], total: number) => {
      const responseHeaders = new Headers({ "content-type": "application/json" });
      if (prefer.includes("count=exact")) {
        responseHeaders.set("content-range", `0-${Math.max(data.length - 1, 0)}/${total}`);
      }
      const body = method === "HEAD" ? null : JSON.stringify(data);
      return new Response(body, { status: 200, headers: responseHeaders });
    };

    switch (method) {
      case "GET":
      case "HEAD": {
        const offset = Number(params.get("offset") ?? 0);
        const limit = params.has("limit") ? Number(params.get("limit")) : selected.length;
        return respond(selected.slice(offset, offset + limit), selected.length);
      }
      case "POST": {
        const body = JSON.parse(String(init.body)) as Row | Row[];
        const inserted = Array.isArray(body) ? body : [body];
        rows.push(...inserted);
        return respond(inserted, inserted.length);
      }
      case "PATCH": {
        const patch = JSON.parse(String(init.body)) as Row;
        for (const row of selected) Object.assign(row, patch);
        return respond(selected, selected.length);
      }
      case "DELETE": {
        project.tables[table] = rows.filter(r => !selected.includes(r));
        return respond(selected, selected.length);
      }
      default:
        return new Response(null, { status: 405 });
    }
  };

  return { fetch: fetchImpl as typeof fetch, requests };
}
