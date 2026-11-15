/**
 * HubSpot contact enrichment and write-back, optional IP timezone lookup, and the
 * dispatch hand-off (a signed HTTPS webhook to your sequencer, dialer or HubSpot workflow).
 *
 *   DRY_RUN=true      -> HubSpot PATCHes and dispatch webhooks are returned, never sent
 *   SANDBOX_MODE=true -> HubSpot writes require a SANDBOX / DEVELOPER_TEST portal (or
 *                        HUBSPOT_SANDBOX_PORTAL_ID); dispatch goes to DISPATCH_SANDBOX_WEBHOOK_URL only
 *   placeholder token -> offline: no HubSpot reads or writes
 */
import crypto from 'node:crypto';
import { isUnconfigured } from './config.js';

export const CONTACT_TIMING_PROPERTIES = ['email', 'phone', 'mobilephone', 'country', 'state', 'hs_timezone', 'hs_ip_timezone', 'ip_country'];

export class DispatchGuardError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'DispatchGuardError';
    this.code = code;
  }
}

export function createContactTimingClient({
  token,
  dryRun = true,
  sandboxMode = true,
  sandboxPortalId = '',
  baseUrl = 'https://api.hubapi.com',
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const offline = isUnconfigured(token);
  const api = String(baseUrl).replace(/\/+$/, '');
  let sandboxVerdict = null;

  async function call(method, path, body, { allow404 = false } = {}) {
    if (offline) throw new DispatchGuardError('hubspot_offline', 'HubSpot token is a placeholder; live API calls are disabled');
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetchImpl(`${api}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (response.status === 404 && allow404) return null;
      if ((response.status === 429 || response.status >= 500) && attempt < 3) {
        await sleep(Math.min(1000 * 2 ** attempt, 8000));
        continue;
      }
      const text = await response.text();
      if (!response.ok) throw new DispatchGuardError(`http_${response.status}`, `HubSpot ${method} ${path.split('?')[0]} failed with HTTP ${response.status}`);
      return text ? JSON.parse(text) : {};
    }
  }

  async function verifySandbox() {
    if (!sandboxVerdict) {
      sandboxVerdict = (async () => {
        const d = await call('GET', '/account-info/v3/details');
        const portalId = String(d && d.portalId !== undefined ? d.portalId : '');
        const accountType = String((d && d.accountType) || '').toUpperCase();
        if (!isUnconfigured(sandboxPortalId)) {
          if (portalId !== String(sandboxPortalId)) throw new DispatchGuardError('sandbox_portal_mismatch', 'SANDBOX_MODE=true but the token is not for HUBSPOT_SANDBOX_PORTAL_ID');
        } else if (!['SANDBOX', 'DEVELOPER_TEST'].includes(accountType)) {
          throw new DispatchGuardError('sandbox_account_required', `SANDBOX_MODE=true but the account type is "${accountType || 'unknown'}"`);
        }
        return true;
      })();
    }
    return sandboxVerdict;
  }

  async function getContact(contactId) {
    if (offline) return null;
    const r = await call('GET', `/crm/v3/objects/contacts/${encodeURIComponent(contactId)}?properties=${CONTACT_TIMING_PROPERTIES.join(',')}`, undefined, { allow404: true });
    return r ? { id: String(r.id), ...(r.properties || {}) } : null;
  }

  async function updateContact(contactId, properties) {
    if (!contactId) return { mode: 'skipped', reason: 'no_contact_id' };
    if (dryRun) return { mode: 'intercepted_dry_run', properties };
    if (offline) throw new DispatchGuardError('hubspot_offline', 'HubSpot token is a placeholder; live API calls are disabled');
    if (sandboxMode) await verifySandbox();
    await call('PATCH', `/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`, { properties });
    return { mode: 'written', environment: sandboxMode ? 'sandbox' : 'production' };
  }

  return { offline, getContact, updateContact, verifySandbox };
}

/** Optional IP -> timezone. Never throws; returns null when unavailable. */
export async function lookupIpTimezone({ ip, headers = {}, resolution, fetchImpl }) {
  if (resolution.ipProvider === 'header') {
    const entry = Object.entries(headers || {}).find(([k]) => k.toLowerCase() === resolution.ipTimezoneHeader);
    return entry ? String(Array.isArray(entry[1]) ? entry[1][0] : entry[1]).slice(0, 64) : null;
  }
  if (resolution.ipProvider === 'ipinfo' && ip && /^[0-9a-f.:]{3,45}$/i.test(String(ip))) {
    try {
      const response = await fetchImpl(`https://ipinfo.io/${encodeURIComponent(ip)}/json?token=${encodeURIComponent(resolution.ipinfoToken)}`, { method: 'GET', headers: { accept: 'application/json' } });
      if (!response.ok) return null;
      const body = JSON.parse(await response.text());
      return body && body.timezone ? String(body.timezone).slice(0, 64) : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function buildTimingProperties({ resolution, status, dispatchAt, reason }) {
  return {
    lead_local_timezone: resolution && resolution.timezone ? resolution.timezone : '',
    lead_timezone_candidates: resolution && resolution.candidates ? resolution.candidates.join(';').slice(0, 500) : '',
    lead_timezone_source: resolution && resolution.source ? resolution.source : 'unresolved',
    lead_timezone_confidence: resolution ? resolution.confidence : 'none',
    outbound_dispatch_status: status,
    outbound_dispatch_at: dispatchAt || '',
    outbound_dispatch_note: String(reason || '').slice(0, 250),
  };
}

/** Signed hand-off to the system that actually calls or emails. */
export async function sendDispatchWebhook(payload, { config, fetchImpl }) {
  const target = config.sandboxMode ? config.dispatch.sandboxWebhookUrl : config.dispatch.webhookUrl;
  if (config.dryRun) return { mode: 'intercepted_dry_run', target: config.sandboxMode ? 'sandbox' : 'production' };
  if (isUnconfigured(target)) return { mode: 'not_configured' };
  if (!/^https:\/\//.test(target)) return { mode: 'refused_non_https' };
  const body = JSON.stringify(payload);
  const headers = { 'content-type': 'application/json' };
  if (!isUnconfigured(config.dispatch.webhookSecret)) {
    const ts = String(Math.floor(Date.now() / 1000));
    headers['x-signature-timestamp'] = ts;
    headers['x-signature'] = `sha256=${crypto.createHmac('sha256', config.dispatch.webhookSecret).update(`${ts}.${body}`).digest('hex')}`;
  }
  const response = await fetchImpl(target, { method: 'POST', headers, body });
  if (!response.ok) throw new DispatchGuardError(`dispatch_http_${response.status}`, `Dispatch webhook returned HTTP ${response.status}`);
  return { mode: 'sent', environment: config.sandboxMode ? 'sandbox' : 'production' };
}
