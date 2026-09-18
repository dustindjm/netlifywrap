# Netlify MCP Connector

A remote [MCP](https://modelcontextprotocol.io) server that wraps the Netlify API, deployed as
a Netlify site. Add the URL to Claude as a custom connector and Claude can administer Netlify
from a conversation: read failed deploys, trigger builds, roll back, and manage environment
variables.

The site root is a live console for the same endpoint: unlock it with the shared secret and you
get your sites, their deploy history, failed-build error messages, one-click builds and
rollbacks, and the site's environment variables — every panel driven by real MCP tool calls, so
what you see is exactly what Claude sees. It also hands you the connector URL to paste into
Claude.

```
netlify/functions/mcp.js    MCP transport: JSON-RPC over HTTP, auth, dispatch
netlify/lib/netlify-api.js  Netlify API v1 client and response trimming
netlify/lib/mcp-tools.js    Tool definitions and handlers
public/index.html           Live console: sites, deploys, builds, env vars
scripts/mcp-smoke.js        Offline test suite (npm test)
```

## Deploy

1. Create this as a Netlify site from the repo. There is no build step — `public/` is published
   as-is and the function is bundled by Netlify.
2. Create a Netlify personal access token: **User settings → Applications → Personal access
   tokens**. It carries your full Netlify permissions.
3. Set two environment variables under **Site configuration → Environment variables**:

   | Variable | Value |
   | --- | --- |
   | `NETLIFY_API_TOKEN` | the personal access token |
   | `MCP_SHARED_SECRET` | a long random string |

4. Redeploy, then open the site root and unlock it with the secret. If the console loads your
   sites, the connector works.
5. Copy the connector URL from the console into Claude: **Settings → Connectors → Add custom
   connector**. It is `https://<your-site>/mcp/<MCP_SHARED_SECRET>`.

## Endpoint

| Endpoint | Purpose |
| --- | --- |
| `POST /mcp/<secret>` | MCP over Streamable HTTP. The secret rides in the path because Claude's connector form takes a URL and nothing else. |
| `POST /mcp` | Same endpoint with the secret in an `Authorization: Bearer` header, for clients that can send one. |

Stateless: one JSON-RPC request, one JSON response, no SSE stream and no session id, so it
survives cold starts. Protocol versions `2025-06-18`, `2025-03-26` and `2024-11-05` are
negotiated on `initialize`. Tool failures come back as results with `isError` rather than
JSON-RPC protocol errors, so the model can read the error and react.

## Configuration

| Variable | Purpose |
| --- | --- |
| `NETLIFY_API_TOKEN` | **Required.** Token the tools call Netlify with. Never sent to the client. Also read from `NETLIFY_AUTH_TOKEN` or `NETLIFY_PAT`. |
| `MCP_SHARED_SECRET` | **Required.** Shared secret in the connector URL. Rotating it invalidates every existing URL. Also read from `NETLIFY_MCP_TOKEN`. |
| `NETLIFY_MCP_READ_ONLY` | `true` hides every write tool from `tools/list` and refuses it if called anyway |
| `NETLIFY_MCP_SITES` | Comma-separated site ids/names to restrict the connector to; also disables the raw API tool |
| `NETLIFY_MCP_DEFAULT_SITE` | Site used when a tool call omits one |
| `NETLIFY_MCP_ACCOUNT` | Default team slug for environment-variable tools |

With either required variable missing, the endpoint answers `503` for every request — it fails
closed rather than exposing the token's reach to whoever finds the URL. A wrong or absent
secret gets `401`, compared in constant time over SHA-256 digests so length doesn't leak.

## Tools

**Read** — `netlify_whoami`, `netlify_list_accounts`, `netlify_list_sites`, `netlify_get_site`,
`netlify_list_deploys`, `netlify_get_deploy`, `netlify_list_site_functions`,
`netlify_list_build_hooks`, `netlify_list_forms`, `netlify_list_form_submissions`,
`netlify_list_env_vars`, `netlify_get_env_var`.

**Write** — `netlify_trigger_build`, `netlify_cancel_deploy`, `netlify_rollback_deploy`,
`netlify_lock_deploy`, `netlify_unlock_deploy`, `netlify_set_env_var`,
`netlify_delete_env_var`.

**Escape hatch** — `netlify_api_request` reaches any Netlify API v1 endpoint for what the tools
above don't cover (DNS, members, snippets, service instances). `GET` always; other methods only
outside read-only mode. Disabled entirely when `NETLIFY_MCP_SITES` is set, since a raw
passthrough would defeat the restriction.

Most tools accept a site id, site name, `*.netlify.app` host or custom domain as `site`.
Responses are trimmed to the fields worth spending context on — a raw Netlify site object is
mostly empty build plumbing — with `full: true` where the whole object is wanted. Environment
variable values are withheld unless a call asks for them, and values Netlify holds as secret
are never returned.

## Tests

```bash
npm test
```

Drives the function the way a client does — `initialize`, `notifications/initialized`,
`tools/list`, `tools/call` — against a stubbed Netlify API. 20 checks covering protocol
negotiation, the auth gate, the read-only gate, the site allowlist, site resolution by name and
by custom domain, value redaction, and error shaping. No deploy, no real account, no network.

## Local development

```bash
npm install -g netlify-cli
NETLIFY_API_TOKEN=... MCP_SHARED_SECRET=dev-secret netlify dev
```

Then `http://localhost:8888/` for the console, or drive the endpoint directly:

```bash
curl -s http://localhost:8888/mcp/dev-secret \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -40
```

## Notes

Independent of Netlify. "Netlify" is a trademark of Netlify, Inc.; this project is not
affiliated with or endorsed by them.
