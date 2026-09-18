/*
  Tool definitions for the Netlify MCP connector.

  Each entry is { name, title, description, inputSchema, write, handler }.
  `write` tools disappear from tools/list and are refused when the site runs
  with NETLIFY_MCP_READ_ONLY set. Handlers return plain JS values; the
  transport in ../functions/mcp.js serialises them.
*/

const { api, summarizeSite, summarizeDeploy, summarizeEnvVar } = require('./netlify-api');

const DEFAULT_SCOPES = ['builds', 'functions', 'runtime', 'post-processing'];
const CONTEXTS = ['all', 'dev', 'branch-deploy', 'deploy-preview', 'production', 'branch'];

function truthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function isReadOnly() {
  return truthy(process.env.NETLIFY_MCP_READ_ONLY);
}

function siteAllowlist() {
  return (process.env.NETLIFY_MCP_SITES || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function rawApiEnabled() {
  // An allowlist means "this connector only touches these sites", which a raw
  // API passthrough would silently defeat.
  return siteAllowlist().length === 0;
}

function assertSiteAllowed(site) {
  const allow = siteAllowlist();
  if (!allow.length) return;
  const id = String(site.id || '').toLowerCase();
  const name = String(site.name || '').toLowerCase();
  if (!allow.includes(id) && !allow.includes(name)) {
    throw new Error(
      `Site "${site.name || site.id}" is not in this connector's NETLIFY_MCP_SITES allowlist.`
    );
  }
}

function looksLikeId(value) {
  return /^[0-9a-f]{24}$/i.test(value) || /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value);
}

/** Accepts a site id, a site name, a *.netlify.app host, or a custom domain. */
async function resolveSite(input) {
  const wanted = String(
    input || process.env.NETLIFY_MCP_DEFAULT_SITE || process.env.SITE_ID || ''
  ).trim();
  if (!wanted) {
    throw new Error(
      'No site given. Pass `site` (id, name or domain), or set NETLIFY_MCP_DEFAULT_SITE on the connector.'
    );
  }

  let site = null;
  if (looksLikeId(wanted)) {
    site = await api(`/sites/${encodeURIComponent(wanted)}`);
  } else {
    const host = wanted.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    const name = host.endsWith('.netlify.app') ? host.slice(0, -'.netlify.app'.length) : host;
    const matches = (await api('/sites', { query: { name, filter: 'all', per_page: 20 } })) || [];
    site =
      matches.find((s) => s.name === name) ||
      matches.find((s) => s.custom_domain === host) ||
      matches.find((s) => (s.domain_aliases || []).includes(host)) ||
      matches[0] ||
      null;
    if (!site) site = await api(`/sites/${encodeURIComponent(wanted)}`);
  }

  assertSiteAllowed(site);
  return site;
}

async function resolveAccountSlug(explicit, site) {
  if (explicit) return explicit;
  if (site && site.account_slug) return site.account_slug;
  if (process.env.NETLIFY_MCP_ACCOUNT) return process.env.NETLIFY_MCP_ACCOUNT;
  const accounts = (await api('/accounts')) || [];
  if (!accounts.length) throw new Error('Could not determine a Netlify account slug.');
  return accounts[0].slug;
}

const SITE_PROP = {
  type: 'string',
  description:
    'Site id, site name, *.netlify.app host, or custom domain. Optional when the connector has a default site configured.',
};
const PAGING_PROPS = {
  page: { type: 'integer', minimum: 1, description: 'Page number, 1-based.' },
  per_page: { type: 'integer', minimum: 1, maximum: 100, description: 'Items per page (default 20).' },
};

const TOOLS = [
  /* ---------------------------------------------------------------- read */
  {
    name: 'netlify_whoami',
    title: 'Who am I',
    description:
      'Return the Netlify user the connector\'s access token belongs to, and the connector\'s current mode (read-only, default site, site allowlist). Useful first call to confirm the connector is wired up.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async handler() {
      const user = await api('/user');
      return {
        user: { id: user.id, email: user.email, full_name: user.full_name, slug: user.slug },
        connector: {
          read_only: isReadOnly(),
          default_site: process.env.NETLIFY_MCP_DEFAULT_SITE || process.env.SITE_ID || null,
          site_allowlist: siteAllowlist().length ? siteAllowlist() : null,
          raw_api_enabled: rawApiEnabled(),
        },
      };
    },
  },
  {
    name: 'netlify_list_accounts',
    title: 'List accounts',
    description: 'List the Netlify teams/accounts the token can see, with the slug that environment-variable tools need.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async handler() {
      const accounts = (await api('/accounts')) || [];
      return accounts.map((a) => ({
        id: a.id,
        slug: a.slug,
        name: a.name,
        type: a.type_name,
        roles_allowed: a.roles_allowed,
      }));
    },
  },
  {
    name: 'netlify_list_sites',
    title: 'List sites',
    description:
      'List Netlify sites, newest activity first. Optionally filter by a name fragment. Returns a trimmed summary per site (id, name, urls, repo, last published deploy).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Filter to sites whose name contains this string.' },
        ...PAGING_PROPS,
      },
      additionalProperties: false,
    },
    async handler(args) {
      const sites =
        (await api('/sites', {
          query: { name: args.name, filter: 'all', page: args.page, per_page: args.per_page || 20 },
        })) || [];
      const allow = siteAllowlist();
      const visible = allow.length
        ? sites.filter(
            (s) =>
              allow.includes(String(s.id).toLowerCase()) || allow.includes(String(s.name).toLowerCase())
          )
        : sites;
      return { count: visible.length, sites: visible.map(summarizeSite) };
    },
  },
  {
    name: 'netlify_get_site',
    title: 'Get site',
    description: 'Fetch one site: build settings, domains, account, and its currently published deploy.',
    inputSchema: {
      type: 'object',
      properties: {
        site: SITE_PROP,
        full: { type: 'boolean', description: 'Return the raw Netlify object instead of the trimmed summary.' },
      },
      additionalProperties: false,
    },
    async handler(args) {
      const site = await resolveSite(args.site);
      return args.full ? site : summarizeSite(site);
    },
  },
  {
    name: 'netlify_list_deploys',
    title: 'List deploys',
    description:
      'List a site\'s deploys, newest first, with state, branch, commit, error message and a link to the build log. Use this to find out whether the last deploy succeeded.',
    inputSchema: {
      type: 'object',
      properties: {
        site: SITE_PROP,
        state: {
          type: 'string',
          description: 'Filter by deploy state, e.g. "ready", "error", "building", "new".',
        },
        branch: { type: 'string', description: 'Filter to deploys from this branch.' },
        ...PAGING_PROPS,
      },
      additionalProperties: false,
    },
    async handler(args) {
      const site = await resolveSite(args.site);
      const deploys =
        (await api(`/sites/${site.id}/deploys`, {
          query: {
            state: args.state,
            branch: args.branch,
            page: args.page,
            per_page: args.per_page || 10,
          },
        })) || [];
      return {
        site: { id: site.id, name: site.name },
        count: deploys.length,
        deploys: deploys.map((d) => summarizeDeploy(d, site.name)),
      };
    },
  },
  {
    name: 'netlify_get_deploy',
    title: 'Get deploy',
    description:
      'Fetch one deploy by id, including its error message and summary when the build failed, plus a link to the full build log.',
    inputSchema: {
      type: 'object',
      properties: {
        deploy_id: { type: 'string', description: 'The deploy id.' },
        site: SITE_PROP,
        full: { type: 'boolean', description: 'Return the raw Netlify object instead of the trimmed summary.' },
      },
      required: ['deploy_id'],
      additionalProperties: false,
    },
    async handler(args) {
      const deploy = await api(`/deploys/${encodeURIComponent(args.deploy_id)}`);
      const site = await resolveSite(args.site || deploy.site_id);
      if (deploy.site_id && site.id !== deploy.site_id) {
        throw new Error('That deploy does not belong to the resolved site.');
      }
      if (args.full) return deploy;
      return {
        ...summarizeDeploy(deploy, site.name),
        summary: deploy.summary || undefined,
        review_url: deploy.review_url || undefined,
      };
    },
  },
  {
    name: 'netlify_list_site_functions',
    title: 'List functions',
    description: 'List the serverless functions deployed on a site.',
    inputSchema: { type: 'object', properties: { site: SITE_PROP }, additionalProperties: false },
    async handler(args) {
      const site = await resolveSite(args.site);
      return await api(`/sites/${site.id}/functions`);
    },
  },
  {
    name: 'netlify_list_build_hooks',
    title: 'List build hooks',
    description: 'List a site\'s build hooks (id, title, branch). Hook URLs are redacted.',
    inputSchema: { type: 'object', properties: { site: SITE_PROP }, additionalProperties: false },
    async handler(args) {
      const site = await resolveSite(args.site);
      const hooks = (await api(`/sites/${site.id}/build_hooks`)) || [];
      return hooks.map((h) => ({
        id: h.id,
        title: h.title,
        branch: h.branch,
        created_at: h.created_at,
        url: h.url ? `${String(h.url).slice(0, 40)}…[redacted]` : null,
      }));
    },
  },
  {
    name: 'netlify_list_forms',
    title: 'List forms',
    description: 'List a site\'s Netlify Forms, with submission counts.',
    inputSchema: { type: 'object', properties: { site: SITE_PROP }, additionalProperties: false },
    async handler(args) {
      const site = await resolveSite(args.site);
      const forms = (await api(`/sites/${site.id}/forms`)) || [];
      return forms.map((f) => ({
        id: f.id,
        name: f.name,
        paths: f.paths,
        submission_count: f.submission_count,
        fields: (f.fields || []).map((x) => x.name),
        created_at: f.created_at,
      }));
    },
  },
  {
    name: 'netlify_list_form_submissions',
    title: 'List form submissions',
    description: 'Read submissions for one form. These often contain personal data submitted by visitors.',
    inputSchema: {
      type: 'object',
      properties: {
        form_id: { type: 'string', description: 'The form id, from netlify_list_forms.' },
        ...PAGING_PROPS,
      },
      required: ['form_id'],
      additionalProperties: false,
    },
    async handler(args) {
      const subs =
        (await api(`/forms/${encodeURIComponent(args.form_id)}/submissions`, {
          query: { page: args.page, per_page: args.per_page || 20 },
        })) || [];
      return subs.map((s) => ({
        id: s.id,
        form_name: s.form_name,
        created_at: s.created_at,
        data: s.data,
      }));
    },
  },
  {
    name: 'netlify_list_env_vars',
    title: 'List environment variables',
    description:
      'List environment variables for a site (or the whole team when no site is given). Values are withheld unless include_values is true, and values of variables marked secret are never returned by Netlify.',
    inputSchema: {
      type: 'object',
      properties: {
        site: SITE_PROP,
        account_slug: { type: 'string', description: 'Team slug. Inferred from the site when omitted.' },
        team_wide: { type: 'boolean', description: 'List the team\'s shared variables instead of one site\'s.' },
        context: { type: 'string', enum: CONTEXTS, description: 'Filter to one deploy context.' },
        include_values: { type: 'boolean', description: 'Include plaintext values. Off by default.' },
      },
      additionalProperties: false,
    },
    async handler(args) {
      const site = args.team_wide ? null : await resolveSite(args.site);
      const slug = await resolveAccountSlug(args.account_slug, site);
      const vars =
        (await api(`/accounts/${encodeURIComponent(slug)}/env`, {
          query: { site_id: site ? site.id : undefined, context_name: args.context },
        })) || [];
      return {
        account_slug: slug,
        site: site ? { id: site.id, name: site.name } : null,
        values_included: !!args.include_values,
        variables: vars.map((v) => summarizeEnvVar(v, args.include_values)),
      };
    },
  },
  {
    name: 'netlify_get_env_var',
    title: 'Get environment variable',
    description: 'Fetch one environment variable by key. The value is withheld unless include_values is true.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Variable name, e.g. STRIPE_SECRET_KEY.' },
        site: SITE_PROP,
        account_slug: { type: 'string' },
        team_wide: { type: 'boolean', description: 'Look up the team\'s shared variable rather than a site one.' },
        include_values: { type: 'boolean' },
      },
      required: ['key'],
      additionalProperties: false,
    },
    async handler(args) {
      // Resolved strictly: swallowing a failure here would turn a site blocked
      // by the allowlist into a silent team-wide read.
      const site = args.team_wide ? null : await resolveSite(args.site);
      const slug = await resolveAccountSlug(args.account_slug, site);
      const variable = await api(
        `/accounts/${encodeURIComponent(slug)}/env/${encodeURIComponent(args.key)}`,
        { query: { site_id: site ? site.id : undefined } }
      );
      return summarizeEnvVar(variable, args.include_values);
    },
  },

  /* --------------------------------------------------------------- write */
  {
    name: 'netlify_trigger_build',
    title: 'Trigger a build',
    description: 'Start a new build and deploy for a site, optionally clearing the build cache first.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        site: SITE_PROP,
        clear_cache: { type: 'boolean', description: 'Discard the cached dependencies and build from scratch.' },
      },
      additionalProperties: false,
    },
    async handler(args) {
      const site = await resolveSite(args.site);
      const build = await api(`/sites/${site.id}/builds`, {
        method: 'POST',
        body: { clear_cache: !!args.clear_cache },
      });
      return {
        triggered: true,
        site: { id: site.id, name: site.name },
        build_id: build.id,
        deploy_id: build.deploy_id,
        log_url: `https://app.netlify.com/sites/${site.name}/deploys`,
      };
    },
  },
  {
    name: 'netlify_cancel_deploy',
    title: 'Cancel a deploy',
    description: 'Cancel an in-progress deploy.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: { deploy_id: { type: 'string' } },
      required: ['deploy_id'],
      additionalProperties: false,
    },
    async handler(args) {
      const deploy = await api(`/deploys/${encodeURIComponent(args.deploy_id)}/cancel`, { method: 'POST' });
      return { cancelled: true, deploy: summarizeDeploy(deploy) };
    },
  },
  {
    name: 'netlify_rollback_deploy',
    title: 'Roll back to a deploy',
    description:
      'Publish an earlier successful deploy again, rolling the live site back to it. Changes what visitors see immediately.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        deploy_id: { type: 'string', description: 'The earlier deploy to restore.' },
        site: SITE_PROP,
      },
      required: ['deploy_id'],
      additionalProperties: false,
    },
    async handler(args) {
      const site = await resolveSite(args.site);
      const deploy = await api(
        `/sites/${site.id}/deploys/${encodeURIComponent(args.deploy_id)}/restore`,
        { method: 'POST' }
      );
      return { restored: true, deploy: summarizeDeploy(deploy, site.name) };
    },
  },
  {
    name: 'netlify_lock_deploy',
    title: 'Lock the published deploy',
    description: 'Freeze the current published deploy so new pushes build but do not go live.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: { deploy_id: { type: 'string' } },
      required: ['deploy_id'],
      additionalProperties: false,
    },
    async handler(args) {
      const deploy = await api(`/deploys/${encodeURIComponent(args.deploy_id)}/lock`, { method: 'POST' });
      return { locked: true, deploy: summarizeDeploy(deploy) };
    },
  },
  {
    name: 'netlify_unlock_deploy',
    title: 'Unlock the published deploy',
    description: 'Release a deploy lock so the newest successful build publishes again.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: { deploy_id: { type: 'string' } },
      required: ['deploy_id'],
      additionalProperties: false,
    },
    async handler(args) {
      const deploy = await api(`/deploys/${encodeURIComponent(args.deploy_id)}/unlock`, { method: 'POST' });
      return { locked: false, deploy: summarizeDeploy(deploy) };
    },
  },
  {
    name: 'netlify_set_env_var',
    title: 'Set an environment variable',
    description:
      'Create or update one environment variable for a site (or the team). Takes effect on the next build — trigger one afterwards for it to reach the live site.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Variable name.' },
        value: { type: 'string', description: 'Variable value.' },
        site: SITE_PROP,
        account_slug: { type: 'string' },
        team_wide: { type: 'boolean', description: 'Set a team-wide variable rather than a site one.' },
        context: {
          type: 'string',
          enum: CONTEXTS,
          description: 'Deploy context this value applies to. Default "all".',
        },
        branch: { type: 'string', description: 'Branch name, required when context is "branch".' },
        scopes: {
          type: 'array',
          items: { type: 'string', enum: DEFAULT_SCOPES },
          description: 'Where the variable is readable. Defaults to all scopes.',
        },
        secret: { type: 'boolean', description: 'Mark as secret, so the value can never be read back.' },
      },
      required: ['key', 'value'],
      additionalProperties: false,
    },
    async handler(args) {
      const site = args.team_wide ? null : await resolveSite(args.site);
      const slug = await resolveAccountSlug(args.account_slug, site);
      const siteQuery = { site_id: site ? site.id : undefined };
      const context = args.context || 'all';
      if (context === 'branch' && !args.branch) {
        throw new Error('context "branch" also needs a `branch` name.');
      }

      let existing = null;
      try {
        existing = await api(
          `/accounts/${encodeURIComponent(slug)}/env/${encodeURIComponent(args.key)}`,
          { query: siteQuery }
        );
      } catch (err) {
        if (err.status !== 404) throw err;
      }

      if (existing) {
        await api(`/accounts/${encodeURIComponent(slug)}/env/${encodeURIComponent(args.key)}`, {
          method: 'PATCH',
          query: siteQuery,
          body: { context, context_parameter: args.branch, value: args.value },
        });
      } else {
        await api(`/accounts/${encodeURIComponent(slug)}/env`, {
          method: 'POST',
          query: siteQuery,
          body: [
            {
              key: args.key,
              scopes: args.scopes && args.scopes.length ? args.scopes : DEFAULT_SCOPES,
              is_secret: !!args.secret,
              values: [{ value: args.value, context, context_parameter: args.branch }],
            },
          ],
        });
      }

      return {
        key: args.key,
        created: !existing,
        updated: !!existing,
        context,
        scope: site ? { site: site.name } : { team: slug },
        note: 'Existing deploys keep the old value. Trigger a build for this to take effect.',
      };
    },
  },
  {
    name: 'netlify_delete_env_var',
    title: 'Delete an environment variable',
    description: 'Remove an environment variable entirely. Not recoverable — the value is gone.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        site: SITE_PROP,
        account_slug: { type: 'string' },
        team_wide: { type: 'boolean' },
      },
      required: ['key'],
      additionalProperties: false,
    },
    async handler(args) {
      const site = args.team_wide ? null : await resolveSite(args.site);
      const slug = await resolveAccountSlug(args.account_slug, site);
      await api(`/accounts/${encodeURIComponent(slug)}/env/${encodeURIComponent(args.key)}`, {
        method: 'DELETE',
        query: { site_id: site ? site.id : undefined },
      });
      return { key: args.key, deleted: true, scope: site ? { site: site.name } : { team: slug } };
    },
  },

  /* ---------------------------------------------------------- escape hatch */
  {
    name: 'netlify_api_request',
    title: 'Raw Netlify API request',
    description:
      'Call any Netlify API v1 endpoint directly, for anything the tools above do not cover (DNS, hooks, snippets, members, and so on). Paths are relative to https://api.netlify.com/api/v1. GET is always allowed; other methods need the connector to be in read-write mode.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Endpoint path, e.g. "/sites/{site_id}/service-instances".' },
        method: {
          type: 'string',
          enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
          description: 'HTTP method. Default GET.',
        },
        query: { type: 'object', description: 'Query string parameters.', additionalProperties: true },
        body: { type: 'object', description: 'JSON request body.', additionalProperties: true },
      },
      required: ['path'],
      additionalProperties: false,
    },
    async handler(args) {
      if (!rawApiEnabled()) {
        throw new Error(
          'The raw API tool is disabled because this connector is restricted to an explicit site allowlist.'
        );
      }
      const method = (args.method || 'GET').toUpperCase();
      if (method !== 'GET' && isReadOnly()) {
        throw new Error(`This connector is read-only, so ${method} requests are refused.`);
      }
      const result = await api(args.path, { method, query: args.query, body: args.body });
      return result === null ? { ok: true } : result;
    },
  },
];

function availableTools() {
  const readOnly = isReadOnly();
  const rawOk = rawApiEnabled();
  return TOOLS.filter((t) => (!t.write || !readOnly) && (t.name !== 'netlify_api_request' || rawOk));
}

function toolSchemas() {
  return availableTools().map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: {
      title: t.title,
      readOnlyHint: !t.write,
      destructiveHint: !!t.write,
      openWorldHint: true,
    },
  }));
}

async function callTool(name, args) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  if (tool.write && isReadOnly()) {
    throw new Error(`This connector is read-only, so ${name} is disabled.`);
  }
  if (tool.name === 'netlify_api_request' && !rawApiEnabled()) {
    throw new Error('The raw API tool is disabled on this connector.');
  }
  return await tool.handler(args || {});
}

module.exports = { TOOLS, availableTools, toolSchemas, callTool, isReadOnly, siteAllowlist };
