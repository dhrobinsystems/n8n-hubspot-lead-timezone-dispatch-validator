# n8n-hubspot-lead-timezone-dispatch-validator

An n8n workflow that sits between lead intake and outbound. For each incoming lead it:

1. resolves the lead's **local timezone** from HubSpot's timezone fields, country/state, phone country code, or IP;
2. checks whether it's currently inside an acceptable **calling or emailing window** there (default 09:00 to 18:00, Monday to Friday, minus holidays);
3. if it isn't, **parks the execution in an n8n Wait node** until the window opens, re-checks, then dispatches.

I built it because automated sequences don't know what time it is for the person on the other end. A 7 a.m. call or a 23:00 email to a fresh lead hurts reply rates, damages sender reputation, and in some markets breaks calling-hour rules.

Two runtimes share one core:

- **`workflow.json`**: Webhook → validate → enrich → resolve and evaluate → Switch → (Dispatch | Record schedule → **Wait** → Re-check | Manual review), with retries and an error branch;
- **a Node.js mirror** (`src/index.js`): an HTTP server with a persistent dispatch queue, for running without n8n;
- **`src/core/`**: the logic both of them use. The Code nodes are generated from it, and the tests run them against the mirror.

Out of the box nothing is written or sent: `DRY_RUN=true`, `SANDBOX_MODE=true`, IP lookups are off, unresolved leads go to manual review, and every secret is a placeholder such as `YOUR_HUBSPOT_PRIVATE_APP_TOKEN_HERE`.

---

## Contents

1. [Architecture overview](#architecture-overview)
2. [Webhook triggers](#webhook-triggers)
3. [Timezone resolution logic](#timezone-resolution-logic)
4. [Business-hours validation](#business-hours-validation)
5. [n8n node configuration](#n8n-node-configuration)
6. [Setup](#setup)
7. [Environment variables](#environment-variables)
8. [Testing](#testing)
9. [Troubleshooting](#troubleshooting)
10. [Repository layout](#repository-layout)

---

## Architecture overview

```
 Lead source (HubSpot workflow webhook, form handler, enrichment tool)
        │ POST /webhook/lead-timezone-dispatch   x-webhook-secret: …
        ▼
 Lead Intake Webhook ─► Validate Intake ─► Acknowledge Lead (202 / 401 / 422) ─► Lead Accepted?
                                                                                     │ yes
                                                                                     ▼
                                                      Enrich from HubSpot & IP (contact properties,
                                                      optional IP timezone)  ──error──► Log Failure ─► Mark Execution Failed
                                                                                     ▼
                                                      Resolve Timezone & Evaluate Window
                                                                                     ▼
                                                      Route by Window Status (Switch)
                          ┌──────────────────────────────┼──────────────────────────────┐
                       Open Now                   Wait for Window                   Manual Review
                          │                              ▼                                │
                          │               Record Scheduled Dispatch                       │
                          │               (HubSpot: outbound_dispatch_status=scheduled)   │
                          │                              ▼                                │
                          │               Wait Until Local Window Opens                   │
                          │               (Wait node, "At Specified Time" = resumeAt)     │
                          │                              ▼                                │
                          │               Re-check Window After Wait                      │
                          │                              ▼                                │
                          │               Route After Re-check ── wait (loop, max 3) ─────┤
                          ▼                              │ open                           ▼
                    Dispatch Lead ◄──────────────────────┘                    Flag for Manual Review
       (HubSpot: dispatched + signed dispatch webhook)                (HubSpot: manual_review + reason)
```

Each stage passes one JSON object along. After intake, the contact's email is dropped from that object unless `DISPATCH_INCLUDE_EMAIL=true`, so long waits don't keep personal data in n8n's waiting executions.

---

## Webhook triggers

`POST /webhook/lead-timezone-dispatch` (n8n) or `POST /webhooks/lead` (Node.js mirror), with header `x-webhook-secret: <WEBHOOK_SECRET>`.

Accepted bodies:

```json
{ "contactId": "123", "phone": "+44 20 7946 0000", "country": "United Kingdom", "state": "", "timezone": "", "ip": "203.0.113.5", "channel": "call" }
```

```json
{ "objectId": 123, "properties": { "phone": { "value": "+1 512 555 0199" }, "state": { "value": "Texas" } } }
```

The second shape is the classic HubSpot workflow *Send a webhook* body.

- `contactId` / `objectId` is optional, but when present (and a real token is configured) the contact is re-read from HubSpot: `phone`, `mobilephone`, `country`, `state`, `hs_timezone`, `hs_ip_timezone`, `ip_country`. CRM values override the payload, except an explicit `timezone` on the payload.
- `channel` is `call`, `email`, or `both` (the intersection of both windows); it defaults to `DEFAULT_CHANNEL`.
- **From HubSpot:** create a contact-based workflow (for example "Lifecycle stage is Lead" or "Form submission"). Add *Send a webhook* → POST to the n8n production URL, and add the API-key header `x-webhook-secret`. Check the exact authentication options in your portal; HubSpot has changed this action's settings over time.

Responses: `202 accepted`, `401 invalid_webhook_secret`, `413 payload_too_large`, `422 no_lead_data`, `500 config_invalid` (live mode with placeholders; the `errors` list names each missing value).

---

## Timezone resolution logic

Signals are tried in `RESOLUTION_ORDER` (default `explicit,region,phone,country,ip`):

| Signal | Source | Example | Confidence |
| --- | --- | --- | --- |
| `explicit` | payload `timezone`, or HubSpot `hs_timezone` (IANA, or HubSpot's `america_slash_new_york` form) | `America/Los_Angeles` | high, never widened |
| `region` | `country` + `state` for US, Canada, Australia; split regions keep every zone | Texas → Central + Mountain | high (single zone) / low (split) |
| `phone` | E.164 calling code (`+44`, `0044`); NANP area codes for Puerto Rico, the Caribbean, Hawaii, Alaska | `+65 …` → `Asia/Singapore` | medium; `+1` with no state → low |
| `country` | `country` alone | `Germany` → `Europe/Berlin` | medium / low for multi-zone countries |
| `ip` | `IP_TIMEZONE_PROVIDER` (`header` such as Cloudflare `cf-timezone`, or `ipinfo`), or HubSpot `hs_ip_timezone` | `Asia/Tokyo` | high |

Rules:

- **Multi-zone results stay multi-zone.** For a `+1` number with no state, the candidates are the six mainland North American zones (Atlantic to Pacific). For Russia it's seven zones. The window has to be open in **every** candidate, which is how I avoid a 6 a.m. call in California because it's already 9 a.m. in New York.
- **Conflicts.** I compare the first signal with the next available one. If they're more than `CONFLICT_THRESHOLD_HOURS` (2) apart, `CONFLICT_POLICY=conservative` merges both sets of zones: a UK number on a Tokyo IP has no shared window, so it goes to manual review. `precedence` trusts the first signal instead. An explicit timezone is never widened.
- **Unresolved leads** go to manual review (`UNKNOWN_TIMEZONE_ACTION=manual`). `default` treats them as `DEFAULT_TIMEZONE` instead.
- **National-format numbers** (no `+`) are ignored unless `DEFAULT_PHONE_COUNTRY` is set.
- All zone maths uses `Intl` and the runtime's tz database, so DST shifts are handled without a dependency. Every zone in `src/core/timezone-data.js` is validated by the tests.

---

## Business-hours validation

For each candidate zone, the current local time must be:

1. on an `ALLOWED_WEEKDAYS` day (ISO, default `1,2,3,4,5`);
2. not a holiday in `HOLIDAYS_JSON` for the lead's country or `"*"`;
3. at or after the window start, and before `end − WINDOW_END_BUFFER_MINUTES`. With the defaults, a call can start between 09:00 and 17:29.

Windows per channel: `CALL_WINDOW_START/END`, `EMAIL_WINDOW_START/END`. `both` uses the overlap of the two.

If the window isn't open, I search forward minute by minute (in 5-minute steps, then refined) for the first instant that's open in every candidate zone, up to `MAX_DELAY_HOURS` (96). The dispatch time then gets a **deterministic jitter** of 0 to `DISPATCH_JITTER_MINUTES` (15), keyed on the contact ID. That way a batch of overnight leads doesn't all fire at 09:00:00, and the same lead always lands on the same minute.

Outcomes:

| Status | Meaning | Next step |
| --- | --- | --- |
| `open` | Inside the window everywhere now | Dispatch Lead |
| `wait` | A shared window opens at `dispatchAt` | Record Scheduled Dispatch → Wait node → Re-check |
| `manual` | Unresolved timezone, no shared window within `MAX_DELAY_HOURS`, or `MAX_WAIT_CYCLES` reached | Flag for Manual Review |

What's written to HubSpot (create these properties once; the script is in [Setup](#setup)):

- `lead_local_timezone`, `lead_timezone_candidates`, `lead_timezone_source`, `lead_timezone_confidence`
- `outbound_dispatch_status`: `scheduled` / `dispatched` / `manual_review`
- `outbound_dispatch_at`, `outbound_dispatch_note`

The dispatch hand-off is an HTTPS POST to `DISPATCH_WEBHOOK_URL` (`DISPATCH_SANDBOX_WEBHOOK_URL` in sandbox mode). It's signed with `x-signature: sha256=HMAC(DISPATCH_WEBHOOK_SECRET, "<timestamp>.<body>")` and `x-signature-timestamp`, and carries `contactId`, `channel`, `timezone`, `candidates`, `confidence`, and `localTimes` (plus `email` only if `DISPATCH_INCLUDE_EMAIL=true`). Point it at your dialer, your sequencer, or a HubSpot workflow that enrolls contacts when `outbound_dispatch_status` becomes `dispatched`.

---

## n8n node configuration

| Node | Type | Configuration |
| --- | --- | --- |
| Read Me | Sticky Note | Setup reminders and the license line |
| Lead Intake Webhook | Webhook v2 | `POST /lead-timezone-dispatch`, respond via *Respond to Webhook* node |
| Validate Intake | Code | `intakeStage`: config and secret validation, payload parsing |
| Acknowledge Lead | Respond to Webhook | Status `{{$json.httpStatus}}`, small JSON body; replies before any waiting |
| Lead Accepted? | IF v2 | `{{$json.status}} == "accepted"` |
| Enrich from HubSpot & IP | Code | `enrichStage`; retry 3× / 3 s; error output → Log Failure |
| Resolve Timezone & Evaluate Window | Code | `evaluateStage` |
| Route by Window Status | Switch v3 | Outputs **Open Now**, **Wait for Window**, **Manual Review**; fallback → Log Failure |
| Record Scheduled Dispatch | Code | `scheduleStage`: HubSpot `scheduled`, sets `resumeAt`; retry 3× |
| Wait Until Local Window Opens | Wait v1.1 | Resume **At Specified Time**, date/time `{{ $json.resumeAt }}` (UTC ISO) |
| Re-check Window After Wait | Code | `evaluateStage` again (covers config changes, holidays, DST) |
| Route After Re-check | Switch v3 | Open → Dispatch; Wait → back to Record Scheduled Dispatch (loop, capped by `MAX_WAIT_CYCLES`); Manual → Flag |
| Dispatch Lead | Code | `dispatchStage`: HubSpot `dispatched` + signed dispatch webhook; retry 3× |
| Flag for Manual Review | Code | `manualReviewStage`: HubSpot `manual_review` with the reason; retry 3× |
| Log Failure → Mark Execution Failed | Code → Stop and Error | Turns any stage error into a failed (and therefore saved) execution |

Notes:

- **Waiting executions.** n8n persists waits longer than about 65 seconds in its database and resumes them after restarts. Waiting executions count toward any execution limits on your plan. `MAX_DELAY_HOURS` keeps them bounded.
- **No n8n credentials.** Tokens are read from `$env`, and HTTP goes through `this.helpers.httpRequest` inside the Code nodes, so the dry-run and sandbox interlocks live in one place.
- **Generated code.** Edit `src/core/`, run `npm run build:workflow`, and re-import. The tests fail if `workflow.json` drifts from a fresh build.
- **Privacy.** `saveDataSuccessExecution: none` keeps successful executions out of the history. Failed executions are saved for debugging; prune them regularly.
- The workflow timezone is set to UTC. All times in node outputs are UTC ISO strings, with the local equivalents in `localTimes`.

---

## Setup

1. **Run it offline first.**

   ```bash
   npm test            # 32 tests, no network
   npm run simulate    # 8 sample leads evaluated at SIMULATE_NOW (Mon 2026-11-16 14:00 UTC)
   ```

   Expected: the UK lead dispatches now; a bare US `+1` number waits until 17:10 UTC (09:00 Pacific plus jitter); the Texas lead waits for 09:00 Mountain; Singapore waits until the next morning; Puerto Rico dispatches; a UK number on a Tokyo IP and a lead with no signal both go to manual review.

2. **Create the HubSpot properties** (sandbox first; needs `crm.schemas.contacts.write` once):

   ```bash
   export HUBSPOT_PRIVATE_APP_TOKEN=YOUR_HUBSPOT_PRIVATE_APP_TOKEN_HERE
   hs() { curl -sS -X POST "https://api.hubapi.com$1" -H "Authorization: Bearer $HUBSPOT_PRIVATE_APP_TOKEN" -H "Content-Type: application/json" -d "$2"; echo; }
   G=contactinformation
   for p in lead_local_timezone lead_timezone_candidates lead_timezone_source lead_timezone_confidence outbound_dispatch_note; do
     hs /crm/v3/properties/contacts '{"name":"'"$p"'","label":"'"$p"'","type":"string","fieldType":"text","groupName":"'"$G"'"}'
   done
   hs /crm/v3/properties/contacts '{"name":"outbound_dispatch_status","label":"Outbound Dispatch Status","type":"enumeration","fieldType":"select","groupName":"'"$G"'","options":[{"label":"Scheduled","value":"scheduled"},{"label":"Dispatched","value":"dispatched"},{"label":"Manual review","value":"manual_review"}]}'
   hs /crm/v3/properties/contacts '{"name":"outbound_dispatch_at","label":"Outbound Dispatch At","type":"datetime","fieldType":"date","groupName":"'"$G"'"}'
   ```

   The Private App needs `crm.objects.contacts.read` and `crm.objects.contacts.write`.

3. **Import the workflow:** Workflows → Import from File → `workflow.json`. On the n8n host, set `NODE_FUNCTION_ALLOW_BUILTIN=crypto` and `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`, plus the variables from `.env.example` (keep `DRY_RUN=true` and `SANDBOX_MODE=true`). Restart n8n.

4. **Configure your markets:** windows, weekdays, and `HOLIDAYS_JSON` for every country you contact.

5. **Dry run:** send test leads to the webhook's test URL. Read the output of `Resolve Timezone & Evaluate Window`: `resolution.candidates`, `decision.localTimes`, and `decision.dispatchAt`.

6. **Sandbox live:** `DRY_RUN=false` with the sandbox HubSpot token and `DISPATCH_SANDBOX_WEBHOOK_URL`. Confirm the properties update and the waiting execution resumes on time.

7. **Production:** set production values and `SANDBOX_MODE=false`, then activate the workflow.

**Without n8n:** `cp .env.example .env && npm start` runs `POST /webhooks/lead` and `GET /healthz`. Scheduled leads go into `data/dispatch-queue.json` (mode `0600`), which is polled every `QUEUE_POLL_SECONDS`. `npm run run-queue` processes due entries once, for cron.

---

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `DRY_RUN` / `SANDBOX_MODE` | `true` / `true` | Safety switches; only `false`/`0`/`no`/`off` disables them |
| `WEBHOOK_SECRET` / `WEBHOOK_SECRET_HEADER` | `YOUR_WEBHOOK_SECRET_HERE` / `x-webhook-secret` | Intake authentication (16+ characters; required live) |
| `WEBHOOK_MAX_BODY_BYTES` | `262144` | Intake size limit |
| `PORT` / `QUEUE_POLL_SECONDS` | `3000` / `60` | Node.js mirror |
| `HUBSPOT_PRIVATE_APP_TOKEN` | `YOUR_HUBSPOT_PRIVATE_APP_TOKEN_HERE` | Private App token (placeholder = offline) |
| `HUBSPOT_SANDBOX_PORTAL_ID` | `YOUR_HUBSPOT_SANDBOX_PORTAL_ID_HERE` | Optional sandbox pin |
| `HUBSPOT_BASE_URL` / `HUBSPOT_WRITE_PROPERTIES` | `https://api.hubapi.com` / `true` | API host / write-back on or off |
| `RESOLUTION_ORDER` | `explicit,region,phone,country,ip` | Signal precedence |
| `CONFLICT_POLICY` / `CONFLICT_THRESHOLD_HOURS` | `conservative` / `2` | Disagreeing-signal handling |
| `UNKNOWN_TIMEZONE_ACTION` / `DEFAULT_TIMEZONE` | `manual` / `UTC` | Unresolved leads |
| `DEFAULT_PHONE_COUNTRY` | — | Country for national-format numbers |
| `IP_TIMEZONE_PROVIDER` / `IP_TIMEZONE_HEADER` / `IPINFO_TOKEN` / `IP_LOOKUP_TIMEOUT_MS` | `none` / `cf-timezone` / placeholder / `1500` | IP-derived timezone |
| `CALL_WINDOW_START` / `CALL_WINDOW_END` | `09:00` / `18:00` | Call window (local) |
| `EMAIL_WINDOW_START` / `EMAIL_WINDOW_END` | `09:00` / `18:00` | Email window (local) |
| `DEFAULT_CHANNEL` | `both` | `call`, `email`, `both` |
| `ALLOWED_WEEKDAYS` | `1,2,3,4,5` | ISO weekdays |
| `HOLIDAYS_JSON` | `{}` (sample values in `.env.example`) | `{"US":["YYYY-MM-DD"],"*":[…]}` |
| `WINDOW_END_BUFFER_MINUTES` / `DISPATCH_JITTER_MINUTES` | `30` / `15` | End buffer / spread |
| `MAX_DELAY_HOURS` / `MAX_WAIT_CYCLES` | `96` / `3` | Limits before manual review |
| `DISPATCH_WEBHOOK_URL` / `DISPATCH_SANDBOX_WEBHOOK_URL` / `DISPATCH_WEBHOOK_SECRET` | placeholders | Signed HTTPS hand-off |
| `DISPATCH_INCLUDE_EMAIL` | `false` | Include the email in the hand-off |
| `SIMULATE_NOW` | `2026-11-16T14:00:00Z` | Fixed clock for `npm run simulate` |

---

## Testing

`tests/timezone.test.js` (32 tests, no network) covers:

- **Config:** defaults, secret validation, window/holiday/order format errors.
- **Resolution:** IANA and HubSpot enum parsing; calling codes, `00` prefixes, and NANP special area codes; country and region aliases, including split states; precedence, confidence, conflict merging, unknown handling.
- **Windows:** local time and DST offsets; open, wait, weekend and end-buffer cases; channel windows; per-country and global holidays; multi-zone intersections; no shared window; max delay; deterministic jitter.
- **HubSpot / IP / dispatch:** dry-run interception, sandbox refusal, edge-header and ipinfo lookups (with failures), signed sandbox dispatch, non-HTTPS refusal.
- **Pipeline:** payload shapes, intake auth, all fixtures, HubSpot enrichment overriding the payload, re-check after the wait, the `MAX_WAIT_CYCLES` cut-off, the persistent queue.
- **n8n:** Wait node configuration, Switch outputs, the re-check loop, error wiring, credential scan, rebuild equality. For every fixture, the real Code nodes produce the same candidates, status, and `resumeAt` as the Node.js mirror.

---

## Troubleshooting

| Symptom | Likely cause and fix |
| --- | --- |
| `401 invalid_webhook_secret` | The header name or value in the lead source doesn't match `WEBHOOK_SECRET_HEADER` / `WEBHOOK_SECRET`. |
| `500 config_invalid` | Live mode with placeholders, or a malformed window, holiday list, or timezone. `errors` lists each one. |
| Every US lead waits until about 17:00 UTC | `+1` numbers with no state are checked across all mainland zones. Capture the state on your forms, or let HubSpot fill `hs_timezone`. |
| Many leads in manual review with `no_shared_window_within_max_delay` | Conflicting signals (often VPN IPs). Try `RESOLUTION_ORDER` without `ip`, or `CONFLICT_POLICY=precedence`. |
| `timezone_unresolved` | No usable phone, country, or timezone. Set `DEFAULT_PHONE_COUNTRY` for national-format numbers, or `UNKNOWN_TIMEZONE_ACTION=default`. |
| Wait node resumes at the wrong time | `resumeAt` is UTC ISO. Check that the n8n instance clock is correct and that nothing changed the workflow timezone. |
| Waiting executions disappear after a restart | Use n8n with a persistent database (not in-memory), and don't delete waiting executions. |
| `sandbox_account_required` / `sandbox_portal_mismatch` | `SANDBOX_MODE=true` with a production HubSpot token. |
| HubSpot `http_400` on write-back | A property from the setup script is missing, or an enum option is missing. |
| Dispatch `not_configured` / `refused_non_https` | Set the (sandbox) dispatch URL, and use `https://`. |
| Code node: `Cannot find module 'crypto'` / `$env` denied | Set `NODE_FUNCTION_ALLOW_BUILTIN=crypto` and `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`, then restart. |
| `this.helpers.httpRequest is not a function` | Your n8n version or task-runner setup doesn't expose the helper in Code nodes. Use the Node.js mirror, or upgrade n8n. |
| Respond node doesn't pass items on | Older n8n versions don't forward items from *Respond to Webhook*. Upgrade, or connect `Validate Intake` directly to both the Respond node and the IF node. |

---

## Repository layout

```
.
├── workflow.json                    # generated, importable n8n workflow
├── README.md
├── DISCLAIMER.md
├── LICENSE
├── .env.example
├── .gitignore
├── package.json
├── scripts/
│   └── build-workflow.js            # regenerates workflow.json from src/core/
├── src/
│   ├── index.js                     # HTTP server + persistent queue, --simulate, --run-queue
│   └── core/                        # shared by Node.js and n8n (embedded into Code nodes)
│       ├── config.js                # env loader, fail-safe flags, explicit secret validation
│       ├── timezone-validator.js    # resolution, conflicts, window evaluation, jitter
│       ├── timezone-data.js         # calling codes, country/region zones, aliases
│       ├── dispatch.js              # HubSpot read/write, IP lookup, signed dispatch webhook
│       └── pipeline.js              # intake → enrich → evaluate → schedule / dispatch / manual
├── fixtures/
│   └── sample-leads.json            # 8 synthetic leads with expected outcomes
├── tests/
│   └── timezone.test.js
└── data/
    └── .gitkeep                     # Node.js dispatch queue (git-ignored)
```

---

## ⚠️ Disclaimer & Liability Limitation

**Use at your own risk.** The code, workflows, and scripts provided in this repository (`n8n-hubspot-lead-timezone-dispatch-validator`) are for educational and architectural demonstration purposes.

* **No Liability:** The author and dhRobin Systems assume no responsibility or liability for any direct, indirect, incidental, or consequential damages resulting from the use, misuse, or deployment of these scripts.
* **No Warranty:** All software, n8n JSON blueprints, and JavaScript modules are provided "AS IS" without warranty of any kind, express or implied, including but not limited to merchantability, fitness for a particular purpose, or non-infringement.
* **Production Testing Required:** Always test thoroughly in an isolated staging environment (for example a HubSpot developer test account or sandbox) with `SANDBOX_MODE=true` and `DRY_RUN=true` enabled before connecting live HubSpot credentials. Treat every dispatched lead as contacted: a call or message cannot be recalled.
* **Third-Party APIs & Compliance:** Users are solely responsible for complying with the terms of service, rate limits, data privacy regulations (GDPR/CCPA), calling-hour and consent rules, and security policies of HubSpot and any connected services. That includes configuring the correct local windows and holidays for every market, honouring every opt-out and do-not-call request, and reviewing leads the validator cannot place.

The full disclaimer is also available in [DISCLAIMER.md](https://github.com/dhrobinsystems/n8n-hubspot-lead-timezone-dispatch-validator/blob/main/DISCLAIMER.md).

## License

Released under the MIT License. Copyright (c) 2026 DH Robin (dhRobin Systems). See [LICENSE](https://github.com/dhrobinsystems/n8n-hubspot-lead-timezone-dispatch-validator/blob/main/LICENSE).

Full text: DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer.
