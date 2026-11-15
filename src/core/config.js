/**
 * Environment and configuration loader with explicit secret validation.
 *
 * Fail-safe rules:
 * - DRY_RUN and SANDBOX_MODE stay true unless explicitly set to false/0/no/off.
 * - "YOUR_..._HERE" values count as "not configured".
 * - Leads whose timezone cannot be resolved go to manual review (UNKNOWN_TIMEZONE_ACTION=manual).
 * - IP geolocation lookups are off by default (IP_TIMEZONE_PROVIDER=none).
 * - DRY_RUN=false refuses to run while a required secret is still a placeholder.
 *
 * Embedded verbatim into the n8n Code nodes by scripts/build-workflow.js:
 * top-level names must be unique across src/core/.
 */

const DISPATCH_PLACEHOLDER_RE = /^(?:|your_[a-z0-9_]*_here|changeme|change_me|placeholder|x{3,})$/i;
const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const RESOLUTION_SOURCES = ['explicit', 'ip', 'region', 'phone', 'country'];

export function isUnconfigured(value) {
  if (value === undefined || value === null) return true;
  return DISPATCH_PLACEHOLDER_RE.test(String(value).trim());
}

export function readBooleanEnv(value, defaultValue) {
  if (value === undefined || value === null) return defaultValue;
  const v = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  return defaultValue;
}

function readIntEnv(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

function readListEnv(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  return String(value).split(',').map((s) => s.trim()).filter(Boolean);
}

export function isValidTimeZone(zone) {
  if (!zone || typeof zone !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function parseWindow(startText, endText, label, errors) {
  const s = String(startText).match(HHMM_RE);
  const e = String(endText).match(HHMM_RE);
  if (!s || !e) {
    errors.push(`${label} window must use HH:MM (24h), got "${startText}"-"${endText}"`);
    return { startMinute: 540, endMinute: 1080, label: `${startText}-${endText}` };
  }
  const startMinute = Number(s[1]) * 60 + Number(s[2]);
  const endMinute = Number(e[1]) * 60 + Number(e[2]);
  if (endMinute <= startMinute) errors.push(`${label} window end must be after its start (overnight windows are not supported)`);
  return { startMinute, endMinute, label: `${startText}-${endText}` };
}

export function loadDispatchConfig(env = {}) {
  const read = (key, fallback = '') => {
    const value = env[key];
    return value === undefined || value === null || String(value).trim() === '' ? fallback : String(value).trim();
  };
  const parseErrors = [];
  let holidays = {};
  try {
    holidays = JSON.parse(read('HOLIDAYS_JSON', '{}'));
    if (!holidays || typeof holidays !== 'object' || Array.isArray(holidays)) throw new Error('not an object');
  } catch {
    parseErrors.push('HOLIDAYS_JSON must be a JSON object such as {"US":["2026-11-26"],"*":["2027-01-01"]}');
    holidays = {};
  }
  const order = readListEnv(env.RESOLUTION_ORDER, ['explicit', 'region', 'phone', 'country', 'ip']).map((s) => s.toLowerCase());
  for (const s of order) if (!RESOLUTION_SOURCES.includes(s)) parseErrors.push(`RESOLUTION_ORDER has unknown source "${s}"`);
  const weekdays = readListEnv(env.ALLOWED_WEEKDAYS, ['1', '2', '3', '4', '5']).map(Number);
  if (!weekdays.length || weekdays.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) parseErrors.push('ALLOWED_WEEKDAYS must be ISO weekdays 1-7 (1 = Monday)');
  return {
    dryRun: readBooleanEnv(env.DRY_RUN, true),
    sandboxMode: readBooleanEnv(env.SANDBOX_MODE, true),
    webhook: {
      secret: read('WEBHOOK_SECRET'),
      secretHeader: read('WEBHOOK_SECRET_HEADER', 'x-webhook-secret').toLowerCase(),
      maxBodyBytes: readIntEnv(env.WEBHOOK_MAX_BODY_BYTES, 262144, { min: 1024 }),
    },
    hubspot: {
      token: read('HUBSPOT_PRIVATE_APP_TOKEN'),
      sandboxPortalId: read('HUBSPOT_SANDBOX_PORTAL_ID'),
      baseUrl: read('HUBSPOT_BASE_URL', 'https://api.hubapi.com'),
      writeProperties: readBooleanEnv(env.HUBSPOT_WRITE_PROPERTIES, true),
    },
    resolution: {
      order,
      conflictPolicy: read('CONFLICT_POLICY', 'conservative').toLowerCase() === 'precedence' ? 'precedence' : 'conservative',
      conflictThresholdHours: readIntEnv(env.CONFLICT_THRESHOLD_HOURS, 2, { min: 0, max: 24 }),
      unknownAction: read('UNKNOWN_TIMEZONE_ACTION', 'manual').toLowerCase() === 'default' ? 'default' : 'manual',
      defaultTimezone: read('DEFAULT_TIMEZONE', 'UTC'),
      defaultPhoneCountry: read('DEFAULT_PHONE_COUNTRY', '').toUpperCase(),
      ipProvider: ['none', 'header', 'ipinfo'].includes(read('IP_TIMEZONE_PROVIDER', 'none').toLowerCase()) ? read('IP_TIMEZONE_PROVIDER', 'none').toLowerCase() : 'none',
      ipTimezoneHeader: read('IP_TIMEZONE_HEADER', 'cf-timezone').toLowerCase(),
      ipinfoToken: read('IPINFO_TOKEN'),
      ipLookupTimeoutMs: readIntEnv(env.IP_LOOKUP_TIMEOUT_MS, 1500, { min: 100 }),
    },
    windows: {
      call: parseWindow(read('CALL_WINDOW_START', '09:00'), read('CALL_WINDOW_END', '18:00'), 'CALL', parseErrors),
      email: parseWindow(read('EMAIL_WINDOW_START', '09:00'), read('EMAIL_WINDOW_END', '18:00'), 'EMAIL', parseErrors),
      defaultChannel: ['call', 'email', 'both'].includes(read('DEFAULT_CHANNEL', 'both').toLowerCase()) ? read('DEFAULT_CHANNEL', 'both').toLowerCase() : 'both',
      weekdays,
      holidays,
      endBufferMinutes: readIntEnv(env.WINDOW_END_BUFFER_MINUTES, 30, { min: 0, max: 600 }),
      jitterMinutes: readIntEnv(env.DISPATCH_JITTER_MINUTES, 15, { min: 0, max: 240 }),
      maxDelayHours: readIntEnv(env.MAX_DELAY_HOURS, 96, { min: 1, max: 336 }),
      maxWaitCycles: readIntEnv(env.MAX_WAIT_CYCLES, 3, { min: 1, max: 10 }),
    },
    dispatch: {
      webhookUrl: read('DISPATCH_WEBHOOK_URL'),
      webhookSecret: read('DISPATCH_WEBHOOK_SECRET'),
      sandboxWebhookUrl: read('DISPATCH_SANDBOX_WEBHOOK_URL'),
      includeEmail: readBooleanEnv(env.DISPATCH_INCLUDE_EMAIL, false),
    },
    parseErrors,
  };
}

/** Explicit secret validation. Errors block processing; warnings are reported. */
export function validateDispatchConfig(config) {
  const errors = [...config.parseErrors];
  const warnings = [];
  const live = !config.dryRun;
  if (!isValidTimeZone(config.resolution.defaultTimezone)) errors.push(`DEFAULT_TIMEZONE "${config.resolution.defaultTimezone}" is not a valid IANA timezone`);
  if (config.resolution.ipProvider === 'ipinfo' && isUnconfigured(config.resolution.ipinfoToken)) errors.push('IP_TIMEZONE_PROVIDER=ipinfo requires IPINFO_TOKEN');
  if (isUnconfigured(config.webhook.secret)) {
    if (live) errors.push('WEBHOOK_SECRET is missing or a placeholder');
    else warnings.push('WEBHOOK_SECRET is a placeholder: webhook authentication is skipped in dry run');
  } else if (String(config.webhook.secret).length < 16) {
    errors.push('WEBHOOK_SECRET must be at least 16 characters');
  }
  if (live) {
    if (isUnconfigured(config.hubspot.token) && config.hubspot.writeProperties) errors.push('HUBSPOT_PRIVATE_APP_TOKEN is missing or a placeholder');
    const target = config.sandboxMode ? config.dispatch.sandboxWebhookUrl : config.dispatch.webhookUrl;
    if (!isUnconfigured(target) && !/^https:\/\//.test(target)) errors.push('Dispatch webhook URLs must use https://');
    if (config.sandboxMode && !isUnconfigured(config.dispatch.webhookUrl) && isUnconfigured(config.dispatch.sandboxWebhookUrl)) {
      warnings.push('SANDBOX_MODE=true: DISPATCH_WEBHOOK_URL is ignored until DISPATCH_SANDBOX_WEBHOOK_URL is set');
    }
    if (!config.sandboxMode) warnings.push('SANDBOX_MODE=false and DRY_RUN=false: production HubSpot and dispatch targets are used');
  }
  if (config.resolution.unknownAction === 'default') warnings.push(`UNKNOWN_TIMEZONE_ACTION=default: unresolved leads are treated as ${config.resolution.defaultTimezone}`);
  return { errors, warnings };
}
