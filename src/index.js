#!/usr/bin/env node
/**
 * Node.js mirror of the n8n workflow.
 *
 *   node src/index.js               HTTP server (POST /webhooks/lead, GET /healthz) with a persistent
 *                                   dispatch queue (data/dispatch-queue.json) polled every QUEUE_POLL_SECONDS
 *   node src/index.js --simulate    evaluate fixtures/sample-leads.json at SIMULATE_NOW (DRY_RUN forced on)
 *   node src/index.js --run-queue   process due queue entries once (cron-friendly)
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadDispatchConfig, validateDispatchConfig } from './core/config.js';
import { createDispatchClients, processLead, recheckLead, summarizeLead } from './core/pipeline.js';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const QUEUE_PATH = path.join(ROOT_DIR, 'data', 'dispatch-queue.json');

export function loadDotEnvFile(filePath = path.join(ROOT_DIR, '.env'), target = process.env) {
  if (!fs.existsSync(filePath)) return false;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let value = match[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    if (target[match[1]] === undefined) target[match[1]] = value;
  }
  return true;
}

function log(level, msg, data = {}) {
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(`${JSON.stringify({ ts: new Date().toISOString(), level, msg, ...data })}\n`);
}

/** Small JSON-file queue so scheduled dispatches survive restarts. */
export function createDispatchQueue(file = QUEUE_PATH) {
  const read = () => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return [];
    }
  };
  const write = (items) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(items, null, 2)}\n`, { mode: 0o600 });
  };
  return {
    add(ctx) {
      const items = read().filter((i) => !(ctx.contactId && i.contactId === ctx.contactId));
      items.push(ctx);
      write(items);
    },
    takeDue(nowMs) {
      const items = read();
      const due = items.filter((i) => Date.parse(i.resumeAt) <= nowMs);
      write(items.filter((i) => Date.parse(i.resumeAt) > nowMs));
      return due;
    },
    size: () => read().length,
  };
}

export async function runQueueOnce({ config, queue, fetchImpl = globalThis.fetch, clients, now = () => Date.now(), logger = log }) {
  const results = [];
  for (const ctx of queue.takeDue(now())) {
    try {
      const next = await recheckLead(ctx, { config, fetchImpl, clients, now });
      if (next.status === 'scheduled') queue.add(next);
      results.push(summarizeLead(next));
    } catch (err) {
      queue.add({ ...ctx, resumeAt: new Date(now() + 15 * 60000).toISOString() });
      logger('error', 'queue_item_failed', { contactId: ctx.contactId, code: err.code || null });
    }
  }
  return results;
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= maxBytes) chunks.push(chunk);
    });
    req.on('end', () => (size > maxBytes ? reject(Object.assign(new Error('payload_too_large'), { statusCode: 413 })) : resolve(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(json), 'cache-control': 'no-store' });
  res.end(json);
}

export function createServer({ env = process.env, fetchImpl = globalThis.fetch, queue = createDispatchQueue(), logger = log, now = () => Date.now() } = {}) {
  const config = loadDispatchConfig(env);
  const clients = createDispatchClients(config, { fetchImpl });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/healthz') {
        const { errors, warnings } = validateDispatchConfig(config);
        return sendJson(res, 200, { ok: !errors.length, dryRun: config.dryRun, sandboxMode: config.sandboxMode, queued: queue.size(), errors: errors.length, warnings: warnings.length });
      }
      if (req.method === 'POST' && url.pathname === '/webhooks/lead') {
        const raw = await readBody(req, config.webhook.maxBodyBytes);
        let body;
        try {
          body = JSON.parse(raw || '{}');
        } catch {
          return sendJson(res, 400, { status: 'rejected', reason: 'invalid_json' });
        }
        const ctx = await processLead({ body, headers: req.headers }, { config, fetchImpl, clients, now });
        if (ctx.status === 'scheduled') queue.add(ctx);
        const summary = summarizeLead(ctx);
        logger('info', 'lead_processed', { status: summary.status, reason: summary.reason, timezone: summary.timezone, confidence: summary.confidence, resumeAt: summary.resumeAt });
        return sendJson(res, ctx.httpStatus && ctx.status === 'rejected' ? ctx.httpStatus : 202, { status: summary.status, reason: summary.reason, resumeAt: summary.resumeAt, dryRun: config.dryRun });
      }
      return sendJson(res, 404, { error: 'not_found' });
    } catch (err) {
      const status = err.statusCode || 500;
      logger('error', 'request_failed', { status, code: err.code || null });
      return sendJson(res, status, { status: 'failed', reason: status === 413 ? 'payload_too_large' : 'internal_error' });
    }
  });
  return { server, config, clients, queue };
}

export function simulationNow(env = process.env) {
  return Date.parse(env.SIMULATE_NOW || '2026-11-16T14:00:00Z');
}

export async function runSimulation({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const leads = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'fixtures', 'sample-leads.json'), 'utf8'));
  const now = () => simulationNow(env);
  const results = [];
  for (const entry of leads) {
    const config = loadDispatchConfig({ ...env, ...(entry.env || {}), DRY_RUN: 'true', HUBSPOT_PRIVATE_APP_TOKEN: '' });
    const ctx = await processLead({ body: entry.body, headers: entry.headers || {} }, { config, fetchImpl, now });
    results.push({ name: entry.name, expected: entry.expectedStatus, ...summarizeLead(ctx) });
  }
  return results;
}

async function main(argv) {
  loadDotEnvFile();
  if (argv.includes('--simulate')) {
    const results = await runSimulation();
    process.stdout.write(`Simulated "now": ${new Date(simulationNow()).toISOString()}\n`);
    for (const r of results) {
      const ok = r.status === r.expected ? '✓' : '✗';
      process.stdout.write(`\n${ok} ${r.name}\n   status=${r.status}${r.reason ? ` (${r.reason})` : ''} source=${r.source} confidence=${r.confidence}\n   zones=${r.candidates.join(', ') || 'none'}\n   local now: ${Object.entries(r.localTimes).map(([z, t]) => `${z} ${t}`).join(' | ') || 'n/a'}\n`);
      if (r.resumeAt) process.stdout.write(`   resumes at ${r.resumeAt}\n`);
      if (r.conflict) process.stdout.write(`   conflict with ${r.conflict.with}: ${r.conflict.spreadHours}h apart (${r.conflict.policy})\n`);
    }
    process.stdout.write('\nSimulation ran offline with DRY_RUN forced to true.\n');
    process.exitCode = results.every((r) => r.status === r.expected) ? 0 : 1;
    return;
  }
  const config = loadDispatchConfig(process.env);
  if (argv.includes('--run-queue')) {
    const results = await runQueueOnce({ config, queue: createDispatchQueue() });
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    return;
  }
  const { errors, warnings } = validateDispatchConfig(config);
  warnings.forEach((w) => log('warn', 'config_warning', { warning: w }));
  if (errors.length) {
    errors.forEach((e) => log('error', 'config_error', { error: e }));
    process.exitCode = 1;
    return;
  }
  const { server, queue, clients } = createServer({ env: process.env });
  const port = Number(process.env.PORT) || 3000;
  const pollMs = (Number(process.env.QUEUE_POLL_SECONDS) || 60) * 1000;
  const timer = setInterval(() => runQueueOnce({ config, queue, clients }).catch((err) => log('error', 'queue_poll_failed', { message: err.message })), pollMs);
  server.listen(port, () => log('info', 'server_started', { port, dryRun: config.dryRun, sandboxMode: config.sandboxMode, queued: queue.size() }));
  const shutdown = () => {
    clearInterval(timer);
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`${err.stack || err.message}\n`);
    process.exitCode = 1;
  });
}
