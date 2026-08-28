'use strict';

/*
 * Read-only. Every probe below is a GET. Nothing here writes, updates or
 * deletes anything on the Amazon side.
 */

const fs = require('fs');
const path = require('path');
const { connect, call, shutdown } = require('./lib/client');

const OUT_FILE = process.env.ALEXA_DUMP_FILE || path.join(process.cwd(), 'dump.json');

/*
 * Method names verified against alexa-remote2@8.1.1.
 *
 * NOTE: there is no `getAutomations()`. The routines probe is
 * `getAutomationRoutines(limit, callback)`, which hits
 * GET /api/behaviors/v2/automations?limit=N.
 *
 * Arities vary across versions of alexa-remote2. If a probe dies with an arity
 * error, adjust that probe's `args` array here -- not lib/client.js.
 */
const PROBES = [
    {
        key: 'automations',
        method: 'getAutomationRoutines',
        args: [2000],
        endpoint: 'GET /api/behaviors/v2/automations?limit=2000',
        note: 'routines -- scoped to the logged-in profile only'
    },
    {
        key: 'notifications',
        method: 'getNotifications',
        args: [false], // false = uncached, ask the server fresh
        endpoint: 'GET /api/notifications?cached=false'
    },
    {
        key: 'devices',
        method: 'getDevices',
        args: [],
        endpoint: 'GET /api/devices-v2/device'
    },
    {
        key: 'smarthomeDevices',
        method: 'getSmarthomeDevices',
        args: [],
        endpoint: 'GET /api/phoenix'
    },
    // These two are the ones that crack most "invisible schedule" cases: they
    // reveal other adult profiles in the Household, whose routines never appear
    // in the automations probe above no matter how clean it looks.
    {
        key: 'household',
        method: 'getHousehold',
        args: [],
        endpoint: 'GET /api/household',
        note: 'other adult profiles -- read this if automations is clean'
    },
    {
        key: 'account',
        method: 'getAccount',
        args: [true], // includeActors
        endpoint: 'GET /accounts?includeActors=true',
        note: 'profile actors'
    }
];

function count(value) {
    if (Array.isArray(value)) return `${value.length} item(s)`;
    if (value && typeof value === 'object') {
        for (const key of ['automations', 'notifications', 'devices', 'devicesV2']) {
            if (Array.isArray(value[key])) return `${value[key].length} in .${key}`;
        }
        return `object, ${Object.keys(value).length} key(s)`;
    }
    if (value === undefined || value === null) return 'empty';
    return typeof value;
}

async function main() {
    console.log('alexa-probe: read-only dump\n');

    const alexa = await connect();
    console.log('Authenticated.\n');

    const dump = {
        capturedAt: new Date().toISOString(),
        library: `alexa-remote2@${require('alexa-remote2/package.json').version}`,
        probes: {},
        errors: {}
    };

    for (const probe of PROBES) {
        const label = probe.note ? `${probe.key}  (${probe.note})` : probe.key;
        process.stdout.write(`  ${label.padEnd(52)} `);
        try {
            const result = await call(alexa, probe.method, probe.args);
            dump.probes[probe.key] = { endpoint: probe.endpoint, result };
            console.log(`ok   ${count(result)}`);
        } catch (err) {
            const message = String((err && err.message) || err);
            dump.errors[probe.key] = { endpoint: probe.endpoint, error: message };
            console.log(`FAIL ${message}`);
        }
    }

    // Contains device serial numbers. Gitignored; scrub before sharing.
    fs.writeFileSync(OUT_FILE, JSON.stringify(dump, null, 2), { mode: 0o600 });
    fs.chmodSync(OUT_FILE, 0o600);

    const bytes = fs.statSync(OUT_FILE).size;
    console.log(`\nWrote ${path.basename(OUT_FILE)} (${bytes.toLocaleString()} bytes, mode 600).`);
    console.log('Next: npm run summary');

    shutdown(alexa);
    process.exit(0);
}

main().catch((err) => {
    console.error(`\nFAILED: ${(err && err.message) || err}`);
    console.error('If this was the first run and it died at login, re-run with');
    console.error('DEBUG=1 npm run dump and read what alexa-remote2 actually emitted.');
    console.error('Passkeys cannot work through the login proxy -- use password + OTP.');
    process.exit(1);
});
