'use strict';

const fs = require('fs');
const path = require('path');
const AlexaRemote = require('alexa-remote2');

const AUTH_FILE = process.env.ALEXA_AUTH_FILE || path.join(process.cwd(), '.alexa-auth.json');
const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true';

// Region. Defaults to United States. Override all four together if the account
// is registered elsewhere, e.g. layla.amazon.de / amazon.de / de-DE / de_DE.
const REGION = {
    alexaServiceHost: process.env.ALEXA_SERVICE_HOST || 'pitangui.amazon.com',
    amazonPage: process.env.AMAZON_PAGE || 'amazon.com',
    acceptLanguage: process.env.ACCEPT_LANGUAGE || 'en-US',
    // alexa-cookie2 defaults this to de_DE, which renders the login page in
    // German. Not fatal, but confusing. Pin it.
    amazonPageProxyLanguage: process.env.AMAZON_PAGE_PROXY_LANGUAGE || 'en_US'
};

const PROXY_IP = process.env.PROXY_IP || '127.0.0.1';
// Listen on loopback only unless PROXY_IP was explicitly set (the WSL2
// fallback needs a routable address). Binding 0.0.0.0 unconditionally would
// expose a live Amazon sign-in proxy to the whole LAN during the login window.
const PROXY_BIND = process.env.PROXY_BIND ||
    (process.env.PROXY_IP ? '0.0.0.0' : '127.0.0.1');
const PROXY_PORT = Number(process.env.PROXY_PORT || 3456);

/*
 * The double-callback quirk, pinned down.
 *
 * In proxyOnly mode alexa-remote2 passes OUR init callback straight through to
 * alexa-cookie2, which invokes it twice: once immediately with an Error whose
 * only job is to tell you the proxy URL, then again for real once the browser
 * login completes and token registration succeeds.
 *
 * Verified by reading alexa-cookie2 as bundled with alexa-remote2@8.1.1
 * (node_modules/alexa-cookie2/alexa-cookie.js, lines 376 and 401). Both call
 * sites build the identical sentence:
 *
 *   "Please open http://IP:PORT/ with your browser and login to Amazon.
 *    The cookie will be output here after successfull login."
 *
 * On the line-376 path it is prefixed by a real Amazon login error, so the
 * match is deliberately unanchored. If a future version reworks that string,
 * this regex is the single line to retighten -- run with DEBUG=1 and read what
 * the library actually emitted.
 */
const PRE_LOGIN_RE =
    /Please open (https?:\/\/[^\s]+?)\/? with your browser and login to Amazon/i;

function debug(...args) {
    if (DEBUG) console.error('[debug]', ...args);
}

function readAuth() {
    try {
        const raw = fs.readFileSync(AUTH_FILE, 'utf8');
        const data = JSON.parse(raw);
        debug(`loaded cached session from ${AUTH_FILE}`);
        return data;
    } catch (err) {
        if (err.code !== 'ENOENT') {
            console.error(`! ignoring unreadable ${path.basename(AUTH_FILE)}: ${err.message}`);
        }
        return null;
    }
}

// Never logged, never echoed. Refresh token lives in here.
function saveAuth(cookieData) {
    if (!cookieData) return;
    const tmp = `${AUTH_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cookieData), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600); // mode above only applies on create
    fs.renameSync(tmp, AUTH_FILE);
    debug(`session cached to ${path.basename(AUTH_FILE)} (mode 600)`);
}

function printLoginBanner(url) {
    console.log('');
    console.log('  Amazon login required.');
    console.log('');
    console.log(`  Open this in a WINDOWS browser:  ${url}`);
    console.log('');
    console.log('  Sign in with the Amazon account the Echo is registered to.');
    console.log('  The page will say the login is complete; this process picks it');
    console.log('  up automatically and carries on. Nothing is typed in here.');
    console.log('');
    console.log(`  If the page will not load, the proxy is bound inside WSL2 and`);
    console.log(`  localhost forwarding is not working. Re-run as:`);
    console.log(`    PROXY_IP=$(hostname -I | awk '{print $1}') npm run dump`);
    console.log('  and use that IP in the URL instead of 127.0.0.1.');
    console.log('');
    console.log('  Waiting...');
    console.log('');
}

/**
 * Authenticate and hand back a ready AlexaRemote instance.
 * Resolves only once the session is genuinely usable.
 */
function connect() {
    return new Promise((resolve, reject) => {
        const alexa = new AlexaRemote();
        const saved = readAuth();
        let settled = false;

        alexa.on('cookie', () => {
            try {
                saveAuth(alexa.cookieData);
            } catch (err) {
                console.error(`! could not cache session: ${err.message}`);
            }
        });

        const options = Object.assign({
            cookie: saved ? saved.localCookie : undefined,
            formerRegistrationData: saved || undefined,
            proxyOnly: true,
            setupProxy: true,
            proxyOwnIp: PROXY_IP,
            proxyPort: PROXY_PORT,
            proxyListenBind: PROXY_BIND,
            proxyLogLevel: DEBUG ? 'info' : 'warn',
            // One-shot tool: no background refresh timer, no MQTT socket. Both
            // would re-enter this callback later and hold the process open.
            cookieRefreshInterval: 0,
            useWsMqtt: false,
            bluetooth: false,
            logger: DEBUG ? console.log : undefined
        }, REGION);

        debug(`region: ${REGION.alexaServiceHost} / ${REGION.amazonPage} / ${REGION.acceptLanguage}`);
        debug(`proxy: http://${PROXY_IP}:${PROXY_PORT}/ (bind ${PROXY_BIND})`);

        alexa.init(options, (err) => {
            if (err) {
                const message = String((err && err.message) || err);
                const match = message.match(PRE_LOGIN_RE);

                if (match && !settled) {
                    // First of the two callbacks. Not a failure -- keep waiting.
                    debug(`pre-login callback: ${message}`);
                    printLoginBanner(match[1]);
                    return;
                }
                if (settled) {
                    debug(`late callback after settle, ignored: ${message}`);
                    return;
                }
                settled = true;
                debug(`init error did not match PRE_LOGIN_RE: ${message}`);
                return reject(err instanceof Error ? err : new Error(message));
            }

            if (settled) return;
            settled = true;
            resolve(alexa);
        });
    });
}

/**
 * Promise wrapper for alexa-remote2's callback methods.
 * Arities differ across versions, so args are spread ahead of the callback.
 * Fix arity problems by editing a probe's args in dump.js, not this helper.
 */
function call(alexa, method, args = []) {
    return new Promise((resolve, reject) => {
        if (typeof alexa[method] !== 'function') {
            return reject(new Error(`alexa-remote2 has no method ${method}()`));
        }
        let done = false;
        alexa[method](...args, (err, result) => {
            if (done) return;
            done = true;
            if (err) return reject(err instanceof Error ? err : new Error(String(err)));
            resolve(result);
        });
    });
}

/** Raw read-only GET against the private API, for endpoints without a wrapper. */
function get(alexa, apiPath) {
    return new Promise((resolve, reject) => {
        alexa.httpsGet(apiPath, (err, result) => {
            if (err) return reject(err instanceof Error ? err : new Error(String(err)));
            resolve(result);
        });
    });
}

function shutdown(alexa) {
    try {
        if (alexa && typeof alexa.stopProxyServer === 'function') alexa.stopProxyServer();
    } catch (err) { debug(`stopProxyServer: ${err.message}`); }
    try {
        if (alexa && typeof alexa.stop === 'function') alexa.stop();
    } catch (err) { debug(`stop: ${err.message}`); }
}

module.exports = { connect, call, get, shutdown, AUTH_FILE, DEBUG, REGION };
