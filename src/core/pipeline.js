/**
 * Stages shared by the Node.js mirror and the n8n workflow.
 *
 *   intake -> enrich -> evaluate -> open    -> dispatch
 *                                -> wait    -> schedule -> (n8n Wait node) -> recheck -> open | wait | manual
 *                                -> manual  -> manual review
 *
 * Every stage takes and returns JSON-serializable data. HubSpot and dispatch calls
 * throw on failure so n8n can route the node's error output.
 */
import crypto from 'node:crypto';
import { isUnconfigured, validateDispatchConfig } from './config.js';
import { validateLeadTiming } from './timezone-validator.js';
import { buildTimingProperties, createContactTimingClient, lookupIpTimezone, sendDispatchWebhook } from './dispatch.js';

export function createDispatchClients(config, { fetchImpl, sleep } = {}) {
  return {
    crm: createContactTimingClient({
      token: config.hubspot.token,
      dryRun: config.dryRun,
      sandboxMode: config.sandboxMode,
      sandboxPortalId: config.hubspot.sandboxPortalId,
      baseUrl: config.hubspot.baseUrl,
      fetchImpl,
      ...(sleep ? { sleep } : {}),
    }),
  };
}

function headerValue(headers, name) {
  for (const [k, v] of Object.entries(headers || {})) if (k.toLowerCase() === name) return Array.isArray(v) ? v[0] : v;
  return null;
}

function secretMatches(given, expected) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

const LEAD_FIELDS = ['email', 'phone', 'mobilephone', 'country', 'state', 'timezone', 'hs_timezone', 'hs_ip_timezone', 'ip_country'];

/** Accepts a flat lead, a HubSpot workflow webhook ({ objectId, properties: { x: { value } } }) or { contactId, ... }. */
export function extractLead(body) {
  const src = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const props = src.properties && typeof src.properties === 'object' ? src.properties : {};
  const value = (k) => {
    const v = src[k] !== undefined ? src[k] : props[k];
    return v && typeof v === 'object' && 'value' in v ? v.value : v;
  };
  const idRaw = src.contactId ?? src.objectId ?? src.vid ?? value('hs_object_id');
  const lead = {};
  for (const f of LEAD_FIELDS) {
    const v = value(f);
    if (v !== undefined && v !== null && String(v).trim() !== '') lead[f] = String(v).trim().slice(0, 200);
  }
  return {
    contactId: idRaw !== undefined && /^\d{1,20}$/.test(String(idRaw)) ? String(idRaw) : null,
    lead,
    ip: typeof src.ip === 'string' ? src.ip.trim().slice(0, 45) : null,
    channel: ['call', 'email', 'both'].includes(String(src.channel || '').toLowerCase()) ? String(src.channel).toLowerCase() : null,
  };
}

export function intakeStage({ body, headers = {} }, { config, now = Date.now() }) {
  const base = { receivedAt: new Date(now).toISOString(), dryRun: config.dryRun, sandboxMode: config.sandboxMode, waitCycle: 0 };
  const { errors, warnings } = validateDispatchConfig(config);
  if (errors.length) return { ...base, status: 'rejected', httpStatus: 500, reason: 'config_invalid', errors };
  if (Buffer.byteLength(JSON.stringify(body ?? {}), 'utf8') > config.webhook.maxBodyBytes) return { ...base, status: 'rejected', httpStatus: 413, reason: 'payload_too_large' };
  if (!isUnconfigured(config.webhook.secret) && !secretMatches(headerValue(headers, config.webhook.secretHeader), config.webhook.secret)) {
    return { ...base, status: 'rejected', httpStatus: 401, reason: 'invalid_webhook_secret' };
  }
  const { contactId, lead, ip, channel } = extractLead(body);
  if (!contactId && !Object.keys(lead).length) return { ...base, status: 'rejected', httpStatus: 422, reason: 'no_lead_data' };
  return { ...base, status: 'accepted', httpStatus: 202, reason: null, contactId, lead, ip, channel, edgeTimezone: headerValue(headers, config.resolution.ipTimezoneHeader), warnings };
}

export async function enrichStage(ctx, { config, crm, fetchImpl }) {
  if (ctx.status !== 'accepted') return ctx;
  let lead = { ...ctx.lead };
  let crmFound = null;
  if (ctx.contactId && !crm.offline) {
    const contact = await crm.getContact(ctx.contactId);
    crmFound = Boolean(contact);
    if (contact) {
      for (const f of LEAD_FIELDS) if (contact[f] && f !== 'timezone') lead[f] = String(contact[f]);
      if (ctx.lead.timezone) lead.timezone = ctx.lead.timezone;
    }
  }
  const headers = ctx.edgeTimezone ? { [config.resolution.ipTimezoneHeader]: ctx.edgeTimezone } : {};
  const ipTimezone = await lookupIpTimezone({ ip: ctx.ip, headers, resolution: config.resolution, fetchImpl });
  const { email, ...withoutEmail } = lead;
  const { ip, edgeTimezone, ...rest } = ctx;
  return {
    ...rest,
    status: 'enriched',
    crmFound,
    ipTimezone,
    lead: { id: ctx.contactId || '', ...withoutEmail, ...(config.dispatch.includeEmail && email ? { email } : {}) },
    jitterKey: ctx.contactId || email || '',
  };
}

export function evaluateStage(ctx, { config, now = Date.now() }) {
  if (ctx.status !== 'enriched' && ctx.status !== 'scheduled') return ctx;
  const { resolution, channel, decision } = validateLeadTiming({ ...ctx.lead, id: ctx.jitterKey }, config, { nowMs: now, ipTimezone: ctx.ipTimezone, channel: ctx.channel });
  const slim = {
    timezone: resolution.timezone,
    candidates: resolution.candidates,
    source: resolution.source,
    confidence: resolution.confidence,
    country: resolution.country,
    conflict: resolution.conflict,
    signals: Object.fromEntries(Object.entries(resolution.signals).map(([k, s]) => [k, { zones: s.zones, detail: s.detail }])),
  };
  let status = decision.status;
  let reason = decision.reason;
  if (status === 'wait' && ctx.waitCycle >= config.windows.maxWaitCycles) {
    status = 'manual';
    reason = 'max_wait_cycles_reached';
  }
  return { ...ctx, status, reason, channel, resolution: slim, decision, evaluatedAt: new Date(now).toISOString() };
}

export async function scheduleStage(ctx, { config, crm }) {
  if (ctx.status !== 'wait') return ctx;
  const crmResult = config.hubspot.writeProperties
    ? await crm.updateContact(ctx.contactId, buildTimingProperties({ resolution: ctx.resolution, status: 'scheduled', dispatchAt: ctx.decision.dispatchAt, reason: `waiting for ${ctx.channel} window` }))
    : { mode: 'disabled' };
  return { ...ctx, status: 'scheduled', resumeAt: ctx.decision.dispatchAt, waitCycle: ctx.waitCycle + 1, crm: { schedule: crmResult.mode } };
}

export async function dispatchStage(ctx, { config, crm, fetchImpl, now = Date.now() }) {
  if (ctx.status !== 'open') return ctx;
  const dispatchedAt = new Date(now).toISOString();
  const crmResult = config.hubspot.writeProperties
    ? await crm.updateContact(ctx.contactId, buildTimingProperties({ resolution: ctx.resolution, status: 'dispatched', dispatchAt: dispatchedAt, reason: `${ctx.channel} window open` }))
    : { mode: 'disabled' };
  const payload = {
    type: 'lead_dispatch_ready',
    contactId: ctx.contactId,
    ...(ctx.lead.email ? { email: ctx.lead.email } : {}),
    channel: ctx.channel,
    timezone: ctx.resolution.timezone,
    candidates: ctx.resolution.candidates,
    confidence: ctx.resolution.confidence,
    localTimes: ctx.decision.localTimes,
    dispatchedAt,
    dryRun: config.dryRun,
    sandboxMode: config.sandboxMode,
  };
  const webhook = await sendDispatchWebhook(payload, { config, fetchImpl });
  return { ...ctx, status: 'dispatched', dispatchedAt, crm: { ...(ctx.crm || {}), dispatch: crmResult.mode }, dispatchWebhook: webhook.mode };
}

export async function manualReviewStage(ctx, { config, crm }) {
  if (ctx.status !== 'manual') return ctx;
  const crmResult = config.hubspot.writeProperties
    ? await crm.updateContact(ctx.contactId, buildTimingProperties({ resolution: ctx.resolution, status: 'manual_review', dispatchAt: '', reason: ctx.reason }))
    : { mode: 'disabled' };
  return { ...ctx, status: 'manual_review', crm: { ...(ctx.crm || {}), manual: crmResult.mode } };
}

export function summarizeLead(ctx) {
  return {
    status: ctx.status,
    reason: ctx.reason || null,
    contactId: ctx.contactId || null,
    channel: ctx.channel || null,
    timezone: ctx.resolution ? ctx.resolution.timezone : null,
    candidates: ctx.resolution ? ctx.resolution.candidates : [],
    source: ctx.resolution ? ctx.resolution.source : null,
    confidence: ctx.resolution ? ctx.resolution.confidence : null,
    conflict: ctx.resolution ? ctx.resolution.conflict : null,
    localTimes: ctx.decision ? ctx.decision.localTimes : {},
    resumeAt: ctx.resumeAt || null,
    dispatchedAt: ctx.dispatchedAt || null,
    waitCycle: ctx.waitCycle || 0,
    crm: ctx.crm || null,
    dispatchWebhook: ctx.dispatchWebhook || null,
    dryRun: ctx.dryRun,
    sandboxMode: ctx.sandboxMode,
    errors: ctx.errors || [],
  };
}

/** One pass for the Node.js mirror. A "scheduled" result must be re-run with recheckLead at resumeAt. */
export async function processLead(input, { config, fetchImpl = globalThis.fetch, clients, now = () => Date.now() }) {
  const { crm } = clients || createDispatchClients(config, { fetchImpl });
  let ctx = intakeStage(input, { config, now: now() });
  if (ctx.status !== 'accepted') return ctx;
  ctx = await enrichStage(ctx, { config, crm, fetchImpl });
  ctx = evaluateStage(ctx, { config, now: now() });
  return routeEvaluated(ctx, { config, crm, fetchImpl, now });
}

export async function recheckLead(ctx, { config, fetchImpl = globalThis.fetch, clients, now = () => Date.now() }) {
  const { crm } = clients || createDispatchClients(config, { fetchImpl });
  const evaluated = evaluateStage(ctx, { config, now: now() });
  return routeEvaluated(evaluated, { config, crm, fetchImpl, now });
}

async function routeEvaluated(ctx, { config, crm, fetchImpl, now }) {
  if (ctx.status === 'open') return dispatchStage(ctx, { config, crm, fetchImpl, now: now() });
  if (ctx.status === 'wait') return scheduleStage(ctx, { config, crm });
  if (ctx.status === 'manual') return manualReviewStage(ctx, { config, crm });
  return ctx;
}
