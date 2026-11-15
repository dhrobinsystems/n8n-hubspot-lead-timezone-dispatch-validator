/**
 * Test suite (node --test). No network: HubSpot and dispatch calls go through a
 * recording fetch stub, and the n8n Code nodes run in-process against the Node.js mirror.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { isUnconfigured, isValidTimeZone, loadDispatchConfig, readBooleanEnv, validateDispatchConfig } from '../src/core/config.js';
import {
  canonicalTimeZone,
  evaluateOutboundWindow,
  localParts,
  normalizeCountryCode,
  resolvePhone,
  resolveTimezone,
  utcOffsetMinutes,
  validateLeadTiming,
  zonesForRegion,
} from '../src/core/timezone-validator.js';
import { createContactTimingClient, lookupIpTimezone, sendDispatchWebhook } from '../src/core/dispatch.js';
import { extractLead, intakeStage, processLead, recheckLead, summarizeLead } from '../src/core/pipeline.js';
import { createDispatchQueue, runQueueOnce, runSimulation, simulationNow } from '../src/index.js';
import { buildWorkflow, serializeWorkflow } from '../scripts/build-workflow.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEADS = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'sample-leads.json'), 'utf8'));
const MONDAY_14Z = Date.parse('2026-11-16T14:00:00Z');
const cfg = (env = {}) => loadDispatchConfig(env);

function recordingFetch(handler = () => ({ status: 200, body: {} })) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : undefined });
    const { status = 200, body = {} } = (await handler(calls[calls.length - 1])) || {};
    const text = JSON.stringify(body);
    return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => text };
  };
  return { fetchImpl, calls };
}

describe('configuration', () => {
  test('safe defaults', () => {
    const c = cfg();
    assert.equal(c.dryRun, true);
    assert.equal(c.sandboxMode, true);
    assert.equal(c.resolution.unknownAction, 'manual');
    assert.equal(c.resolution.ipProvider, 'none');
    assert.equal(c.windows.call.startMinute, 540);
    assert.equal(c.windows.call.endMinute, 1080);
    assert.deepEqual(c.windows.weekdays, [1, 2, 3, 4, 5]);
    assert.equal(readBooleanEnv('flase', true), true);
    assert.equal(isUnconfigured('YOUR_HUBSPOT_PRIVATE_APP_TOKEN_HERE'), true);
  });

  test('explicit secret validation and format errors', () => {
    const live = validateDispatchConfig(cfg({ DRY_RUN: 'false', WEBHOOK_SECRET: 'YOUR_WEBHOOK_SECRET_HERE', HUBSPOT_PRIVATE_APP_TOKEN: 'YOUR_HUBSPOT_PRIVATE_APP_TOKEN_HERE' }));
    assert.ok(live.errors.some((e) => e.includes('WEBHOOK_SECRET')));
    assert.ok(live.errors.some((e) => e.includes('HUBSPOT_PRIVATE_APP_TOKEN')));
    assert.ok(validateDispatchConfig(cfg({ WEBHOOK_SECRET: 'short' })).errors.some((e) => e.includes('16 characters')));
    assert.ok(validateDispatchConfig(cfg({ CALL_WINDOW_START: '9am' })).errors.some((e) => e.includes('HH:MM')));
    assert.ok(validateDispatchConfig(cfg({ CALL_WINDOW_START: '18:00', CALL_WINDOW_END: '09:00' })).errors.some((e) => e.includes('after its start')));
    assert.ok(validateDispatchConfig(cfg({ DEFAULT_TIMEZONE: 'Mars/Olympus' })).errors.length);
    assert.ok(validateDispatchConfig(cfg({ HOLIDAYS_JSON: '[1,2]' })).errors.some((e) => e.includes('HOLIDAYS_JSON')));
    assert.ok(validateDispatchConfig(cfg({ RESOLUTION_ORDER: 'explicit,horoscope' })).errors.length);
    assert.ok(validateDispatchConfig(cfg({ IP_TIMEZONE_PROVIDER: 'ipinfo' })).errors.some((e) => e.includes('IPINFO_TOKEN')));
    assert.equal(isValidTimeZone('Asia/Dhaka'), true);
  });
});

describe('timezone resolution', () => {
  test('canonicalizes IANA names and HubSpot enum values', () => {
    assert.equal(canonicalTimeZone('america/new_york'), 'America/New_York');
    assert.equal(canonicalTimeZone('america_slash_los_angeles'), 'America/Los_Angeles');
    assert.equal(canonicalTimeZone('Not/AZone'), null);
    assert.equal(canonicalTimeZone('EST5EDT_but_wrong'), null);
  });

  test('phone numbers: calling codes, 00 prefix, NANP special areas, national numbers', () => {
    assert.deepEqual(resolvePhone('+44 20 7946 0000').zones, ['Europe/London']);
    assert.deepEqual(resolvePhone('0049 30 1234567').zones, ['Europe/Berlin']);
    assert.deepEqual(resolvePhone('+1 808 555 0100').zones, ['Pacific/Honolulu']);
    assert.deepEqual(resolvePhone('+1 787 555 0123').zones, ['America/Puerto_Rico']);
    assert.equal(resolvePhone('+1 212 555 0100').precision, 'nanp_mainland');
    assert.equal(resolvePhone('+61 2 9876 5432').precision, 'country_multi_zone');
    assert.equal(resolvePhone('020 7946 0000'), null);
    assert.deepEqual(resolvePhone('(212) 555-0100', 'US').zones.length, 6);
    assert.equal(resolvePhone('+999 1234567'), null);
    assert.equal(resolvePhone('123'), null);
  });

  test('countries and regions, including split states', () => {
    assert.equal(normalizeCountryCode('United States'), 'US');
    assert.equal(normalizeCountryCode('uk'), 'GB');
    assert.equal(normalizeCountryCode('de'), 'DE');
    assert.equal(normalizeCountryCode('Atlantis'), null);
    assert.deepEqual(zonesForRegion('US', 'Texas'), ['America/Chicago', 'America/Denver']);
    assert.deepEqual(zonesForRegion('US', 'ny'), ['America/New_York']);
    assert.deepEqual(zonesForRegion('CA', 'British Columbia'), ['America/Vancouver', 'America/Edmonton']);
    assert.deepEqual(zonesForRegion('AU', 'Western Australia'), ['Australia/Perth']);
  });

  test('precedence, confidence and conservative conflict merging', () => {
    const c = cfg();
    assert.equal(resolveTimezone({ hs_timezone: 'america_slash_chicago', phone: '+44 20 7946 0000' }, c).timezone, 'America/Chicago');
    assert.equal(resolveTimezone({ hs_timezone: 'america_slash_chicago', phone: '+44 20 7946 0000' }, c).conflict, null);
    const region = resolveTimezone({ country: 'US', state: 'CA', phone: '+1 415 555 0100' }, c, { nowMs: MONDAY_14Z });
    assert.equal(region.source, 'region');
    assert.equal(region.confidence, 'high');
    assert.equal(region.conflict, null);
    const vpn = resolveTimezone({ phone: '+44 20 7946 0000' }, c, { ipTimezone: 'Asia/Tokyo', nowMs: MONDAY_14Z });
    assert.deepEqual(vpn.candidates, ['Europe/London', 'Asia/Tokyo']);
    assert.equal(vpn.confidence, 'low');
    const precedence = resolveTimezone({ phone: '+44 20 7946 0000' }, cfg({ CONFLICT_POLICY: 'precedence' }), { ipTimezone: 'Asia/Tokyo', nowMs: MONDAY_14Z });
    assert.deepEqual(precedence.candidates, ['Europe/London']);
    assert.equal(resolveTimezone({}, c).resolved, false);
    assert.equal(resolveTimezone({}, cfg({ UNKNOWN_TIMEZONE_ACTION: 'default', DEFAULT_TIMEZONE: 'Europe/Paris' })).timezone, 'Europe/Paris');
    assert.equal(resolveTimezone({ country: 'US', phone: '+44 20 7946 0000' }, cfg({ RESOLUTION_ORDER: 'phone,country' }), { nowMs: MONDAY_14Z }).conflict.with, 'country');
  });
});

describe('outbound window evaluation', () => {
  const windows = cfg().windows;

  test('local parts and offsets follow DST', () => {
    assert.equal(localParts(MONDAY_14Z, 'America/New_York').label, 'Mon 2026-11-16 09:00');
    assert.equal(utcOffsetMinutes(MONDAY_14Z, 'America/New_York'), -300);
    assert.equal(utcOffsetMinutes(Date.parse('2026-07-01T12:00:00Z'), 'America/New_York'), -240);
    assert.equal(utcOffsetMinutes(MONDAY_14Z, 'Asia/Kolkata'), 330);
  });

  test('open now, wait until the window, weekends, end buffer', () => {
    assert.equal(evaluateOutboundWindow({ candidates: ['Europe/London'], channel: 'call', nowMs: MONDAY_14Z, windows }).status, 'open');
    const la = evaluateOutboundWindow({ candidates: ['America/Los_Angeles'], channel: 'call', nowMs: MONDAY_14Z, windows: { ...windows, jitterMinutes: 0 } });
    assert.equal(la.status, 'wait');
    assert.equal(la.dispatchAt, '2026-11-16T17:00:00.000Z');
    const friday = Date.parse('2026-11-20T17:40:00Z');
    const weekend = evaluateOutboundWindow({ candidates: ['Europe/London'], channel: 'call', nowMs: friday, windows: { ...windows, jitterMinutes: 0 } });
    assert.equal(weekend.dispatchAt, '2026-11-23T09:00:00.000Z');
    const late = Date.parse('2026-11-16T17:45:00Z');
    assert.equal(evaluateOutboundWindow({ candidates: ['Europe/London'], channel: 'call', nowMs: late, windows }).status, 'wait');
  });

  test('channel windows: call, email, both (intersection)', () => {
    const custom = cfg({ CALL_WINDOW_START: '10:00', CALL_WINDOW_END: '16:00', EMAIL_WINDOW_START: '08:00', EMAIL_WINDOW_END: '20:00', DISPATCH_JITTER_MINUTES: '0' }).windows;
    const nine = Date.parse('2026-11-16T09:00:00Z');
    assert.equal(evaluateOutboundWindow({ candidates: ['Europe/London'], channel: 'email', nowMs: nine, windows: custom }).status, 'open');
    assert.equal(evaluateOutboundWindow({ candidates: ['Europe/London'], channel: 'call', nowMs: nine, windows: custom }).dispatchAt, '2026-11-16T10:00:00.000Z');
    assert.equal(evaluateOutboundWindow({ candidates: ['Europe/London'], channel: 'both', nowMs: nine, windows: custom }).dispatchAt, '2026-11-16T10:00:00.000Z');
  });

  test('holidays per country and global', () => {
    const h = cfg({ HOLIDAYS_JSON: '{"GB":["2026-11-16"],"*":["2026-11-17"]}', DISPATCH_JITTER_MINUTES: '0' }).windows;
    const r = evaluateOutboundWindow({ candidates: ['Europe/London'], channel: 'call', country: 'GB', nowMs: MONDAY_14Z, windows: h });
    assert.equal(r.dispatchAt, '2026-11-18T09:00:00.000Z');
  });

  test('multi-zone intersection, no shared window, max delay', () => {
    const us = evaluateOutboundWindow({ candidates: ['America/New_York', 'America/Los_Angeles'], channel: 'call', nowMs: MONDAY_14Z, windows: { ...windows, jitterMinutes: 0 } });
    assert.equal(us.dispatchAt, '2026-11-16T17:00:00.000Z');
    const none = evaluateOutboundWindow({ candidates: ['Europe/London', 'Asia/Tokyo'], channel: 'call', nowMs: MONDAY_14Z, windows });
    assert.equal(none.status, 'manual');
    const short = evaluateOutboundWindow({ candidates: ['Asia/Singapore'], channel: 'call', nowMs: Date.parse('2026-11-20T12:00:00Z'), windows: { ...windows, maxDelayHours: 24 } });
    assert.equal(short.status, 'manual');
  });

  test('deterministic jitter stays inside the window', () => {
    const a = evaluateOutboundWindow({ candidates: ['America/Los_Angeles'], channel: 'call', nowMs: MONDAY_14Z, windows, jitterKey: '123' });
    const b = evaluateOutboundWindow({ candidates: ['America/Los_Angeles'], channel: 'call', nowMs: MONDAY_14Z, windows, jitterKey: '123' });
    assert.equal(a.dispatchAt, b.dispatchAt);
    const minutes = (Date.parse(a.dispatchAt) - Date.parse('2026-11-16T17:00:00Z')) / 60000;
    assert.ok(minutes >= 0 && minutes <= 15);
  });

  test('validateLeadTiming end to end for one lead', () => {
    const r = validateLeadTiming({ id: '1', phone: '+65 6123 4567' }, cfg(), { nowMs: MONDAY_14Z });
    assert.equal(r.decision.status, 'wait');
    assert.match(r.decision.localTimesAtDispatch['Asia/Singapore'], /^Tue 2026-11-17 09:/);
  });
});

describe('HubSpot, IP lookup and dispatch hand-off', () => {
  test('dry run intercepts writes; sandbox mode blocks production portals', async () => {
    const dry = recordingFetch();
    assert.equal((await createContactTimingClient({ token: 't', fetchImpl: dry.fetchImpl }).updateContact('1', { a: 'b' })).mode, 'intercepted_dry_run');
    assert.equal(dry.calls.length, 0);
    const prod = recordingFetch((c) => (c.url.endsWith('/account-info/v3/details') ? { body: { portalId: 1, accountType: 'STANDARD' } } : {}));
    await assert.rejects(createContactTimingClient({ token: 't', dryRun: false, sandboxMode: true, fetchImpl: prod.fetchImpl }).updateContact('1', { a: 'b' }), (e) => e.code === 'sandbox_account_required');
    assert.ok(prod.calls.every((c) => c.method === 'GET'));
  });

  test('IP timezone from an edge header or ipinfo, never throwing', async () => {
    const resolution = cfg({ IP_TIMEZONE_PROVIDER: 'header' }).resolution;
    assert.equal(await lookupIpTimezone({ headers: { 'CF-Timezone': 'Europe/Paris' }, resolution }), 'Europe/Paris');
    const ipinfo = cfg({ IP_TIMEZONE_PROVIDER: 'ipinfo', IPINFO_TOKEN: 'test-token' }).resolution;
    const { fetchImpl, calls } = recordingFetch(() => ({ body: { timezone: 'Asia/Dhaka' } }));
    assert.equal(await lookupIpTimezone({ ip: '203.0.113.5', resolution: ipinfo, fetchImpl }), 'Asia/Dhaka');
    assert.match(calls[0].url, /^https:\/\/ipinfo\.io\/203\.0\.113\.5\/json\?token=test-token$/);
    assert.equal(await lookupIpTimezone({ ip: '203.0.113.5', resolution: ipinfo, fetchImpl: async () => { throw new Error('down'); } }), null);
  });

  test('signed dispatch webhook goes to the sandbox target in SANDBOX_MODE', async () => {
    const { fetchImpl, calls } = recordingFetch();
    const config = cfg({ DRY_RUN: 'false', DISPATCH_WEBHOOK_URL: 'https://dialer.example/prod', DISPATCH_SANDBOX_WEBHOOK_URL: 'https://dialer.example/sandbox', DISPATCH_WEBHOOK_SECRET: 'dispatch-secret' });
    assert.equal((await sendDispatchWebhook({ a: 1 }, { config, fetchImpl })).mode, 'sent');
    assert.equal(calls[0].url, 'https://dialer.example/sandbox');
    assert.match(calls[0].headers['x-signature'], /^sha256=[0-9a-f]{64}$/);
    assert.equal((await sendDispatchWebhook({ a: 1 }, { config: cfg(), fetchImpl })).mode, 'intercepted_dry_run');
    assert.equal((await sendDispatchWebhook({ a: 1 }, { config: cfg({ DRY_RUN: 'false', SANDBOX_MODE: 'false', DISPATCH_WEBHOOK_URL: 'http://plain.example' }), fetchImpl })).mode, 'refused_non_https');
  });
});

describe('pipeline', () => {
  test('lead extraction from flat and HubSpot workflow payloads', () => {
    assert.equal(extractLead({ objectId: 5, properties: { phone: { value: '+44 1' } } }).contactId, '5');
    assert.equal(extractLead({ objectId: 5, properties: { phone: { value: '+44 1' } } }).lead.phone, '+44 1');
    assert.equal(extractLead({ contactId: 'abc' }).contactId, null);
    assert.equal(extractLead({ channel: 'SMS' }).channel, null);
  });

  test('intake: secret, missing data, config errors', () => {
    const secured = cfg({ WEBHOOK_SECRET: 'a-long-test-secret-value' });
    assert.equal(intakeStage({ body: { phone: '+44 20' }, headers: {} }, { config: secured }).httpStatus, 401);
    assert.equal(intakeStage({ body: { phone: '+44 20' }, headers: { 'X-Webhook-Secret': 'a-long-test-secret-value' } }, { config: secured }).status, 'accepted');
    assert.equal(intakeStage({ body: {}, headers: {} }, { config: cfg() }).reason, 'no_lead_data');
    assert.equal(intakeStage({ body: { phone: '1' } }, { config: cfg({ DRY_RUN: 'false' }) }).reason, 'config_invalid');
  });

  test('fixtures: every lead reaches its expected status', async () => {
    const results = await runSimulation({ env: {} });
    for (const r of results) assert.equal(r.status, r.expected, r.name);
    assert.ok(!JSON.stringify(results).includes('@example.com'));
  });

  test('HubSpot enrichment overrides payload fields, live sandbox write-back', async () => {
    const { fetchImpl, calls } = recordingFetch((c) => {
      if (c.url.includes('/crm/v3/objects/contacts/42?')) return { body: { id: '42', properties: { phone: '+81 3 1234 5678', country: 'Japan' } } };
      if (c.url.endsWith('/account-info/v3/details')) return { body: { portalId: 9, accountType: 'DEVELOPER_TEST' } };
      return { body: {} };
    });
    const config = cfg({ DRY_RUN: 'false', HUBSPOT_PRIVATE_APP_TOKEN: 'test-token', WEBHOOK_SECRET: 'a-long-test-secret-value' });
    const ctx = await processLead({ body: { contactId: '42', phone: '+44 20 7946 0000' }, headers: { 'x-webhook-secret': 'a-long-test-secret-value' } }, { config, fetchImpl, now: () => MONDAY_14Z });
    assert.equal(ctx.resolution.timezone, 'Asia/Tokyo');
    assert.equal(ctx.status, 'scheduled');
    const patch = calls.find((c) => c.method === 'PATCH');
    assert.equal(patch.body.properties.outbound_dispatch_status, 'scheduled');
    assert.equal(patch.body.properties.lead_local_timezone, 'Asia/Tokyo');
  });

  test('recheck after the wait dispatches; repeated waits end in manual review', async () => {
    const config = cfg({ MAX_WAIT_CYCLES: '1' });
    const first = await processLead({ body: { contactId: '7', phone: '+65 6123 4567' } }, { config, fetchImpl: recordingFetch().fetchImpl, now: () => MONDAY_14Z });
    assert.equal(first.status, 'scheduled');
    const dispatched = await recheckLead(first, { config, fetchImpl: recordingFetch().fetchImpl, now: () => Date.parse(first.resumeAt) });
    assert.equal(dispatched.status, 'dispatched');
    assert.equal(dispatched.dispatchWebhook, 'intercepted_dry_run');
    const tooEarly = await recheckLead(first, { config, fetchImpl: recordingFetch().fetchImpl, now: () => MONDAY_14Z });
    assert.equal(tooEarly.status, 'manual_review');
    assert.equal(summarizeLead(tooEarly).reason, 'max_wait_cycles_reached');
  });

  test('persistent queue processes due entries', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tzq-'));
    try {
      const queue = createDispatchQueue(path.join(dir, 'q.json'));
      const config = cfg();
      const ctx = await processLead({ body: { contactId: '8', phone: '+65 6123 4567' } }, { config, fetchImpl: recordingFetch().fetchImpl, now: () => MONDAY_14Z });
      queue.add(ctx);
      assert.deepEqual(await runQueueOnce({ config, queue, now: () => MONDAY_14Z, logger: () => {} }), []);
      const done = await runQueueOnce({ config, queue, now: () => Date.parse(ctx.resumeAt), logger: () => {} });
      assert.equal(done[0].status, 'dispatched');
      assert.equal(queue.size(), 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('n8n workflow', () => {
  const committed = fs.readFileSync(path.join(ROOT, 'workflow.json'), 'utf8');
  const workflow = JSON.parse(committed);
  const nodes = Object.fromEntries(workflow.nodes.map((n) => [n.name, n]));

  test('structure: Wait node at specified time, routing, error handling, no credentials', () => {
    assert.equal(new Set(workflow.nodes.map((n) => n.name)).size, workflow.nodes.length);
    for (const [from, out] of Object.entries(workflow.connections)) {
      assert.ok(nodes[from], from);
      for (const branch of out.main) for (const l of branch) assert.ok(nodes[l.node], l.node);
    }
    const wait = nodes['Wait Until Local Window Opens'];
    assert.equal(wait.type, 'n8n-nodes-base.wait');
    assert.deepEqual(wait.parameters, { resume: 'specificTime', dateTime: '={{ $json.resumeAt }}' });
    assert.deepEqual(nodes['Route by Window Status'].parameters.rules.values.map((r) => r.outputKey), ['Open Now', 'Wait for Window', 'Manual Review']);
    assert.equal(workflow.connections['Route After Re-check'].main[1][0].node, 'Record Scheduled Dispatch');
    for (const name of ['Enrich from HubSpot & IP', 'Record Scheduled Dispatch', 'Dispatch Lead', 'Flag for Manual Review']) {
      assert.equal(nodes[name].onError, 'continueErrorOutput', name);
      assert.equal(nodes[name].retryOnFail, true, name);
    }
    assert.equal(workflow.connections['Log Failure'].main[0][0].node, 'Mark Execution Failed');
    assert.ok(workflow.nodes.every((n) => !n.credentials));
    assert.ok(!/pat-(?:na|eu)\d-[0-9a-f-]{20,}|xox[abpr]-|sk-[A-Za-z0-9]{20,}/.test(committed));
    assert.equal(workflow.active, false);
  });

  test('committed workflow equals a fresh build', () => {
    assert.equal(serializeWorkflow(buildWorkflow()), committed);
  });

  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const requireFn = createRequire(import.meta.url);
  async function runNode(name, items, env = {}) {
    const fn = new AsyncFunction('$input', '$env', '$getWorkflowStaticData', 'require', nodes[name].parameters.jsCode);
    const helpers = { httpRequest: async () => ({ statusCode: 200, headers: {}, body: '{}' }) };
    return fn.call({ helpers }, { first: () => items[0], all: () => items }, env, () => ({}), requireFn);
  }

  for (const lead of LEADS) {
    test(`n8n Code nodes match the Node.js mirror: ${lead.name}`, async () => {
      const env = { ...(lead.env || {}) };
      let items = await runNode('Validate Intake', [{ json: { body: lead.body, headers: lead.headers || {} } }], env);
      items = await runNode('Enrich from HubSpot & IP', items, env);
      items = await runNode('Resolve Timezone & Evaluate Window', items, env);
      const n8nStatus = items[0].json.status;
      const mirror = await processLead({ body: lead.body, headers: lead.headers || {} }, { config: loadDispatchConfig(env), fetchImpl: recordingFetch().fetchImpl });
      const expectedEvaluate = { dispatched: 'open', scheduled: 'wait', manual_review: 'manual' }[mirror.status];
      assert.equal(n8nStatus, expectedEvaluate);
      assert.deepEqual(items[0].json.resolution.candidates, mirror.resolution.candidates);
      const next = { open: 'Dispatch Lead', wait: 'Record Scheduled Dispatch', manual: 'Flag for Manual Review' }[n8nStatus];
      const out = await runNode(next, items, env);
      if (n8nStatus === 'wait') {
        assert.equal(out[0].json.resumeAt, mirror.resumeAt);
        const rechecked = await runNode('Re-check Window After Wait', out, env);
        assert.ok(['open', 'wait', 'manual'].includes(rechecked[0].json.status));
      } else {
        assert.equal(out[0].json.status, mirror.status);
      }
    });
  }
});
