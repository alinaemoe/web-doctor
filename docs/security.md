# Security model of the public server

Local mode (`webdoctor ui`) listens on `127.0.0.1` for one person who may scan anything, including
`localhost`. **Public mode** (`webdoctor serve`) lets strangers ask a server to open web pages for
them. That is the textbook shape of an SSRF problem, so this document says what the server defends
against, how, and what it does not cover.

## What an attacker wants

1. Make the server request **private addresses**: `127.0.0.1`, the cloud metadata service
   (`169.254.169.254`), the Docker network, the VPS provider's internal network, the operator's LAN.
2. Make the server's **browser** do the same from inside a page (images, scripts, `fetch`, iframes,
   redirects, WebSockets).
3. Use the server as a **launchpad**: port scans, hitting non-web services, DoS against third parties.
4. Read or damage **other visitors' results**.
5. **Exhaust** the machine: huge scans, many scans, giant pages, endless downloads.

## Defences

### 1. One policy for every connection (`packages/netguard`)

- Only `http:` and `https:`; no credentials in the address; only ports 80, 443, 8080, 8443.
- Host names that can only mean an internal network (`localhost`, `*.local`, `*.internal`,
  `*.lan`, `*.home.arpa`, single-label names such as `intranet`) are refused without asking DNS.
- **Every** address a name resolves to must be public unicast. One private answer among public
  ones refuses the whole name (round-robin tricks).
- The blocklist covers loopback, RFC 1918, link-local (including metadata), CGNAT, documentation,
  benchmarking, multicast, reserved ranges, and the IPv6 equivalents. IPv4 hidden inside IPv6
  (`::ffff:a.b.c.d`, NAT64 `64:ff9b::/96`, 6to4, Teredo) is judged by the embedded address.
  Anything that cannot be parsed counts as private.
- IP literals are judged after the URL parser normalised them, so `http://2130706433/`,
  `http://0x7f.1/`, `http://[::ffff:7f00:1]/` are all caught as loopback.

### 2. DNS rebinding: resolve once, connect to what was checked

The policy resolves the name, checks all answers, and the connection is opened **to that checked
address**. Nothing resolves the name a second time between check and connect. The guarded `fetch`
does this inside undici's `connect.lookup`; the browser proxy does it before it dials.

### 3. The browser cannot go around the proxy

Chromium is started with `--proxy-server=<guard proxy>` plus:

- `--proxy-bypass-list=<-loopback>`: loopback is sent through the proxy too (and refused there),
  instead of being reached directly;
- `--host-resolver-rules="MAP * ~NOTFOUND , EXCLUDE 127.0.0.1"`: the browser's own DNS finds
  nothing, so only the proxy decides where a connection goes;
- `--disable-quic`, `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`,
  `--disable-background-networking`: no side channels (UDP, WebRTC, prefetch).

Every request of the page (document, subresources, redirects, `fetch`/XHR, WebSockets via `CONNECT`)
passes through the same policy. A page that embeds `http://127.0.0.1:PORT/…` simply gets a refused
connection; the target is never contacted. `apps/cli/test/ssrf.e2e.test.ts` proves this with a real
Chromium against a hostile page and a server that counts requests. The same test runs the scan
**without** the guard as a control, to show the attack is real.

### 4. Redirects are followed by us, hop by hop

`linkCheck`, `robots.txt` and sitemap fetching use manual redirect handling, so a public URL that
redirects to `http://169.254.169.254/` is refused at that hop.

### 5. Links to forbidden places are "could not check", not a finding

A link pointing at a blocked address is reported as **unverified (blocked)**, never "broken".
Re-verification applies the same guard (`verifyAndSave` gets a guard per request).

### 6. Visitors are isolated

- Anonymous sessions: `POST /api/session` returns `id.HMAC(secret,id)`. Nothing is stored for the
  session; a forged or altered token fails the signature.
- Runs are stored under `owner = sha256(id)`. Every run, screenshot, fix prompt, verification and
  scan job is checked against the owner and answers **404** (not 403) for anyone else, so existence
  does not leak. Runs made in local mode (no owner) are invisible in public mode.
- The comparison history ("fixed", "regression") is built only from the same owner's runs.
- Screenshot paths are validated: only `runs/<id>/screenshots/*` with an image extension.

### 7. Limits (defaults, all configurable)

| Limit                          | Default                          |
| ------------------------------ | -------------------------------- |
| Pages per scan / depth         | 20 / 2 (server clamps)           |
| robots.txt                     | always respected                 |
| Scan time budget               | 5 minutes                        |
| Bytes the scan's browser loads | 250 MB (proxy cuts the transfer) |
| External links checked         | 30                               |
| Concurrent scans per visitor   | 1                                |
| Scans per visitor / day        | 10                               |
| Scans per IP / hour            | 15                               |
| Re-verifications per visitor/h | 60                               |
| Sessions per IP / hour         | 30                               |
| API requests per IP / minute   | 900                              |
| Waiting scans (all visitors)   | 5                                |
| Request body                   | 16 KB                            |
| Retention                      | runs deleted after 24 h          |

Browser work is serialised (one scan at a time), so the load is bounded by design.

### 8. The operator's own demo

`--demo` starts Broken Shop on loopback inside the process and adds its two exact origins to
`allowOrigins`. The exception matches scheme + host + port exactly; everything else on loopback
stays blocked.

### 9. The container

`docker-compose.yml` runs as a non-root user with `cap_drop: ALL`, `no-new-privileges`, a read-only
root filesystem, a size-limited `/tmp`, memory/CPU/pid limits, and one volume for the database.
Playwright disables Chromium's sandbox by default; set `WEBDOCTOR_CHROMIUM_SANDBOX=1` on hosts that
allow user namespaces to turn it on.

## What this does **not** protect against

- **Host-level egress is the real backstop.** Application checks have bugs. `docs/deploy.md`
  contains firewall rules that drop traffic from the container to private ranges and metadata, so
  that a bug in the guard cannot become an incident.
- **Scanning sites you do not own.** The server fetches pages like any browser; each visitor is
  told to scan only sites they have permission to test. Rate limits keep it from becoming a load
  tool, but the operator remains responsible for abuse reports (the user agent identifies the
  tool).
- **A Chromium exploit.** Rendering hostile pages is the risk profile of any screenshot service.
  Mitigations: container hardening, no secrets in the container, nothing else on the host network
  it could reach, keeping Playwright up to date.
- **Distributed abuse.** Per-IP limits are in memory and per process; a botnet is not stopped.
  Put the server behind a reverse proxy with its own rate limiting if it gets attention.
- **TLS to the visitor** is the reverse proxy's job; the app does not terminate TLS.
- **Accounts and billing** do not exist; sessions are anonymous and lose access when the browser
  storage is cleared (the results are deleted after 24 h anyway).

## Reporting a vulnerability

Open a private security advisory on the repository, or email the maintainer.
