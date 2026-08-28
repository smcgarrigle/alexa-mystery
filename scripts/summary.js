'use strict';

/*
 * Read-only. Flattens dump.json and flags anything scheduled at the target
 * time with >>>.
 *
 * Usage: node summary.js [HH:MM]     (default 07:40, or $MATCH_TIME)
 *
 * The shape of an automation is not documented and varies by how it was
 * created, so this deliberately does generic extraction over the whole JSON
 * tree rather than assuming a schema. Anything it fails to summarise is still
 * in dump.json in full.
 */

const fs = require('fs');
const path = require('path');

const DUMP_FILE = process.env.ALEXA_DUMP_FILE || path.join(process.cwd(), 'dump.json');
const TARGET = process.argv[2] || process.env.MATCH_TIME || '07:40';

const [TH, TM] = TARGET.split(':');
// Matches 07:40, 07:40:00, 0740, 074000, 074000.000
const TARGET_RE = new RegExp(`(?<!\\d)${TH}:${TM}(?!\\d)|(?<!\\d)${TH}${TM}(00)?(?!\\d)`);

// Time-ish literals anywhere in the tree: "07:40:00.000" or "074000.000"
const CLOCK_RE = /(?<!\d)(\d{2}):(\d{2})(?::(\d{2}))?(?!\d)/;
const COMPACT_RE = /^(\d{2})(\d{2})(\d{2})(?:\.\d+)?$/;

function walk(node, visit, keyPath = []) {
    if (Array.isArray(node)) {
        node.forEach((child, i) => walk(child, visit, keyPath.concat(String(i))));
    } else if (node && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
            visit(key, value, keyPath.concat(key));
            walk(value, visit, keyPath.concat(key));
        }
    }
}

function prettyTime(value) {
    const compact = COMPACT_RE.exec(value);
    if (compact) return `${compact[1]}:${compact[2]}:${compact[3]}`;
    return value;
}

function looksLikeTime(key, value) {
    if (typeof value !== 'string') return false;
    if (COMPACT_RE.test(value)) return true;
    if (CLOCK_RE.test(value) && /time|trigger|alarm|schedule|at\b/i.test(key)) return true;
    return false;
}

function extract(entity) {
    const times = new Set();
    const recurrences = new Set();
    const skills = new Set();
    const types = new Set();
    const utterances = new Set();

    walk(entity, (key, value) => {
        if (looksLikeTime(key, value)) times.add(prettyTime(value));
        if (typeof value === 'string') {
            if (/recurrence|rrule|cron|byday|freq/i.test(key) && value.length < 200) {
                recurrences.add(value);
            }
            // Any Alexa/skill URN except the automation's own id -- this is how
            // you identify which skill a flagged routine actually invokes.
            if (/^amzn1\.(ask|alexa)\./.test(value) && !/^amzn1\.alexa\.automation\./.test(value)) {
                skills.add(value);
            }
            if (key === '@type' || key === 'type') types.add(value);
            if (/utterance|textToSpeak|^text$|phrase/i.test(key) && value.length < 120) {
                utterances.add(value);
            }
        }
        if (/recurrence|rrule|recurringPattern/i.test(key) && value && typeof value === 'object') {
            recurrences.add(JSON.stringify(value));
        }
    });

    return {
        times: [...times],
        recurrences: [...recurrences],
        skills: [...skills],
        types: [...types],
        utterances: [...utterances]
    };
}

function flagged(entity) {
    return TARGET_RE.test(JSON.stringify(entity));
}

function asList(result, ...keys) {
    if (Array.isArray(result)) return result;
    if (result && typeof result === 'object') {
        for (const key of keys) if (Array.isArray(result[key])) return result[key];
    }
    return [];
}

function field(label, values, indent = '        ') {
    if (!values || values.length === 0) return;
    const [first, ...rest] = values;
    console.log(`${indent}${label.padEnd(11)} ${first}`);
    for (const value of rest) console.log(`${indent}${''.padEnd(11)} ${value}`);
}

function section(title) {
    console.log(`\n${title}`);
    console.log('-'.repeat(Math.max(title.length, 60)));
}

function reportEntity(index, entity, name, id, status) {
    const hit = flagged(entity);
    const marker = hit ? '>>>' : '   ';
    console.log(`${marker} [${index}] ${name || '(unnamed)'}`);
    if (id) console.log(`        id          ${id}`);
    if (status) console.log(`        status      ${status}`);
    const info = extract(entity);
    field('times', info.times);
    field('recurrence', info.recurrences.slice(0, 4));
    field('skills', info.skills);
    field('says', info.utterances.slice(0, 4));
    field('node types', info.types.slice(0, 8));
    return hit;
}

function main() {
    let dump;
    try {
        dump = JSON.parse(fs.readFileSync(DUMP_FILE, 'utf8'));
    } catch (err) {
        if (err.code === 'ENOENT') {
            console.error('No dump.json found. Run: npm run dump');
            process.exit(1);
        }
        throw err;
    }

    console.log(`alexa-probe: summary`);
    console.log(`captured ${dump.capturedAt}  via ${dump.library}`);
    console.log(`flagging anything matching ${TARGET} with >>>`);

    if (dump.errors && Object.keys(dump.errors).length) {
        section('PROBES THAT FAILED');
        for (const [key, info] of Object.entries(dump.errors)) {
            console.log(`  ${key.padEnd(20)} ${info.error}`);
        }
    }

    const probes = dump.probes || {};
    let hits = 0;

    const automations = asList(probes.automations && probes.automations.result, 'automations');
    section(`AUTOMATIONS (${automations.length})`);
    if (automations.length === 0) console.log('  none returned');
    automations.forEach((automation, i) => {
        if (reportEntity(i + 1, automation,
            automation.name,
            automation.automationId || automation.id,
            automation.status)) hits++;
    });

    const notifications = asList(probes.notifications && probes.notifications.result, 'notifications');
    section(`NOTIFICATIONS (${notifications.length})`);
    if (notifications.length === 0) console.log('  none returned');
    notifications.forEach((notification, i) => {
        if (reportEntity(i + 1, notification,
            notification.reminderLabel || notification.type,
            notification.notificationIndex || notification.id,
            notification.status)) hits++;
    });

    const devices = asList(probes.devices && probes.devices.result, 'devices');
    section(`DEVICES (${devices.length})`);
    devices.forEach((device) => {
        const serial = String(device.serialNumber || '');
        const masked = serial.length > 4 ? `...${serial.slice(-4)}` : serial;
        console.log(`    ${String(device.accountName || '?').padEnd(28)} ${String(device.deviceFamily || '').padEnd(14)} ${masked}`);
    });

    const smarthome = asList(probes.smarthomeDevices && probes.smarthomeDevices.result, 'networkDetail', 'locationDetails');
    if (probes.smarthomeDevices) {
        section('SMART HOME');
        console.log(`  ${smarthome.length ? `${smarthome.length} top-level entries` : 'present in dump.json (nested structure, not flattened here)'}`);
    }

    if (probes.household || probes.account) {
        section('HOUSEHOLD PROFILES');
        const household = (probes.household && probes.household.result) || {};
        const members = Array.isArray(household.accounts) ? household.accounts : [];
        const accounts = asList(probes.account && probes.account.result);
        const me = accounts.find((a) => a.signedInUser);

        if (members.length === 0) {
            console.log('  no household members returned');
        }
        members.forEach((member) => {
            const name = member.fullName || member.firstName || '(unnamed)';
            console.log(`    ${String(member.role || '?').padEnd(6)} ${String(member.id || '').padEnd(16)} ${name}`);
        });

        const adults = members.filter((m) => m.role === 'ADULT');
        if (adults.length > 1) {
            console.log('');
            console.log(`  ${adults.length} ADULT profiles. This dump covers ONLY the one you logged in`);
            console.log('  as. Routines owned by the others are absent from the automations');
            console.log('  probe above -- not hidden, absent. If nothing was flagged, they');
            console.log('  are the prime suspects: ask each to open Routines in their own');
            console.log('  Alexa app, or re-run this tool with their Amazon login.');
        }
        if (me) console.log(`\n  signed in as: ${me.firstName || me.name || '?'}`);
    }

    section('VERDICT');
    if (hits > 0) {
        console.log(`  ${hits} entit${hits === 1 ? 'y' : 'ies'} matched ${TARGET}. Read the full JSON for each:`);
        console.log(`    node -e "const d=require('./dump.json');console.log(JSON.stringify(d.probes.automations.result,null,2))" | less`);
        console.log('');
        console.log('  Check each hit\'s owner.id against the profile you logged in as.');
    } else {
        console.log(`  Nothing in THIS profile matched ${TARGET}.`);
        console.log('');
        console.log('  Sanity check first: is DEVICES above non-empty? If devices came');
        console.log('  back empty too, the session is at fault, not the account.');
        console.log('');
        console.log('  If devices listed fine, this profile is genuinely clean. The');
        console.log('  automations endpoint is scoped to the authenticated customer id,');
        console.log('  so a routine owned by another household profile is ABSENT here,');
        console.log('  not hidden. Check HOUSEHOLD above: if it lists another ADULT,');
        console.log('  that profile is the prime suspect and must be dumped separately');
        console.log('  using its own Amazon login.');
    }
    console.log('');
}

main();
