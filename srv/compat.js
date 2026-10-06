import cds from '@sap/cds';

const cache = new Map();

export async function token(credentials, options = {}) {
  if (cds.utils.token) return cds.utils.token(credentials, options);

  const endpoint = new URL(credentials.url);
  endpoint.pathname = options.path ?? '/oauth/token';
  const form = { grant_type: 'client_credentials', ...options.form };
  const key = `${endpoint}:${credentials.clientid}:${JSON.stringify(form)}`;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.token;

  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (credentials.clientsecret) {
    headers.Authorization =
      'Basic ' +
      Buffer.from(`${credentials.clientid}:${credentials.clientsecret}`).toString('base64');
  }
  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: new URLSearchParams({ client_id: credentials.clientid, ...form })
  });
  if (!response.ok)
    throw Object.assign(new Error(`OAuth token request failed with status ${response.status}`), {
      status: response.status
    });
  const result = await response.json();
  if (!result.access_token) throw new Error('OAuth token response is missing access_token');
  cache.set(key, {
    token: result.access_token,
    expires: Date.now() + Math.max(0, (result.expires_in ?? 3600) * 1000 - 60_000)
  });
  return result.access_token;
}
