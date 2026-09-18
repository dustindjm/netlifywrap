/*
  Offline smoke test for the MCP connector.

    node scripts/mcp-smoke.js

  Drives netlify/functions/mcp.js the way Claude would — initialize, notify,
  tools/list, tools/call — against a stubbed Netlify API, so the JSON-RPC
  shapes, the auth gate and the read-only gate are all verified without a
  deploy and without touching a real account.
*/

const assert = require('assert');

const SECRET = 'test-secret-value';

const SITE = {
  id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
  name: 'reinstated',
  url: 'http://reinstated.netlify.app',
  ssl_url: 'https://reinstated.site',
  admin_url: 'https://app.netlify.com/sites/reinstated',
  custom_domain: 'reinstated.site',
  account_slug: 'dustin',
  account_name: 'Dustin',
  build_settings: { repo_url: 'https://github.com/dustindjm/letter', repo_branch: 'main', cmd: 'npm run build', dir: 'public' },
  published_deploy: { id: 'dep_ready', state: 'ready', branch: 'main', commit_ref: 'abc123', created_at: '2026-09-01T00:00:00Z' },
  created_at: '2025-01-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
};

const calls = [];

// Minimal stand-in for api.netlify.com.
global.fetch = async (url, options = {}) => {
  const u = new URL(String(url));
  const method = options.method || 'GET';
  const path = u.pathname.replace('/api/v1', '');
  calls.push(`${method} ${path}${u.search}`);

  assert.match(options.headers.Authorization, /^Bearer /, 'every API call must be authenticated');

  const json = (data, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

  if (path === '/user') return json({ id: 'u1', email: 'dustindjm@outlook.com', full_name: 'Dustin', slug: 'dustin' });
  if (path === '/accounts') return json([{ id: 'a1', slug: 'dustin', name: 'Dustin', type_name: 'Personal' }]);
  if (path === '/sites' && method === 'GET') return json([SITE]);
  if (path === `/sites/${SITE.id}`) return json(SITE);
  if (path === `/sites/${SITE.id}/deploys`) {
    return json([
      { id: 'dep_err', site_id: SITE.id, state: 'error', branch: 'main', commit_ref: 'def456', error_message: 'Build script returned non-zero exit code: 1', created_at: '2026-09-02T00:00:00Z' },
    ]);
  }
  if (path === `/sites/${SITE.id}/builds` && method === 'POST') {
    assert.deepStrictEqual(JSON.parse(options.body), { clear_cache: true });
    return json({ id: 'build_1', deploy_id: 'dep_new' });
  }
  if (path === '/accounts/dustin/env' && method === 'GET') {
    return json([
      { key: 'GEMINI_API_KEY', scopes: ['builds', 'functions'], is_secret: true, values: [{ context: 'all', value: 'super-secret' }] },
      { key: 'PUBLIC_FLAG', scopes: ['builds'], is_secret: false, values: [{ context: 'all', value: 'on' }] },
    ]);
  }
  if (path === '/accounts/dustin/env/NEW_VAR' && method === 'GET') return json({ message: 'Not Found' }, 404);
  if (path === '/accounts/dustin/env' && method === 'POST') {
    const body = JSON.parse(options.body);
    assert.strictEqual(body[0].key, 'NEW_VAR');
    assert.strictEqual(body[0].values[0].value, 'hello');
    return json(body);
  }

  return json({ message: `unstubbed ${method} ${path}` }, 404);
};

function request(body, { secret = SECRET, method = 'POST' } = {}) {
  delete require.cache[require.resolve('../netlify/functions/mcp.js')];
  const { handler } = require('../netlify/functions/mcp.js');
  return handler({
    httpMethod: method,
    headers: {},
    queryStringParameters: secret === null ? {} : { k: secret },
    body: body === undefined ? null : JSON.stringify(body),
    isBase64Encoded: false,
  });
}

async function rpc(method, params, options) {
  const res = await request({ jsonrpc: '2.0', id: 1, method, params }, options);
  assert.strictEqual(res.statusCode, 200, `${method} → ${res.statusCode}: ${res.body}`);
  const parsed = JSON.parse(res.body);
  assert.ok(!parsed.error, `${method} returned an error: ${JSON.stringify(parsed.error)}`);
  return parsed.result;
}

async function callTool(name, args) {
  const result = await rpc('tools/call', { name, arguments: args || {} });
  const text = result.content.map((c) => c.text).join('\n');
  return { isError: result.isError, text, data: result.isError ? null : JSON.parse(text) };
}

const checks = [];
function test(name, fn) {
  checks.push([name, fn]);
}

test('refuses every request when the shared secret is unconfigured', async () => {
  const saved = process.env.MCP_SHARED_SECRET;
  delete process.env.MCP_SHARED_SECRET;
  const res = await request({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  process.env.MCP_SHARED_SECRET = saved;
  assert.strictEqual(res.statusCode, 503);
  assert.match(JSON.parse(res.body).error, /MCP_SHARED_SECRET/);
});

test('rejects a wrong secret, and a missing one', async () => {
  assert.strictEqual((await request({ jsonrpc: '2.0', id: 1, method: 'initialize' }, { secret: 'nope' })).statusCode, 401);
  assert.strictEqual((await request({ jsonrpc: '2.0', id: 1, method: 'initialize' }, { secret: null })).statusCode, 401);
  // A secret of a different length must not crash the constant-time compare.
  assert.strictEqual((await request({ jsonrpc: '2.0', id: 1, method: 'initialize' }, { secret: 'x' })).statusCode, 401);
});

test('initialize negotiates the protocol version and names the server', async () => {
  const result = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {} });
  assert.strictEqual(result.protocolVersion, '2025-03-26');
  assert.strictEqual(result.serverInfo.name, 'netlify-connector');
  assert.ok(result.capabilities.tools);
  assert.match(result.instructions, /netlify_whoami/);

  const unknown = await rpc('initialize', { protocolVersion: '1999-01-01' });
  assert.strictEqual(unknown.protocolVersion, '2025-06-18');
});

test('the initialized notification is acknowledged with no body', async () => {
  const res = await request({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.strictEqual(res.statusCode, 202);
  assert.strictEqual(res.body, '');
});

test('OPTIONS preflight passes CORS', async () => {
  const res = await request(undefined, { method: 'OPTIONS' });
  assert.strictEqual(res.statusCode, 204);
  assert.strictEqual(res.headers['Access-Control-Allow-Origin'], '*');
});

test('tools/list advertises every tool with a schema and annotations', async () => {
  const { tools } = await rpc('tools/list');
  assert.ok(tools.length >= 15, `only ${tools.length} tools`);
  for (const tool of tools) {
    assert.match(tool.name, /^netlify_/);
    assert.ok(tool.description && tool.description.length > 20, `${tool.name} needs a description`);
    assert.strictEqual(tool.inputSchema.type, 'object');
    assert.strictEqual(typeof tool.annotations.readOnlyHint, 'boolean');
  }
  assert.ok(tools.some((t) => t.name === 'netlify_trigger_build'));
});

test('a browser GET reports whether the connector is wired up', async () => {
  const res = await request(undefined, { method: 'GET', secret: null });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.strictEqual(body.ready, true);
  assert.deepStrictEqual(body.configured, { netlify_api_token: true, shared_secret: true });
  assert.ok(body.tools >= 15);
  // It must never echo the secrets themselves.
  assert.ok(!res.body.includes(SECRET), 'GET must not leak the shared secret');
  assert.ok(!res.body.includes('nfp_fake_token'), 'GET must not leak the API token');

  const saved = process.env.NETLIFY_API_TOKEN;
  delete process.env.NETLIFY_API_TOKEN;
  const missing = JSON.parse((await request(undefined, { method: 'GET', secret: null })).body);
  process.env.NETLIFY_API_TOKEN = saved;
  assert.strictEqual(missing.ready, false);
  assert.strictEqual(missing.configured.netlify_api_token, false);
  assert.match(missing.next_step, /redeploy/);
});

test('unknown methods get a JSON-RPC method-not-found', async () => {
  const res = await request({ jsonrpc: '2.0', id: 7, method: 'does/not/exist' });
  assert.strictEqual(JSON.parse(res.body).error.code, -32601);
});

test('malformed JSON gets a parse error', async () => {
  delete require.cache[require.resolve('../netlify/functions/mcp.js')];
  const { handler } = require('../netlify/functions/mcp.js');
  const res = await handler({ httpMethod: 'POST', headers: {}, queryStringParameters: { k: SECRET }, body: '{oops' });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(JSON.parse(res.body).error.code, -32700);
});

test('whoami reports the account and the connector mode', async () => {
  const { data } = await callTool('netlify_whoami');
  assert.strictEqual(data.user.slug, 'dustin');
  assert.strictEqual(data.connector.read_only, false);
});

test('a site resolves by name, and deploy errors come back readable', async () => {
  const { data } = await callTool('netlify_list_deploys', { site: 'reinstated', state: 'error' });
  assert.strictEqual(data.site.name, 'reinstated');
  assert.strictEqual(data.deploys[0].state, 'error');
  assert.match(data.deploys[0].error_message, /non-zero exit code/);
  assert.strictEqual(data.deploys[0].log_url, 'https://app.netlify.com/sites/reinstated/deploys/dep_err');
});

test('a site resolves by custom domain too', async () => {
  const { data } = await callTool('netlify_get_site', { site: 'https://reinstated.site/' });
  assert.strictEqual(data.id, SITE.id);
  assert.strictEqual(data.repo, 'https://github.com/dustindjm/letter');
});

test('environment variable values are withheld unless asked for', async () => {
  const hidden = await callTool('netlify_list_env_vars', { site: 'reinstated' });
  assert.strictEqual(hidden.data.variables[1].values[0].value, undefined);
  assert.strictEqual(hidden.data.variables[1].values[0].value_set, true);

  const shown = await callTool('netlify_list_env_vars', { site: 'reinstated', include_values: true });
  assert.strictEqual(shown.data.variables[1].values[0].value, 'on');
  // A secret variable stays hidden even then.
  assert.strictEqual(shown.data.variables[0].values[0].value, undefined);
});

test('a new environment variable is created, not patched', async () => {
  const { data } = await callTool('netlify_set_env_var', { site: 'reinstated', key: 'NEW_VAR', value: 'hello' });
  assert.strictEqual(data.created, true);
  assert.match(data.note, /Trigger a build/);
});

test('triggering a build posts to the builds endpoint', async () => {
  const { data } = await callTool('netlify_trigger_build', { site: 'reinstated', clear_cache: true });
  assert.strictEqual(data.triggered, true);
  assert.strictEqual(data.deploy_id, 'dep_new');
});

test('a failing API call surfaces as a tool error, not a protocol error', async () => {
  const { isError, text } = await callTool('netlify_list_forms', { site: 'reinstated' });
  assert.strictEqual(isError, true);
  assert.match(text, /unstubbed/);
});

test('read-only mode hides write tools and refuses them if called anyway', async () => {
  process.env.NETLIFY_MCP_READ_ONLY = 'true';
  try {
    const { tools } = await rpc('tools/list');
    assert.ok(!tools.some((t) => t.name === 'netlify_trigger_build'), 'write tools must be hidden');
    assert.ok(tools.some((t) => t.name === 'netlify_list_deploys'), 'read tools must remain');
    const { isError, text } = await callTool('netlify_trigger_build', { site: 'reinstated' });
    assert.strictEqual(isError, true);
    assert.match(text, /read-only/);
  } finally {
    delete process.env.NETLIFY_MCP_READ_ONLY;
  }
});

test('a site allowlist blocks other sites and disables the raw API tool', async () => {
  process.env.NETLIFY_MCP_SITES = 'some-other-site';
  try {
    const { tools } = await rpc('tools/list');
    assert.ok(!tools.some((t) => t.name === 'netlify_api_request'), 'raw API must be off under an allowlist');
    const { isError, text } = await callTool('netlify_get_site', { site: 'reinstated' });
    assert.strictEqual(isError, true);
    assert.match(text, /allowlist/);
  } finally {
    delete process.env.NETLIFY_MCP_SITES;
  }
});

test('a blocked site cannot fall back to a team-wide variable read', async () => {
  process.env.NETLIFY_MCP_SITES = 'some-other-site';
  try {
    const { isError, text } = await callTool('netlify_get_env_var', { site: 'reinstated', key: 'GEMINI_API_KEY' });
    assert.strictEqual(isError, true);
    assert.match(text, /allowlist/);
  } finally {
    delete process.env.NETLIFY_MCP_SITES;
  }
});

test('the default site is used when a tool omits one', async () => {
  process.env.NETLIFY_MCP_DEFAULT_SITE = SITE.id;
  try {
    const { data } = await callTool('netlify_get_site');
    assert.strictEqual(data.name, 'reinstated');
  } finally {
    delete process.env.NETLIFY_MCP_DEFAULT_SITE;
  }
});

test('missing configuration is reported rather than guessed at', async () => {
  const saved = process.env.NETLIFY_API_TOKEN;
  delete process.env.NETLIFY_API_TOKEN;
  const res = await request({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  process.env.NETLIFY_API_TOKEN = saved;
  assert.strictEqual(res.statusCode, 503);
  assert.match(JSON.parse(res.body).error, /NETLIFY_API_TOKEN/);
});

(async () => {
  process.env.MCP_SHARED_SECRET = SECRET;
  process.env.NETLIFY_API_TOKEN = 'nfp_fake_token';
  delete process.env.SITE_ID;

  let failed = 0;
  for (const [name, fn] of checks) {
    try {
      await fn();
      console.log(`  ok   ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`  FAIL ${name}\n       ${err.message}`);
    }
  }
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed ? 1 : 0);
})();
