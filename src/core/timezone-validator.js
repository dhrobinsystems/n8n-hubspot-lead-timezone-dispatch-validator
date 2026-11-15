/**
 * Timezone resolution and outbound-window evaluation.
 *
 * Resolution signals (tried in RESOLUTION_ORDER, default explicit → region → phone → country → ip):
 *   explicit  a timezone on the payload or HubSpot's hs_timezone (IANA or HubSpot's "america_slash_new_york" form)
 *   ip        IP_TIMEZONE_PROVIDER (edge header or ipinfo), or HubSpot's hs_ip_timezone
 *   region    country + state/province (US, CA, AU), split regions keep every zone they span
 *   phone     E.164 calling code; NANP area codes for the Caribbean, Hawaii and Alaska
 *   country   the country property alone
 *
 * Multi-zone results stay multi-zone: the window must be open in every candidate zone.
 * With CONFLICT_POLICY=conservative, a second signal that disagrees by more than
 * CONFLICT_THRESHOLD_HOURS from every primary zone is merged in as well (VPNs, travel, ported
 * numbers). An explicit timezone is authoritative and never widened.
 *
 * All maths uses Intl, so DST transitions follow the runtime's tz database.
 */
import { isValidTimeZone } from './config.js';
import {
  CALLING_CODES,
  COUNTRY_NAME_ALIASES,
  MULTI_ZONE_COUNTRIES,
  NANP_MAINLAND_ZONES,
  NANP_SPECIAL_AREA_CODES,
  REGION_NAME_ALIASES,
  REGION_ZONES,
  SINGLE_ZONE_COUNTRIES,
} from './timezone-data.js';

const WEEKDAY_INDEX = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const MINUTE_MS = 60000;

export function canonicalTimeZone(value) {
  if (value === undefined || value === null) return null;
  let raw = String(value).trim();
  if (!raw) return null;
  raw = raw.replace(/_slash_/gi, '/').replace(/_underscore_/gi, '_');
  if (!raw.includes('/') && !/^utc$|^gmt$/i.test(raw)) return null;
  if (!isValidTimeZone(raw)) return null;
  return new Intl.DateTimeFormat('en-US', { timeZone: raw }).resolvedOptions().timeZone;
}

export function normalizeCountryCode(value) {
  if (value === undefined || value === null) return null;
  const v = String(value).trim();
  if (!v) return null;
  if (/^[A-Za-z]{2}$/.test(v)) {
    const iso = v.toUpperCase();
    const known = SINGLE_ZONE_COUNTRIES[iso] || MULTI_ZONE_COUNTRIES[iso];
    return known ? (iso === 'UK' ? 'GB' : iso) : iso === 'UK' ? 'GB' : null;
  }
  return COUNTRY_NAME_ALIASES[v.toLowerCase()] || null;
}

export function zonesForCountry(iso) {
  if (!iso) return [];
  if (MULTI_ZONE_COUNTRIES[iso]) return MULTI_ZONE_COUNTRIES[iso].slice();
  return SINGLE_ZONE_COUNTRIES[iso] ? [SINGLE_ZONE_COUNTRIES[iso]] : [];
}

export function zonesForRegion(iso, region) {
  if (!iso || !region || !REGION_ZONES[iso]) return [];
  const raw = String(region).trim();
  const code = REGION_ZONES[iso][raw.toUpperCase()] ? raw.toUpperCase() : (REGION_NAME_ALIASES[iso] || {})[raw.toLowerCase()];
  return code && REGION_ZONES[iso][code] ? REGION_ZONES[iso][code].slice() : [];
}

/** Parses +CC / 00CC numbers (or national numbers with DEFAULT_PHONE_COUNTRY) into a country and zones. */
export function resolvePhone(rawPhone, defaultCountry = '') {
  if (!rawPhone) return null;
  const text = String(rawPhone).trim();
  let digits = text.replace(/[^\d+]/g, '');
  let international = false;
  if (digits.startsWith('+')) {
    international = true;
    digits = digits.slice(1).replace(/\+/g, '');
  } else if (digits.startsWith('00')) {
    international = true;
    digits = digits.slice(2);
  }
  digits = digits.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  let callingCode = null;
  let country = null;
  if (international) {
    for (const len of [1, 2, 3]) {
      const code = Number(digits.slice(0, len));
      if (CALLING_CODES[code]) {
        callingCode = code;
        country = CALLING_CODES[code];
        break;
      }
    }
    if (!country) return null;
  } else if (defaultCountry) {
    country = defaultCountry === 'US' || defaultCountry === 'CA' ? 'NANP' : defaultCountry;
    callingCode = country === 'NANP' ? 1 : null;
    if (country === 'NANP') digits = digits.length === 10 ? `1${digits}` : digits;
  } else {
    return null;
  }
  if (country === 'NANP') {
    const area = Number(digits.slice(1, 4));
    if (digits.length !== 11) return null;
    if (NANP_SPECIAL_AREA_CODES[area]) return { callingCode: 1, country: 'NANP', areaCode: area, zones: [NANP_SPECIAL_AREA_CODES[area]], precision: 'area_code' };
    return { callingCode: 1, country: 'NANP', areaCode: area, zones: NANP_MAINLAND_ZONES.slice(), precision: 'nanp_mainland' };
  }
  const zones = zonesForCountry(country);
  return zones.length ? { callingCode, country, zones, precision: zones.length === 1 ? 'country' : 'country_multi_zone' } : null;
}

export function localParts(ms, zone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  }).formatToParts(new Date(ms));
  const get = (type) => parts.find((p) => p.type === type).value;
  const hour = Number(get('hour')) % 24;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour,
    minute: Number(get('minute')),
    minuteOfDay: hour * 60 + Number(get('minute')),
    weekday: WEEKDAY_INDEX[get('weekday')],
    label: `${get('weekday')} ${get('year')}-${get('month')}-${get('day')} ${String(hour).padStart(2, '0')}:${get('minute')}`,
  };
}

export function utcOffsetMinutes(ms, zone) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
    .formatToParts(new Date(ms))
    .reduce((acc, part) => ({ ...acc, [part.type]: Number(part.value) }), {});
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute);
  return Math.round((asUtc - Math.floor(ms / MINUTE_MS) * MINUTE_MS) / MINUTE_MS);
}

/** Smallest UTC-offset distance between any zone in A and any zone in B, in hours. */
function offsetDistanceHours(zonesA, zonesB, ms) {
  let best = Infinity;
  for (const a of zonesA) {
    const oa = utcOffsetMinutes(ms, a);
    for (const b of zonesB) best = Math.min(best, Math.abs(oa - utcOffsetMinutes(ms, b)));
  }
  return best / 60;
}

/** Collects every usable signal for a lead. `lead` uses HubSpot property names. */
export function collectTimezoneSignals(lead, { resolution }, ipTimezone = null) {
  const signals = {};
  const explicit = canonicalTimeZone(lead.timezone) || canonicalTimeZone(lead.hs_timezone);
  if (explicit) signals.explicit = { zones: [explicit], detail: lead.timezone ? 'payload timezone' : 'hs_timezone' };
  const ip = canonicalTimeZone(ipTimezone) || canonicalTimeZone(lead.hs_ip_timezone);
  if (ip) signals.ip = { zones: [ip], detail: ipTimezone ? `IP lookup (${resolution.ipProvider})` : 'hs_ip_timezone' };
  const country = normalizeCountryCode(lead.country) || normalizeCountryCode(lead.ip_country);
  const regionZones = zonesForRegion(country, lead.state);
  if (regionZones.length) signals.region = { zones: regionZones, detail: `${country}/${String(lead.state).trim()}` };
  const phone = resolvePhone(lead.phone, resolution.defaultPhoneCountry) || resolvePhone(lead.mobilephone, resolution.defaultPhoneCountry);
  if (phone) signals.phone = { zones: phone.zones, detail: `+${phone.callingCode} (${phone.precision})` };
  const countryZones = zonesForCountry(country);
  if (countryZones.length) signals.country = { zones: countryZones, detail: country };
  return { signals, country: country || (phone && phone.country !== 'NANP' ? phone.country : phone ? 'US' : null) };
}

function confidenceFor(source, zones) {
  if (source === 'explicit') return 'high';
  if (zones.length > 1) return 'low';
  if (source === 'region' || source === 'ip') return 'high';
  return 'medium';
}

export function resolveTimezone(lead, config, { ipTimezone = null, nowMs = Date.now() } = {}) {
  const { signals, country } = collectTimezoneSignals(lead, config, ipTimezone);
  const available = config.resolution.order.filter((s) => signals[s]);
  if (!available.length) {
    if (config.resolution.unknownAction === 'default') {
      return { resolved: true, timezone: config.resolution.defaultTimezone, candidates: [config.resolution.defaultTimezone], source: 'default', confidence: 'none', country, signals, conflict: null };
    }
    return { resolved: false, timezone: null, candidates: [], source: null, confidence: 'none', country, signals, conflict: null };
  }
  const primary = available[0];
  let candidates = signals[primary].zones;
  let conflict = null;
  const secondary = primary === 'explicit' ? null : available.find((s) => s !== primary);
  if (secondary) {
    const distance = offsetDistanceHours(candidates, signals[secondary].zones, nowMs);
    if (distance > config.resolution.conflictThresholdHours) {
      conflict = { with: secondary, spreadHours: distance, policy: config.resolution.conflictPolicy };
      if (config.resolution.conflictPolicy === 'conservative') candidates = [...new Set([...candidates, ...signals[secondary].zones])];
    }
  }
  return {
    resolved: true,
    timezone: candidates[0],
    candidates,
    source: primary,
    confidence: conflict && config.resolution.conflictPolicy === 'conservative' ? 'low' : confidenceFor(primary, candidates),
    country,
    signals,
    conflict,
  };
}

export function channelWindow(windows, channel) {
  const call = windows.call;
  const email = windows.email;
  if (channel === 'call') return { startMinute: call.startMinute, endMinute: call.endMinute };
  if (channel === 'email') return { startMinute: email.startMinute, endMinute: email.endMinute };
  return { startMinute: Math.max(call.startMinute, email.startMinute), endMinute: Math.min(call.endMinute, email.endMinute) };
}

function holidaysFor(windows, country) {
  return [...(windows.holidays['*'] || []), ...((country && windows.holidays[country]) || [])];
}

export function isOpenInZone(ms, zone, { window, windows, country }) {
  const p = localParts(ms, zone);
  if (!windows.weekdays.includes(p.weekday)) return false;
  if (holidaysFor(windows, country).includes(p.date)) return false;
  return p.minuteOfDay >= window.startMinute && p.minuteOfDay < window.endMinute - windows.endBufferMinutes;
}

function stableHash(text) {
  let h = 2166136261;
  for (const ch of String(text)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

/**
 * Decides whether the lead can be contacted now in every candidate zone, and if not,
 * when the earliest shared window opens (searched up to MAX_DELAY_HOURS ahead).
 */
export function evaluateOutboundWindow({ candidates, channel, country, nowMs, windows, jitterKey = '' }) {
  const window = channelWindow(windows, channel);
  const ctx = { window, windows, country };
  const openAll = (ms) => candidates.every((zone) => isOpenInZone(ms, zone, ctx));
  const localTimes = Object.fromEntries(candidates.map((z) => [z, localParts(nowMs, z).label]));
  if (window.endMinute - windows.endBufferMinutes <= window.startMinute) {
    return { status: 'manual', reason: 'window_shorter_than_end_buffer', localTimes, window };
  }
  if (openAll(nowMs)) return { status: 'open', reason: 'inside_window', dispatchAt: new Date(nowMs).toISOString(), localTimes, window };
  const limit = nowMs + windows.maxDelayHours * 3600 * 1000;
  let t = Math.ceil((nowMs + 1) / MINUTE_MS) * MINUTE_MS;
  while (t % (5 * MINUTE_MS) !== 0 && t <= limit) {
    if (openAll(t)) break;
    t += MINUTE_MS;
  }
  if (!openAll(t)) {
    while (t <= limit && !openAll(t)) t += 5 * MINUTE_MS;
    if (t > limit) return { status: 'manual', reason: 'no_shared_window_within_max_delay', localTimes, window };
    for (let back = 1; back < 5 && openAll(t - MINUTE_MS); back += 1) t -= MINUTE_MS;
  }
  const opensAt = t;
  let dispatchAt = opensAt;
  if (windows.jitterMinutes > 0) {
    const jittered = opensAt + (stableHash(jitterKey) % (windows.jitterMinutes + 1)) * MINUTE_MS;
    if (openAll(jittered)) dispatchAt = jittered;
  }
  return {
    status: 'wait',
    reason: 'outside_window',
    opensAt: new Date(opensAt).toISOString(),
    dispatchAt: new Date(dispatchAt).toISOString(),
    delayMinutes: Math.round((dispatchAt - nowMs) / MINUTE_MS),
    localTimes,
    localTimesAtDispatch: Object.fromEntries(candidates.map((z) => [z, localParts(dispatchAt, z).label])),
    window,
  };
}

/** n8n-friendly single call: resolve + evaluate for one lead. */
export function validateLeadTiming(lead, config, { nowMs = Date.now(), ipTimezone = null, channel } = {}) {
  const resolution = resolveTimezone(lead, config, { ipTimezone, nowMs });
  const effectiveChannel = ['call', 'email', 'both'].includes(channel) ? channel : config.windows.defaultChannel;
  if (!resolution.resolved) {
    return { resolution, channel: effectiveChannel, decision: { status: 'manual', reason: 'timezone_unresolved', localTimes: {} } };
  }
  const decision = evaluateOutboundWindow({
    candidates: resolution.candidates,
    channel: effectiveChannel,
    country: resolution.country,
    nowMs,
    windows: config.windows,
    jitterKey: lead.id || lead.email || '',
  });
  return { resolution, channel: effectiveChannel, decision };
}
