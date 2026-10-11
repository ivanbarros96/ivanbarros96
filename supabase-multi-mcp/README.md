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
- No ejecuta SQL arbitrario ni cambia el esquema (sin migraciones).
