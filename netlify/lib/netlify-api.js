/*
  Thin client for the Netlify API (https://api.netlify.com/api/v1).

  Only concerns here: auth header, query building, error shaping, and trimming
  the very large site/deploy objects down to the fields a model actually needs.
  Tool definitions live in mcp-tools.js.
*/

const API_BASE = 'https://api.netlify.com/api/v1';

class NetlifyApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'NetlifyApiError';
    this.status = status;
    this.body = body;
  }
}

function apiToken() {
  return (
    process.env.NETLIFY_API_TOKEN ||
    process.env.NETLIFY_AUTH_TOKEN ||
    process.env.NETLIFY_PAT ||
    ''
  );
}

async function api(path, { method = 'GET', query, body } = {}) {
  const token = apiToken();
  if (!token) {
    throw new NetlifyApiError(
      'Server is missing NETLIFY_API_TOKEN. Set a Netlify personal access token in this site\'s environment variables.',
      500,
      null
    );
  }

  const url = new URL(API_BASE + (path.startsWith('/') ? path : `/${path}`));
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'User-Agent': 'reinstated-netlify-mcp/1.0',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!res.ok) {
    const detail =
      (parsed && typeof parsed === 'object' && (parsed.message || parsed.error || parsed.errors)) ||
      (typeof parsed === 'string' ? parsed.slice(0, 500) : '') ||
      res.statusText;
    throw new NetlifyApiError(
      `Netlify API ${method} ${url.pathname} failed (${res.status}): ${
        typeof detail === 'string' ? detail : JSON.stringify(detail)
      }`,
      res.status,
      parsed
    );
  }

  return parsed;
}

/* --------------------------------------------------------------------------
   Trimming. A raw site object is ~4kB of mostly-empty build plumbing; a raw
   deploy list of 20 is bigger still. Every tool returns the summary unless
   the caller asks for `full`.
   -------------------------------------------------------------------------- */

function summarizeSite(site) {
  if (!site || typeof site !== 'object') return site;
  const build = site.build_settings || {};
  const published = site.published_deploy || null;
  return {
    id: site.id,
    name: site.name,
    url: site.ssl_url || site.url,
    admin_url: site.admin_url,
    custom_domain: site.custom_domain || null,
    domain_aliases: site.domain_aliases && site.domain_aliases.length ? site.domain_aliases : undefined,
    account_slug: site.account_slug,
    account_name: site.account_name,
    repo: build.repo_url || null,
    production_branch: build.repo_branch || null,
    build_command: build.cmd || null,
    publish_directory: build.dir || null,
    published_deploy: published
      ? {
          id: published.id,
          state: published.state,
          branch: published.branch,
          commit_ref: published.commit_ref,
          created_at: published.created_at,
          published_at: published.published_at,
        }
      : null,
    created_at: site.created_at,
    updated_at: site.updated_at,
  };
}

function summarizeDeploy(deploy, siteName) {
  if (!deploy || typeof deploy !== 'object') return deploy;
  const name = siteName || deploy.name;
  return {
    id: deploy.id,
    site_id: deploy.site_id,
    state: deploy.state,
    context: deploy.context,
    branch: deploy.branch,
    commit_ref: deploy.commit_ref,
    title: deploy.title,
    error_message: deploy.error_message || null,
    deploy_url: deploy.deploy_ssl_url || deploy.deploy_url,
    live_url: deploy.ssl_url || deploy.url,
    log_url: name ? `https://app.netlify.com/sites/${name}/deploys/${deploy.id}` : undefined,
    locked: deploy.locked || undefined,
    created_at: deploy.created_at,
    published_at: deploy.published_at,
    deploy_time: deploy.deploy_time,
  };
}

function summarizeEnvVar(variable, includeValues) {
  if (!variable || typeof variable !== 'object') return variable;
  const values = (variable.values || []).map((v) => ({
    context: v.context,
    branch: v.context_parameter || undefined,
    value: variable.is_secret || !includeValues ? undefined : v.value,
    value_set: v.value !== undefined && v.value !== null && v.value !== '',
  }));
  return {
    key: variable.key,
    scopes: variable.scopes,
    is_secret: !!variable.is_secret,
    values,
  };
}

module.exports = { api, apiToken, NetlifyApiError, summarizeSite, summarizeDeploy, summarizeEnvVar };
