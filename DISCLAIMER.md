# ⚠️ Disclaimer & Liability Limitation

> Full text: DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer.

**Use at your own risk.** The code, workflows, and scripts provided in this repository (`n8n-hubspot-lead-timezone-dispatch-validator`) are for educational and architectural demonstration purposes. I publish them as a reference implementation from dhRobin Systems, not as a managed product or service.

## No Liability

The author and dhRobin Systems assume no responsibility or liability for any direct, indirect, incidental, special, exemplary, or consequential damages resulting from the use, misuse, or deployment of these scripts. That includes, without limitation: calls, messages, or emails sent outside a recipient's permitted or preferred hours; leads delayed, never dispatched, or dispatched twice; incorrect timezone resolution; regulatory complaints, penalties, or claims under telemarketing, telecommunications, or electronic-marketing laws; sender-reputation damage; API rate-limit or quota overruns; and third-party service outages. This applies however the damage is caused and on any theory of liability, even if advised of the possibility of such damage.

## No Warranty

All software, n8n JSON blueprints, and JavaScript modules are provided "AS IS" without warranty of any kind, express or implied, including but not limited to merchantability, fitness for a particular purpose, or non-infringement. I do not warrant that the bundled calling-code, country, and region timezone data is complete or current, that a lead's phone number or IP address reflects where they are, or that n8n, HubSpot, or any IP-geolocation service will keep the behaviour this project expects.

## Timezone Resolution Is an Estimate

A phone country code, a CRM state field, or an IP address is evidence of a location, not proof. Numbers are ported, people travel, VPNs move IP addresses, and several countries span many timezones. The validator picks the most conservative window it can, and sends leads it cannot place to manual review by default. You remain responsible for every contact attempt.

## Compliance Is Your Responsibility

Calling, texting, and emailing hours, consent, and do-not-call rules differ by country, state, and channel. For example, US telemarketing rules restrict calls to between 8 a.m. and 9 p.m. in the recipient's local time, and other jurisdictions have their own windows, holidays, and consent requirements. The default 09:00 to 18:00 window is a business convention, not legal advice. Configure the windows, weekdays, and holidays for every market you contact, and confirm them with qualified counsel.

## Production Testing Required

Always test thoroughly in an isolated staging environment (for example a HubSpot developer test account or sandbox, and a sandbox dispatch endpoint) with `SANDBOX_MODE=true` and `DRY_RUN=true` enabled before connecting live HubSpot credentials. Treat every dispatched lead as contacted: a call or message cannot be recalled.

## Third-Party APIs & Data Protection

Users are solely responsible for complying with the terms of service, rate limits, data privacy regulations (GDPR, UK GDPR, CCPA/CPRA, ePrivacy, TCPA, CASL, and any other applicable law), and security policies of HubSpot, IP-geolocation providers, dialers, sequencers, and any other connected service. That includes confirming a lawful basis for processing phone numbers and IP addresses, sending IP addresses to a geolocation provider only where permitted, honouring every opt-out and do-not-call request, and limiting personal data in n8n execution history.

## Not Professional Advice

Nothing in this repository is legal, compliance, or telecommunications advice. Consult qualified professionals for your jurisdiction and use case.

---

Full text: DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer.
