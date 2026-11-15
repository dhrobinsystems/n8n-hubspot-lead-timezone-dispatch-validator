#!/usr/bin/env node
/**
 * Generates workflow.json from src/core/.
 *
 * Code nodes embed the same core modules src/index.js imports (imports and
 * `export` keywords stripped) plus a few lines that run one stage. The delay itself
 * is a native n8n Wait node set to "At Specified Time". The tests rebuild the
 * workflow, fail on drift, and execute the Code nodes against the Node.js mirror.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OUTPUT_PATH = path.join(ROOT, 'workflow.json');
export const CORE_MODULES = ['src/core/config.js', 'src/core/timezone-data.js', 'src/core/timezone-validator.js', 'src/core/dispatch.js', 'src/core/pipeline.js'];
const PRELUDE_NAMES = ['crypto', 'env', 'config', 'n8nHelpers', 'n8nFetch', 'n8nSleep', 'clients', 'ctx', 'item', 'items', 'failure'];
const TOP_LEVEL_DECL = /^(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;

function stripModuleSyntax(source, file) {
  const out = source
    .replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];\s*$/gm, '')
    .replace(/^export\s+(?=(?:async\s+)?(?:function|const|let|class)\s)/gm, '');
  if (/^(?:import|export)\s/m.test(out)) throw new Error(`${file}: unsupported import/export syntax`);
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

export function buildLibrarySource(root = ROOT) {
  const seen = new Map(PRELUDE_NAMES.map((n) => [n, 'n8n prelude']));
  return CORE_MODULES.map((rel) => {
    const body = stripModuleSyntax(fs.readFileSync(path.join(root, rel), 'utf8'), rel);
    for (const m of body.matchAll(TOP_LEVEL_DECL)) {
      if (seen.has(m[1])) throw new Error(`Top-level name "${m[1]}" in ${rel} collides with ${seen.get(m[1])}`);
      seen.set(m[1], rel);
    }
    return `// ---- ${rel} ----\n${body}`;
  }).join('\n\n');
}

const PRELUDE = `
const env = $env;
const config = loadDispatchConfig(env);
const n8nHelpers = this.helpers;
const n8nSleep = (ms) => new Promise((resolve) => (typeof setTimeout === 'function' ? setTimeout(resolve, ms) : resolve()));
const n8nFetch = async (url, init = {}) => {
  const response = await n8nHelpers.httpRequest({
    url,
    method: init.method || 'GET',
    headers: init.headers || {},
    body: init.body,
    json: false,
    returnFullResponse: true,
    ignoreHttpStatusErrors: true,
    timeout: 15000,
  });
  const raw = response.body;
  const text = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : raw == null ? '' : JSON.stringify(raw);
  return {
    ok: response.statusCode >= 200 && response.statusCode < 300,
    status: response.statusCode,
    headers: { get: (name) => (response.headers || {})[String(name).toLowerCase()] ?? null },
    text: async () => text,
    json: async () => JSON.parse(text),
  };
};
const clients = createDispatchClients(config, { fetchImpl: n8nFetch, sleep: n8nSleep });
`;

const STAGES = {
  'Validate Intake': `const item = $input.first();
const ctx = intakeStage({ body: item.json.body || {}, headers: item.json.headers || {} }, { config, now: Date.now() });
return [{ json: ctx }];`,
  'Enrich from HubSpot & IP': 'const ctx = await enrichStage($input.first().json, { config, crm: clients.crm, fetchImpl: n8nFetch });\nreturn [{ json: ctx }];',
  'Resolve Timezone & Evaluate Window': 'const ctx = evaluateStage($input.first().json, { config, now: Date.now() });\nreturn [{ json: ctx }];',
  'Record Scheduled Dispatch': 'const ctx = await scheduleStage($input.first().json, { config, crm: clients.crm });\nreturn [{ json: ctx }];',
  'Re-check Window After Wait': 'const ctx = evaluateStage($input.first().json, { config, now: Date.now() });\nreturn [{ json: ctx }];',
  'Dispatch Lead': 'const ctx = await dispatchStage($input.first().json, { config, crm: clients.crm, fetchImpl: n8nFetch, now: Date.now() });\nreturn [{ json: summarizeLead(ctx) }];',
  'Flag for Manual Review': 'const ctx = await manualReviewStage($input.first().json, { config, crm: clients.crm });\nreturn [{ json: summarizeLead(ctx) }];',
  'Log Failure': `const items = $input.all();
const failure = { status: 'failed', failures: items.length, errors: items.map((i) => String((i.json && (i.json.error && (i.json.error.message || i.json.error))) || 'unknown').slice(0, 300)), dryRun: config.dryRun, sandboxMode: config.sandboxMode, at: new Date().toISOString() };
return [{ json: failure }];`,
};

const id = (n) => `f1a2b3c4-0000-4b00-8d00-${String(n).padStart(12, '0')}`;
const RETRY = { retryOnFail: true, maxTries: 3, waitBetweenTries: 3000 };

function switchByStatus(n, rules) {
  return {
    rules: {
      values: rules.map(([value, outputKey], i) => ({
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
          conditions: [{ id: id(n * 10 + i), leftValue: '={{ $json.status }}', rightValue: value, operator: { type: 'string', operation: 'equals' } }],
          combinator: 'and',
        },
        renameOutput: true,
        outputKey,
      })),
    },
    options: { fallbackOutput: 'extra' },
  };
}

const NOTE = `## Lead Timezone Dispatch Validator

Generated from src/core/ by scripts/build-workflow.js. Edit src/core/, run \`npm run build:workflow\`, re-import.

**Safe by default:** DRY_RUN and SANDBOX_MODE stay true unless set to false. Unresolved timezones go to manual review. IP lookups are off.

**Flow:** intake → enrich → resolve + evaluate → Open (dispatch) │ Wait (record, Wait node until local window, re-check) │ Manual review.

**n8n host:** NODE_FUNCTION_ALLOW_BUILTIN=crypto, N8N_BLOCK_ENV_ACCESS_IN_NODE=false, plus .env.example variables. Waits longer than ~65 s are persisted by n8n and survive restarts.

Full text: DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer.`;

export function buildWorkflow(root = ROOT) {
  const library = buildLibrarySource(root);
  const header = "// AUTO-GENERATED by scripts/build-workflow.js from src/core/. Edit src/core/, then run `npm run build:workflow`.\nconst crypto = require('crypto');";
  const code = (name, n, position, extra = {}) => ({
    parameters: { jsCode: `${header}\n\n${library}\n\n// ---- n8n stage runner ----${PRELUDE}\n${STAGES[name]}\n` },
    id: id(n),
    name,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position,
    ...extra,
  });
  const guarded = { ...RETRY, onError: 'continueErrorOutput' };
  const statusRules = [
    ['open', 'Open Now'],
    ['wait', 'Wait for Window'],
    ['manual', 'Manual Review'],
  ];
  const nodes = [
    { parameters: { content: NOTE, height: 420, width: 620 }, id: id(1), name: 'Read Me', type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: [-120, -520] },
    {
      parameters: { httpMethod: 'POST', path: 'lead-timezone-dispatch', responseMode: 'responseNode', options: {} },
      id: id(2),
      name: 'Lead Intake Webhook',
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2,
      position: [0, 0],
      webhookId: id(97),
    },
    code('Validate Intake', 3, [220, 0]),
    {
      parameters: {
        respondWith: 'json',
        responseBody: '={{ JSON.stringify({ status: $json.status, reason: $json.reason || null }) }}',
        options: { responseCode: '={{ $json.httpStatus }}' },
      },
      id: id(4),
      name: 'Acknowledge Lead',
      type: 'n8n-nodes-base.respondToWebhook',
      typeVersion: 1.1,
      position: [440, 0],
    },
    {
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
          conditions: [{ id: id(51), leftValue: '={{ $json.status }}', rightValue: 'accepted', operator: { type: 'string', operation: 'equals' } }],
          combinator: 'and',
        },
        options: {},
      },
      id: id(5),
      name: 'Lead Accepted?',
      type: 'n8n-nodes-base.if',
      typeVersion: 2,
      position: [660, 0],
    },
    code('Enrich from HubSpot & IP', 6, [880, 0], guarded),
    code('Resolve Timezone & Evaluate Window', 7, [1100, 0], { onError: 'continueErrorOutput' }),
    { parameters: switchByStatus(8, statusRules), id: id(8), name: 'Route by Window Status', type: 'n8n-nodes-base.switch', typeVersion: 3, position: [1320, 0] },
    code('Record Scheduled Dispatch', 9, [1560, 180], guarded),
    {
      parameters: { resume: 'specificTime', dateTime: '={{ $json.resumeAt }}' },
      id: id(10),
      name: 'Wait Until Local Window Opens',
      type: 'n8n-nodes-base.wait',
      typeVersion: 1.1,
      position: [1780, 180],
      webhookId: id(98),
    },
    code('Re-check Window After Wait', 11, [2000, 180], { onError: 'continueErrorOutput' }),
    { parameters: switchByStatus(12, statusRules), id: id(12), name: 'Route After Re-check', type: 'n8n-nodes-base.switch', typeVersion: 3, position: [2220, 180] },
    code('Dispatch Lead', 13, [2460, -60], guarded),
    code('Flag for Manual Review', 14, [2460, 420], guarded),
    code('Log Failure', 15, [2460, 660]),
    {
      parameters: { errorMessage: '={{ "Lead timezone dispatch failed: " + ($json.errors || []).join(" | ") }}' },
      id: id(16),
      name: 'Mark Execution Failed',
      type: 'n8n-nodes-base.stopAndError',
      typeVersion: 1,
      position: [2680, 660],
    },
  ];
  const link = (node) => ({ node, type: 'main', index: 0 });
  const fail = link('Log Failure');
  const connections = {
    'Lead Intake Webhook': { main: [[link('Validate Intake')]] },
    'Validate Intake': { main: [[link('Acknowledge Lead')]] },
    'Acknowledge Lead': { main: [[link('Lead Accepted?')]] },
    'Lead Accepted?': { main: [[link('Enrich from HubSpot & IP')], []] },
    'Enrich from HubSpot & IP': { main: [[link('Resolve Timezone & Evaluate Window')], [fail]] },
    'Resolve Timezone & Evaluate Window': { main: [[link('Route by Window Status')], [fail]] },
    'Route by Window Status': { main: [[link('Dispatch Lead')], [link('Record Scheduled Dispatch')], [link('Flag for Manual Review')], [fail]] },
    'Record Scheduled Dispatch': { main: [[link('Wait Until Local Window Opens')], [fail]] },
    'Wait Until Local Window Opens': { main: [[link('Re-check Window After Wait')]] },
    'Re-check Window After Wait': { main: [[link('Route After Re-check')], [fail]] },
    'Route After Re-check': { main: [[link('Dispatch Lead')], [link('Record Scheduled Dispatch')], [link('Flag for Manual Review')], [fail]] },
    'Dispatch Lead': { main: [[], [fail]] },
    'Flag for Manual Review': { main: [[], [fail]] },
    'Log Failure': { main: [[link('Mark Execution Failed')]] },
  };
  return {
    name: 'HubSpot Lead Timezone Dispatch Validator',
    nodes,
    connections,
    active: false,
    settings: { executionOrder: 'v1', saveDataSuccessExecution: 'none', saveDataErrorExecution: 'all', saveManualExecutions: false, timezone: 'UTC' },
    pinData: {},
    meta: { templateCredsSetupCompleted: true },
    tags: [],
  };
}

export function serializeWorkflow(workflow) {
  return `${JSON.stringify(workflow, null, 2)}\n`;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  const json = serializeWorkflow(buildWorkflow());
  fs.writeFileSync(OUTPUT_PATH, json);
  process.stdout.write(`Wrote ${path.relative(ROOT, OUTPUT_PATH)} (${(json.length / 1024).toFixed(1)} KiB)\n`);
}
