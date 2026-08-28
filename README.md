# alexa-mystery

Your Echo says something every morning. The Alexa app shows no routine that
explains it. This finds out what is actually registered against your Amazon
account.

Read-only: every probe is a GET. It reports; you delete through the Alexa app.

## The short version

`GET /api/behaviors/v2/automations` is scoped to the **authenticated customer
id**. A routine owned by another adult profile in the same Amazon Household is
**absent** from the response — not hidden, not filtered by the app, absent. It
can still act on any device in the household.

That is the answer to most "ghost routine" cases, and neither the app nor the
API gives you any hint, because the app only ever shows your own routines
either. This tool dumps `/api/household` alongside the routines so the second
profile becomes visible.

Things that are *not* the answer, and can be skipped: a factory reset (routines
live server-side, a reset changes nothing) and re-checking your own Routines
list.

## Usage

```bash
git clone <this repo> alexa-probe && cd alexa-probe/scripts
npm install
npm run dump              # one interactive Amazon login, then cached
npm run summary 07:40     # the time it fires
```

Anything matching that time is flagged `>>>`, with trigger time, recurrence
rule, invoked skill ids and spoken text pulled out. If nothing is flagged, read
the `HOUSEHOLD PROFILES` block — if it lists another adult, that is your suspect
and they need to check Routines in their own Alexa app.

### Why the lockfile is committed

`package-lock.json` is deliberately in the repo, so `npm install` gives you the
exact dependency tree these docs describe.

That matters more than usual here. `reference/api-notes.md` cites specific line
numbers in `alexa-remote2@8.1.1` and `alexa-cookie2@5.0.6`, and `lib/client.js`
matches a regex against an error *string* the library emits during login. If that
wording changes, the login hangs — and the troubleshooting notes would be
pointing at the wrong code while you tried to work out why. `alexa-remote2` ships
often (four releases in the eight weeks before 8.1.1), so the `^8.1.1` range
drifts quickly.

Want the newest versions instead? `npm update`. Expect the cited line numbers to
be stale, and use `DEBUG=1 npm run dump` to see what the library actually emits.

One thing the lockfile is *not* responsible for: `npm audit` reports 3
low-severity advisories reached through `cookie`. `alexa-cookie2` requires
`cookie: ^0.6.0` and the fix landed in 0.7.0, which that range cannot reach — so
every install gets 0.6.0, locked or not, until it is bumped upstream.

As a Claude Code skill instead:

```bash
git clone <this repo> ~/.claude/skills/alexa-mystery
```

Then ask Claude about the unexplained Echo behaviour and it will pick the skill
up. `SKILL.md` is the agent-facing procedure; `reference/api-notes.md` holds the
library quirks and auth details.

## Login, and why there is no API key

Amazon publishes no public API for this. The only credential that exists is a
real browser session cookie, captured through a local login proxy that
`alexa-cookie2` stands up. `npm run dump` starts it and prints a URL to open.

- **Passkeys cannot work.** The proxy rewrites Amazon URLs to `127.0.0.1`, so
  the browser origin is not `amazon.com` and WebAuthn refuses before any request
  leaves the machine. Use **email + password + OTP**. Full explanation in
  `reference/api-notes.md`.
- Non-US accounts need the region environment variables — see the same file.
- On WSL2, open the URL in a **Windows** browser.

## Security

- **`.alexa-auth.json` is a live Amazon session including a refresh token.** It
  is written mode 600 and is in `.gitignore`. Do not commit it, paste it, or put
  it in a bug report. Anyone holding it has your Alexa account.
- **`dump.json` contains device serial numbers.** Also gitignored. Scrub before
  sharing.
- The login proxy binds to **loopback only** by default. Setting `PROXY_IP` (the
  WSL2 fallback) makes it listen on all interfaces for the duration of the
  login — do not do that on a network you do not trust.

## Caveats

Amazon's Conditions of Use do not permit automated access to their services. Use
this against **your own account, at your own risk**. It is read-only and makes no
changes, but that is a design choice, not a guarantee about how Amazon treats it.

Verified against `alexa-remote2@8.1.1` on a US account. The region overrides are
documented from the library source but have not been exercised.

## Credits

Built on [`alexa-remote2`](https://github.com/Apollon77/alexa-remote) and
[`alexa-cookie2`](https://github.com/Apollon77/alexa-cookie) by Apollon77, which
do all the real work of speaking Amazon's private endpoints. Both MIT.

## Licence

MIT-0 (MIT No Attribution). Do whatever you like with it; no credit required.
