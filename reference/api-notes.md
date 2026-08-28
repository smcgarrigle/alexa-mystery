# alexa-remote2 / Amazon private API notes

Verified against `alexa-remote2@8.1.1` and `alexa-cookie2@5.0.6`. Line numbers
refer to those exact versions, which is why `package-lock.json` is committed — a
plain `npm install` reproduces the tree described here. If you `npm update`,
assume every line number below is stale and use `DEBUG=1` to see what the library
actually does.

## Profile scoping — the thing that solves most cases

`GET /api/behaviors/v2/automations` returns only automations owned by the
**authenticated customer id**. Every automation carries:

```json
"owner":    { "@type": "OwnerId", "ownerType": "CUSTOMER", "id": "A1XXXXXXXXXXXX" },
"person":   { "@type": "Person", "id": "amzn1.actor.person.did...." },
"triggers": [ { "payload": { "customer": { "@id": "A1XXXXXXXXXXXX" } } } ]
```

A routine owned by a different Household adult is **not in the response at all**.
It is not filtered by the app — the API never sends it. Since routines can act
on any device in the household, another profile's routine can drive a device you
own, and neither the app nor this API will show it to you.

`GET /api/household` lists the profiles and is the tell:

```
ADULT  A1XXXXXXXXXXXX  <you>
ADULT  A2XXXXXXXXXXXX  <suspect>
```

## Method names and arities

There is **no `getAutomations()`**. Correct names:

| Call | Endpoint |
|---|---|
| `getAutomationRoutines(limit, cb)` | `/api/behaviors/v2/automations?limit=N` |
| `getNotifications(cached, cb)` | `/api/notifications?cached=` |
| `getDevices(cb)` | `/api/devices-v2/device` |
| `getSmarthomeDevices(cb)` | `/api/phoenix` |
| `getHousehold(cb)` | `/api/household` |
| `getAccount(includeActors, cb)` | `/accounts?includeActors=true` |

Arities vary across versions. `lib/client.js` exposes `call(alexa, method, args)`
which spreads `args` before the callback — fix arity errors by editing that
probe's `args` array in `dump.js`, never the helper. For endpoints with no
wrapper, `get(alexa, path)` does a raw read-only GET.

## Empty list returns `{"success": true}`, not `[]`

When there are zero automations the endpoint returns **200 with no body**, and
alexa-remote2 substitutes `{success: true}` (`alexa-remote.js:1243`). This is
not a failure — it means zero results. `summary.js` handles it in `asList()`.

## Auth

No public API, no API key, no token you can issue. The only credential is a real
browser session cookie, obtained through a local MITM login proxy.

### Passkeys do not work — use password + OTP

`alexa-cookie2`'s proxy rewrites every Amazon URL in the served HTML to
`http://127.0.0.1:PORT/...` (`lib/proxy.js:314`, `replaceHosts`). The browser
therefore sees the origin as `127.0.0.1`, not `amazon.com`. WebAuthn binds a
passkey to Relying Party ID `amazon.com`, and the browser refuses when the RP ID
is not a registrable suffix of the current origin:

```
SecurityError: The relying party ID is not a registrable domain suffix of,
nor equal to the current domain.
```

The check is in the browser, so nothing proxy-side can satisfy it. Same for
password-manager passkeys and the cross-device QR flow. Amazon does not let you
remove the account password, so password + OTP remains available — look for
"Sign in with password" / "Try another way" if the page leads with a passkey.
Amazon's sign-in JS may fire a conditional-UI passkey request that fails
silently; ignore it. If it breaks the page, use a private window with password
manager extensions disabled.

### Pasted cookies do not substitute

alexa-remote2 8.x needs the `macDms` JWT, which only comes from the OAuth
`authorization_code` the proxy captures. `init()` re-enters the login flow
whenever `macDms` is missing (`alexa-remote.js:258`), so cookies scraped from a
logged-in tab just loop you back to the proxy. The browser login is required
once, genuinely.

### The double init callback

In `proxyOnly` mode alexa-remote2 passes the init callback straight to
alexa-cookie2, which invokes it **twice**: once immediately with an `Error`
carrying the proxy URL, then again for real after login completes. Both
pre-login call sites (`alexa-cookie.js:376` and `:401`) build the same sentence:

```
Please open http://IP:PORT/ with your browser and login to Amazon.
The cookie will be output here after successfull login.
```

On the `:376` path it is prefixed by a real Amazon login error, so the regex in
`lib/client.js` (`PRE_LOGIN_RE`) is deliberately unanchored. If a future version
reworks that string, that regex is the one line to retighten. Run `DEBUG=1 npm
run dump` and read what the library actually emitted before assuming the auth
flow is broken.

## Region

Defaults to United States. Override all of these together for other regions:

```bash
ALEXA_SERVICE_HOST=layla.amazon.de AMAZON_PAGE=amazon.de \
ACCEPT_LANGUAGE=de-DE AMAZON_PAGE_PROXY_LANGUAGE=de_DE npm run dump
```

`AMAZON_PAGE_PROXY_LANGUAGE` is pinned to `en_US` by default because
alexa-cookie2 otherwise defaults it to `de_DE` and serves a German login page.

## WSL2

The proxy binds inside WSL; open the URL in a **Windows** browser and WSL2
localhost forwarding carries it. If that fails:

```bash
PROXY_IP=$(hostname -I | awk '{print $1}') npm run dump
```

Setting `PROXY_IP` also switches the listen bind from loopback to `0.0.0.0`,
because a routable address is the whole point of the fallback. That means the
Amazon sign-in proxy is reachable by anything on the same network for the
duration of the login. Do not use it on an untrusted network; `PROXY_BIND`
overrides the choice if you need something narrower.

Note this is strictly worse for WebAuthn: `http://127.0.0.1` is a secure context
by the localhost exception, but `http://172.x.x.x` is not, so the API is absent
rather than merely failing.

## Other environment variables

| Variable | Default | Purpose |
|---|---|---|
| `DEBUG=1` | off | Library logging; first thing to try on a hang |
| `PROXY_PORT` | `3456` | Login proxy port |
| `PROXY_IP` | `127.0.0.1` | Address printed in the login URL. Setting it also opens the bind to `0.0.0.0` |
| `PROXY_BIND` | loopback, or `0.0.0.0` if `PROXY_IP` is set | Interface the login proxy listens on |
| `ALEXA_AUTH_FILE` | `./.alexa-auth.json` | Cached session location |
| `ALEXA_DUMP_FILE` | `./dump.json` | Dump output location |
| `MATCH_TIME` | `07:40` | Suspect time (or pass as argv to summary.js) |
