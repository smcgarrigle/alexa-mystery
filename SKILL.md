---
name: alexa-mystery
description: Diagnose unexplained Amazon Alexa/Echo behaviour - a device that speaks, announces, plays audio, changes volume, or triggers on a schedule with no visible routine causing it, or a routine that cannot be found in the Alexa app. Dumps routines, notifications, devices and household profiles from Amazon's private API read-only, then flags what matches a suspect time. Use when someone says their Echo "randomly talks", "goes off every morning", "has a ghost routine", or when a schedule fires that the Alexa app does not show.
---

# Alexa mystery probe

An Echo does something on a schedule. The Alexa app shows no routine that
explains it. This skill finds out what is actually registered server-side.

**The single most useful fact in this skill:** `/api/behaviors/v2/automations`
is scoped to the **authenticated customer id**. A routine owned by another adult
profile in the same Amazon Household is *absent* from the response — not hidden,
not filtered, absent. It can still act on any device in the household. Most
"ghost routine" cases are this, and the Alexa app gives no hint, because it also
only ever shows you your own profile's routines.

## Rules

- **Read-only.** Every probe is a GET. Do not add write or delete operations
  unless the user explicitly asks. Diagnose first; let the user delete through
  the Alexa app, which is safer and reversible.
- **Never print or commit `.alexa-auth.json`.** It is a live Amazon session
  including a refresh token, written mode 600.
- **`dump.json` contains device serial numbers.** Scrub before sharing.
- **Do not suggest a factory reset.** Routines, alarms and reminders live
  server-side against the account. A reset changes nothing. If the user has
  already tried it, that is expected and tells you nothing.
- Work one step at a time and show output before proceeding.

## Step 0 — triage before writing any code

Ask what has already been checked, and cross off:

| Suspect | How to rule out |
|---|---|
| Alarms / reminders / timers | Alexa app → Reminders & Alarms (this skill also dumps them) |
| A routine on the user's own profile | Alexa app → More → Routines |
| **Another Household adult's routine** | **Invisible in the app. This skill finds the profile; that person must check their own app** |
| Alexa Blueprints | alexablueprints.amazon.com |
| A Bluetooth-paired phone's alarm | Unpair and observe |
| A skill with Custom Tasks / notifications | Alexa app → Skills → Your Skills |

Voice history (`alexa.amazon.com` → Settings → Alexa Privacy) is worth a look
but rarely attributes the trigger — it typically shows only the audio itself.

Note the **exact local time** and **which days** it fires. You need both.

## Step 1 — set up and dump

Copy the scripts to a working directory (they write `dump.json` and
`.alexa-auth.json` into the current directory):

```bash
# if installed as a skill:
mkdir -p ~/alexa-probe && cd ~/alexa-probe
cp -r ~/.claude/skills/alexa-mystery/scripts/. .

# if cloned as a repo, the scripts directory already is the working dir:
#   cd <repo>/scripts

npm install
npm run dump
```

The first run needs one interactive Amazon login. It starts a local proxy and
prints a URL. **Amazon publishes no public API for this and there is no API key**
— the session cookie from a real browser login is the only credential that
exists.

- Open the printed URL in a browser and sign in as the account the Echo is
  registered to. The session caches to `.alexa-auth.json` and later runs reuse
  it silently.
- **Passkeys cannot work.** Use **email + password + OTP**. See
  `reference/api-notes.md` for why, and for the WSL2 case.
- The proxy binds to loopback only. Setting `PROXY_IP` opens it to the LAN for
  the duration of the login -- only do that on a trusted network.

## Step 2 — summarise

```bash
npm run summary 07:40      # the suspect time; defaults to 07:40
```

Entities matching that time are flagged `>>>`, with their trigger times,
recurrence rule, invoked skill ids and spoken text extracted.

## Step 3 — read the verdict

**If something is flagged:** read its full JSON and check `owner.id` against the
profile you logged in as.

```bash
node -e "const d=require('./dump.json');console.log(JSON.stringify(d.probes.automations.result,null,2))" | less
```

The fields that matter: `triggers[].payload.schedule` (`triggerTime`,
`recurrence` RRULE, `timeZoneId`), `sequence.startNode` (`type` and `skillId` —
what it actually does), and `owner.id`.

**If nothing is flagged**, do not conclude the account is clean until you check
two things in order:

1. **Did DEVICES come back non-empty?** If devices are empty too, the session is
   broken, not the account.
2. **Does HOUSEHOLD list another ADULT?** If so that profile is the prime
   suspect — its routines were never in this dump. Ask that person to open
   Routines in their own Alexa app. That is a thirty-second check and usually
   ends the hunt. Dumping their account with this tool needs their own login and
   is the slower path.

If the account is genuinely clean and there is no second profile, the remaining
options are deregistering the Echo onto a fresh Amazon account, or a skill-side
notification that does not surface as an automation at all.

## Step 4 — confirm the fix, and watch for masking

Users often build a workaround routine that mutes or stops the device at the
same time. **That workaround will mask your test.** Disable it before declaring
victory, or a silent morning proves only that the workaround works.

Confirm on a day the schedule would actually fire — check the RRULE. A
`BYDAY=MO,TU,WE,TH,FR` routine tells you nothing on a Saturday.

## What gets dumped

| Probe | Endpoint | Why |
|---|---|---|
| `automations` | `/api/behaviors/v2/automations` | Routines. **This profile only.** |
| `notifications` | `/api/notifications` | Alarms, reminders, timers + recurrence |
| `devices` | `/api/devices-v2/device` | Serial ↔ name mapping; session sanity check |
| `smarthomeDevices` | `/api/phoenix` | Smart home entities |
| `household` | `/api/household` | **Other adult profiles** |
| `account` | `/accounts?includeActors=true` | Profile actors |

Library quirks, region overrides, WSL2 notes and the passkey explanation are in
`reference/api-notes.md`. Read it before debugging an auth failure.
