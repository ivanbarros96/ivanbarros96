# supabase-multi-mcp

Servidor MCP local (STDIO) para administrar entre 1 y 5 proyectos de Supabase,
aunque pertenezcan a cuentas diferentes, desde una sola conexión de Claude Code.

```
Claude Code ──(una conexión MCP)──> supabase-multi-mcp ──> Somos Luz
                                                       ├─> Cliente 1
                                                       └─> ... (hasta 5)
```

Cada operación indica explícitamente el `project_id` de destino. Cada proyecto
tiene su propio cliente con su URL y su clave; un `project_id` desconocido se
rechaza antes de hacer ninguna petición.

## Herramientas

| Herramienta      | Qué hace |
|------------------|----------|
| `list_projects`  | Lista los proyectos configurados (sin URLs ni claves). |
| `list_tables`    | Lista las tablas expuestas por la API REST del proyecto. |
| `read_records`   | Consulta con columnas, filtros, orden, `limit` (máx. 100) y `offset`. Devuelve el total. |
| `create_record`  | Inserta uno o varios registros (máx. 100). |
| `update_record`  | Actualiza con filtros obligatorios. Se rechaza si afecta a más de `max_rows` filas (por defecto 1). |
| `preview_delete` | Paso 1 del borrado: muestra las filas afectadas y devuelve un `confirmation_token`. |
| `delete_record`  | Paso 2 del borrado: requiere el token, el mismo proyecto, tabla y filtros. |

Filtros admitidos: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`, `ilike`,
`is` (null/boolean) e `in` (lista).

### Borrado en dos pasos

1. `preview_delete` devuelve las filas que se eliminarían y un token de un solo
   uso, válido 5 minutos y ligado a ese proyecto, tabla y filtros.
2. `delete_record` solo borra si el token es válido y el número de filas no ha
   cambiado desde la previsualización; si cambió, hay que previsualizar de nuevo.

El token impide borrados “a ciegas”, pero sigue siendo el modelo quien lo usa.
La aprobación humana real la da Claude Code: **no añadas `delete_record` ni
`update_record` a la lista de herramientas permitidas automáticamente**, para
que Claude Code te pida confirmación cada vez.

## Herramientas de gestión (Management API)

Si un proyecto tiene `accessTokenEnv` en `projects.json`, el MCP añade
herramientas que usan la [Management API](https://api.supabase.com/api/v1) con
el **token personal** (`sbp_...`) de la cuenta dueña de ese proyecto. Las
herramientas solo aparecen si al menos un proyecto tiene token, y
`list_projects` indica cuáles lo tienen (`management: true`).

| Herramienta | Qué hace |
|---|---|
| `get_project` | Región, versión de Postgres, estado y salud de cada servicio. |
| `execute_sql` | SQL de **solo lectura**, con el usuario de solo lectura de Supabase: la base de datos rechaza escrituras. |
| `describe_tables` | Columnas, tipos, claves, RLS, nº de políticas y filas estimadas. |
| `list_policies` | Políticas RLS. |
| `list_db_functions` | Funciones y procedimientos (RPC), opcionalmente con su código. |
| `list_triggers` | Triggers con su definición. |
| `list_extensions` | Extensiones instaladas o disponibles. |
| `list_migrations` | Migraciones aplicadas. |
| `list_backups` | Copias de seguridad y PITR. |
| `get_logs` | Logs por servicio (api, postgres, auth, storage, realtime, edge-function, edge-function-runtime), ventana máx. 24 h. |
| `query_logs` | SQL (ClickHouse) sobre los logs. |
| `get_advisors` | Avisos de seguridad o rendimiento. |
| `generate_typescript_types` | Tipos TypeScript del esquema. |
| `get_publishable_keys` | URL y claves **públicas** (publishable/anon). Nunca las secretas. |
| `list_storage_buckets` | Buckets de Storage. |
| `list_edge_functions` / `get_edge_function` | Lista y descarga el código de las Edge Functions. |
| `list_edge_function_secrets` | Nombres de los secretos (nunca los valores). |
| `execute_sql_write` | SQL que modifica datos. **Dos pasos.** |
| `apply_migration` | DDL registrado como migración; la previsualización muestra la última copia de seguridad. **Dos pasos.** |
| `deploy_edge_function` | Crea o actualiza una Edge Function. **Dos pasos.** |
| `delete_edge_function` | Elimina una Edge Function. **Dos pasos.** |

**Dos pasos:** la primera llamada (sin `confirmation_token`) no cambia nada:
devuelve una previsualización con avisos (DROP, TRUNCATE, DELETE/UPDATE sin
WHERE, desactivar RLS, permisos, esquemas internos…) y un token de un solo uso,
válido 10 minutos y ligado a los argumentos exactos. La segunda llamada, con el
token, ejecuta. Igual que con el borrado, deja que Claude te pida permiso para
estas herramientas.

**No incluidas a propósito:** crear, pausar, restaurar o borrar proyectos,
ramas (de pago), cambiar la configuración de Auth y escribir valores de
secretos (pasarían por el chat).

Seguridad:

- Un token personal da acceso a **todos** los proyectos de esa cuenta; el MCP
  solo lo usa con los proyectos configurados, y cada proyecto envía únicamente
  el token de su `accessTokenEnv`.
- Con `allowedTables` el SQL directo se desactiva (no se puede garantizar la
  lista); con `readOnly`, las herramientas de escritura.
- Los resultados de SQL y logs se marcan como datos no fiables para que el
  modelo no siga instrucciones escritas dentro de los datos.

Para activarlas, crea un token en
[supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens)
con cada cuenta, guárdalo en `.env` y añade al proyecto en `projects.json`:

```json
{ "id": "somos-luz", "...": "...", "accessTokenEnv": "SOMOS_LUZ_ACCESS_TOKEN" }
```

Dos proyectos de la misma cuenta pueden compartir la misma variable.

## Instalación en Windows

Requisitos: [Node.js LTS](https://nodejs.org/en/download) (comprueba con
`node --version` y `npm --version`).

En PowerShell, desde la carpeta del repositorio:

```powershell
cd supabase-multi-mcp
npm install
Copy-Item .env.example .env
Copy-Item projects.example.json projects.json
```

### Credenciales

En el [panel de Supabase](https://supabase.com/dashboard/projects), abre cada
proyecto → *Project Settings → API Keys* y copia la URL y la clave secreta
(`sb_secret_...`, o la antigua `service_role`). Rellena `.env`:

```
SUPABASE_SOMOS_LUZ_URL=https://xxxxxxxx.supabase.co
SUPABASE_SOMOS_LUZ_KEY=sb_secret_...
```

Estas claves se saltan RLS: son secretos administrativos. `.env` y
`projects.json` están en `.gitignore`; no los subas ni los pegues en un chat.

### Proyectos

Edita `projects.json` (de 1 a 5 entradas):

```json
{
  "projects": [
    {
      "id": "somos-luz",
      "name": "Somos Luz",
      "urlEnv": "SUPABASE_SOMOS_LUZ_URL",
      "keyEnv": "SUPABASE_SOMOS_LUZ_KEY"
    },
    {
      "id": "cliente-1",
      "name": "Cliente 1",
      "urlEnv": "SUPABASE_CLIENTE_1_URL",
      "keyEnv": "SUPABASE_CLIENTE_1_KEY",
      "allowedTables": ["pedidos", "clientes"],
      "readOnly": true
    }
  ]
}
```

- `id`: minúsculas, números y guiones. Es lo que usarás al hablar con Claude.
- `allowedTables` (opcional): solo esas tablas serán accesibles.
- `readOnly` (opcional): bloquea inserciones, actualizaciones y borrados.

El servidor no arranca si falta alguna credencial, si una URL no es de
`*.supabase.co`, o si dos proyectos comparten URL.

### Comprobar

```powershell
npm run typecheck
npm test
npm run dev
```

`npm test` usa un Supabase simulado en memoria; no toca tus bases reales.
`npm run dev` parecerá quedarse quieto: está esperando mensajes MCP por STDIO.
Debe mostrar `supabase-multi-mcp listo con N proyecto(s)`. Detenlo con `Ctrl + C`.

## Conectar con Claude Code

Desde la carpeta `supabase-multi-mcp`, en PowerShell:

```powershell
$mcp = (Get-Location).Path
claude mcp add --scope user --transport stdio supabase-multi-mcp -- node "$mcp\node_modules\tsx\dist\cli.mjs" "$mcp\src\index.ts"
claude mcp list
```

Se usa `node` directamente (sin `npx`) para evitar el envoltorio `cmd /c` que
Windows necesita con `npx`. `.env` y `projects.json` se cargan siempre desde la
carpeta del MCP, así que Claude Code puede lanzarlo desde cualquier directorio.

Abre Claude Code en cualquier proyecto y ejecuta `/mcp` para verificar que
`supabase-multi-mcp` aparece conectado.

## Despliegue en un VPS (modo HTTP)

Con `MCP_TRANSPORT=http` el servidor escucha en `/mcp` y exige la cabecera
`Authorization: Bearer <MCP_AUTH_TOKEN>` (mínimo 32 caracteres). `/health`
responde sin autenticación y sin datos, para el healthcheck.

En el VPS (por SSH o el terminal del panel de Hostinger):

```bash
git clone -b claude/supabase-multi-mcp-server-yhvmod https://github.com/ivanbarros96/ivanbarros96.git
cd ivanbarros96/supabase-multi-mcp
cp .env.example .env && cp projects.example.json projects.json
openssl rand -hex 32          # copia el resultado en MCP_AUTH_TOKEN
nano .env                     # URLs, claves, token, dominio, red de Traefik
nano projects.json
chmod 600 .env
docker compose up -d --build
docker compose logs -f        # debe decir "supabase-multi-mcp (HTTP) ... N proyecto(s)"
```

`docker-compose.yml` asume que Traefik ya está en el servidor (como en la
plantilla n8n de Hostinger). Comprueba la red y el certresolver con
`docker network ls` y las etiquetas del contenedor de n8n, y crea un registro
DNS `A` de `MCP_DOMAIN` apuntando a la IP del VPS.

Conectar Claude Code (terminal o escritorio):

```bash
claude mcp add --scope user --transport http supabase-multi https://mcp.tudominio.com/mcp --header "Authorization: Bearer TU_TOKEN"
```

Para actualizar: `git pull && docker compose up -d --build`.

### Conector personalizado de Claude (OAuth)

Los conectores de claude.ai (Chat, escritorio y móvil) no admiten cabeceras
fijas, así que el servidor incluye un servidor OAuth 2.1 mínimo para un solo
usuario. Se activa solo cuando conoce su URL pública (`MCP_DOMAIN` o
`PUBLIC_URL`) y convive con el token fijo de Claude Code.

1. En Claude: *Configuración → Conectores → Agregar conector personalizado*.
   Nombre: `supabase-multi`. URL: `https://mcp.tudominio.com/mcp`.
2. Claude abre la pantalla «Autorizar acceso»: escribe la contraseña y pulsa
   *Autorizar*. La contraseña es `OAUTH_PASSWORD` o, si no la defines,
   `MCP_AUTH_TOKEN`.

Seguridad:

- Solo se entregan códigos a `https://claude.ai/api/mcp/auth_callback`,
  `https://claude.com/api/mcp/auth_callback` y a `localhost`.
- PKCE (S256) obligatorio; cada código vale una vez y caduca a los 5 minutos.
- Tras 5 contraseñas fallidas desde una IP, se bloquea 15 minutos.
- Los tokens van firmados con una clave derivada de `MCP_AUTH_TOKEN`: el
  acceso dura 1 hora y la renovación, 30 días. No se guardan en disco.
- Para revocar todos los accesos OAuth, cambia `MCP_AUTH_TOKEN` y vuelve a
  conectar Claude Code y el conector.

## Primeras pruebas

1. «Usa `list_projects` y muéstrame los proyectos configurados. No modifiques datos.»
2. «Usa `list_tables` en `somos-luz`. Sin escrituras.»
3. «Lee los primeros 5 registros de la tabla `perfiles` de `somos-luz`.»

Comprueba que cada proyecto devuelve sus propias tablas antes de probar
escrituras, y hazlo primero sobre una tabla de pruebas.

## Limitaciones

- Solo trabaja con el esquema `public` expuesto por la API REST de Supabase.
- `list_tables` depende del esquema OpenAPI de PostgREST; si lo tienes
  desactivado, indica el nombre de la tabla directamente.
- Sin `accessTokenEnv`, el proyecto solo tiene las herramientas de datos: no
  ejecuta SQL ni cambia el esquema.
- La detección de SQL peligroso es heurística (no analiza SQL dinámico ni
  cadenas complejas); la protección real es tu confirmación.
