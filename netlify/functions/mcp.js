/*
  Remote MCP server — Streamable HTTP transport, stateless.

  Mount points (see netlify.toml):
    POST /mcp/<shared-secret>   the connector URL you paste into Claude
    POST /mcp                   same, with the secret in an Authorization header

  JSON-RPC 2.0 over a single POST, answered with a single JSON response. No
  SSE stream and no session id: every request carries everything it needs, so
  the function stays stateless across cold starts.

  Auth is a shared secret the operator sets as MCP_SHARED_SECRET. The Netlify
  access token the tools call with is never exposed to the client.
*/

const crypto = require('crypto');
const { toolSchemas, callTool, isReadOnly, siteAllowlist } = require('../lib/mcp-tools');
const { apiToken } = require('../lib/netlify-api');

const SERVER_INFO = { name: 'netlify-connector', title: 'Netlify', version: '1.0.0' };
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const LATEST_PROTOCOL = SUPPORTED_PROTOCOLS[0];

const INSTRUCTIONS = `Tools for administering Netlify sites through the Netlify API.

Call netlify_whoami first if you are unsure which account or site this connector reaches.
Identify a site by id, name or domain — most tools accept any of the three.
To diagnose a failed deploy: netlify_list_deploys with state "error", then netlify_get_deploy
for the error message and the build-log link.
Environment variable changes only reach the live site after a new build, so follow
netlify_set_env_var with netlify_trigger_build.`;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, Authorization, X-MCP-Token, Mcp-Session-Id, MCP-Protocol-Version, Accept',
  'Access-Control-Max-Age': '86400',
};
const JSON_HEADERS = { 'Content-Type': 'application/json', ...CORS_HEADERS };

function sharedSecret() {
  return process.env.MCP_SHARED_SECRET || process.env.NETLIFY_MCP_TOKEN || '';
}

function secretsMatch(given, expected) {
  // Hash first so the comparison is constant-time regardless of length.
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

// The secret can arrive four ways. The path is the one that matters most:
// Netlify rewrites /mcp/<secret> to this function, and whether the segment
// survives as a query parameter depends on how that rewrite is evaluated, so
// the function reads the original request path itself rather than trusting it.
function secretFromPath(path) {
  if (!path) return '';
  const match = /\/mcp\/([^/?#]+)/.exec(String(path));
  if (!match) return '';
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function presentedSecret(event) {
  const headers = event.headers || {};
  const query = event.queryStringParameters || {};
  const auth = headers.authorization || headers.Authorization || '';
  const bearer = /^Bearer\s+(.+)$/i.exec(auth);

  const candidates = [
    ['authorization header', bearer ? bearer[1].trim() : ''],
    ['x-mcp-token header', headers['x-mcp-token'] || ''],
    ['query parameter', query.k || query.token || ''],
    ['url path', secretFromPath(event.path) || secretFromPath(event.rawUrl)],
  ];

  const found = candidates.filter(([, value]) => value);
  return { value: found.length ? found[0][1] : '', sources: found.map(([name]) => name) };
}

function readBody(event) {
  if (!event.body) return '';
  return event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
}

function rpcError(id, code, message, data) {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message, ...(data ? { data } : {}) } };
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function textContent(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return [{ type: 'text', text }];
}

async function handleMessage(message) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return rpcError(message && message.id, -32600, 'Invalid JSON-RPC request.');
  }

  const { id, method, params } = message;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize': {
      const wanted = params && params.protocolVersion;
      return rpcResult(id, {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(wanted) ? wanted : LATEST_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }

    case 'notifications/initialized':
    case 'notifications/cancelled':
    case 'initialized':
      return null;

    case 'ping':
      return isNotification ? null : rpcResult(id, {});

    case 'tools/list':
      return rpcResult(id, { tools: toolSchemas() });

    // Declared in neither capability, but clients probe for them anyway.
    case 'resources/list':
      return rpcResult(id, { resources: [] });
    case 'resources/templates/list':
      return rpcResult(id, { resourceTemplates: [] });
    case 'prompts/list':
      return rpcResult(id, { prompts: [] });

    case 'tools/call': {
      const name = params && params.name;
      if (!name) return rpcError(id, -32602, 'tools/call requires a tool name.');
      try {
        const result = await callTool(name, (params && params.arguments) || {});
        return rpcResult(id, { content: textContent(result), isError: false });
      } catch (err) {
        console.error(`mcp tool ${name} failed:`, err && err.message);
        // Tool failures are results, not protocol errors, so the model can react.
        return rpcResult(id, {
          content: textContent(`Error from ${name}: ${(err && err.message) || 'unknown error'}`),
          isError: true,
        });
      }
    }

    default:
      return isNotification ? null : rpcError(id, -32601, `Method not found: ${method}`);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  // Stateless server: nothing to tear down, but clients expect a clean close.
  if (event.httpMethod === 'DELETE') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  // MCP itself is POST-only, but a plain GET is the one check anyone can run
  // from a browser address bar, so it reports whether the connector is wired
  // up. It names no secrets and needs none: only whether each is present.
  if (event.httpMethod === 'GET') {
    const configured = { netlify_api_token: !!apiToken(), shared_secret: !!sharedSecret() };
    const ready = configured.netlify_api_token && configured.shared_secret;
    return {
      statusCode: 200,
      headers: JSON_HEADERS,
      body: JSON.stringify(
        {
          server: SERVER_INFO,
          ready,
          configured,
          read_only: isReadOnly(),
          site_allowlist: siteAllowlist().length ? siteAllowlist() : null,
          tools: toolSchemas().length,
          protocol_versions: SUPPORTED_PROTOCOLS,
          next_step: ready
            ? 'Connector is configured. POST JSON-RPC here, with the shared secret in the URL path or an Authorization: Bearer header.'
            : 'Set the missing environment variable(s) in Netlify, then redeploy — env changes only reach a function on a new deploy.',
        },
        null,
        2
      ),
    };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { ...JSON_HEADERS, Allow: 'POST, DELETE, OPTIONS' },
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  const expected = sharedSecret();
  if (!expected) {
    // Fail closed. An unsecured endpoint would hand anyone the Netlify token's reach.
    return {
      statusCode: 503,
      headers: JSON_HEADERS,
      body: JSON.stringify({
        error:
          'This connector is not configured: MCP_SHARED_SECRET is unset, so the endpoint refuses every request.',
      }),
    };
  }
  if (!apiToken()) {
    return {
      statusCode: 503,
      headers: JSON_HEADERS,
      body: JSON.stringify({
        error: 'This connector is not configured: NETLIFY_API_TOKEN is unset.',
      }),
    };
  }

  const presented = presentedSecret(event);
  const given = presented.value;
  if (!given || !secretsMatch(given, expected)) {
    // Deliberately 403, not 401. A 401 is the MCP client's signal to start an
    // OAuth flow: it would go hunting for authorization-server metadata this
    // connector does not publish, fail dynamic client registration, and report
    // a sign-in problem instead of the real one. 403 says "wrong credential,
    // there is nothing to sign in to" and surfaces this message as-is.
    return {
      statusCode: 403,
      headers: JSON_HEADERS,
      body: JSON.stringify({
        error: given
          ? 'The shared secret in this request does not match MCP_SHARED_SECRET on the site. This connector uses no OAuth.'
          : 'No shared secret in this request. Use the full connector URL including its secret path segment (https://<site>/mcp/<MCP_SHARED_SECRET>), or send Authorization: Bearer <secret>. This connector uses no OAuth.',
        // Names where a secret was found, never what it was — enough to tell a
        // mistyped secret from one the rewrite dropped on the way in.
        secret_found_in: presented.sources.length ? presented.sources : null,
      }),
    };
  }

  let payload;
  try {
    payload = JSON.parse(readBody(event));
  } catch {
    return { statusCode: 400, headers: JSON_HEADERS, body: JSON.stringify(rpcError(null, -32700, 'Parse error.')) };
  }

  const batch = Array.isArray(payload);
  const messages = batch ? payload : [payload];
  if (batch && !messages.length) {
    return { statusCode: 400, headers: JSON_HEADERS, body: JSON.stringify(rpcError(null, -32600, 'Empty batch.')) };
  }

  const responses = [];
  for (const message of messages) {
    try {
      const response = await handleMessage(message);
      if (response) responses.push(response);
    } catch (err) {
      console.error('mcp dispatch failed:', err);
      responses.push(rpcError(message && message.id, -32603, (err && err.message) || 'Internal error.'));
    }
  }

  // Notifications only: acknowledge with no content, as the transport requires.
  if (!responses.length) {
    return { statusCode: 202, headers: CORS_HEADERS, body: '' };
  }

  return {
    statusCode: 200,
    headers: JSON_HEADERS,
    body: JSON.stringify(batch ? responses : responses[0]),
  };
};

// Exported for the local smoke test in scripts/mcp-smoke.js.
exports.handleMessage = handleMessage;
exports.meta = { SERVER_INFO, SUPPORTED_PROTOCOLS, isReadOnly, siteAllowlist };
