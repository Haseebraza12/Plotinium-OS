// Spike S2 for RFC 0001 (design-gdrive): does the OAuth callback design hold under the QA copy's
// real headers (Caddy: COOP same-origin, COEP require-corp, SameSite=Strict session cookie)?
//
// 1. The OS-like opener (a same-origin document on :4718) opens a popup to a fake "Google" on
//    127.0.0.1:<port> (a different SITE from localhost), which 302-redirects back to a same-origin
//    document on :4718 (a cross-site top-level navigation, like Google's redirect to our callback).
// 2. In the landed document we check: was the Strict cookie sent on that navigation? (we cannot see
//    it directly; instead we check a same-origin fetch from the landed document: GET /api/auth/me
//    must be 200 if the Strict cookie rides along on a same-origin subresource request), and a POST
//    passes the CSRF gate (Sec-Fetch-Site: same-origin): POST /api/telemetry answers 403 EPERM
//    'opt-in' when the CSRF gate passed, 403 EACCES 'csrf' when it did not, 401 with no cookie.
// 3. BroadcastChannel from the landed popup reaches the opener.
// 4. The opener stays crossOriginIsolated; its handle to the popup reports closed.
// Nothing is written: no login, no logout, telemetry is refused before any effect.
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire('/home/haseeb-raza/Desktop/Plotinium OS/package.json');
const { chromium } = require('@playwright/test');

const STATE =
  '/tmp/claude-1000/-home-haseeb-raza-Desktop-Plotinium-OS/6bdb43c3-e62e-4f77-88ef-40bcd9948f85/scratchpad/qa/state-design-gdrive.json';
const BASE = 'http://localhost:4718';
const LANDING = `${BASE}/version.json?code=fake-code&state=fake-state`;

const fake = http.createServer((req, res) => {
  const seenCookie = req.headers.cookie !== undefined;
  res.writeHead(302, { location: LANDING, 'x-saw-cookie': String(seenCookie) });
  res.end();
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const port = fake.address().port;

const browser = await chromium.launch({ channel: 'chrome' });
const context = await browser.newContext({
  storageState: STATE,
  viewport: { width: 1440, height: 900 },
});
const out = {};
const navCookie = [];
context.on('request', (req) => {
  if (req.url().startsWith(`${BASE}/version.json?code=`)) {
    navCookie.push({
      isNavigation: req.isNavigationRequest(),
      headers: req.headers(),
    });
  }
});
const opener = await context.newPage();
// A same-origin document with the real Caddy headers that does not boot the OS.
await opener.goto(`${BASE}/version.json`);
out.openerIsolated = await opener.evaluate(() => self.crossOriginIsolated);
await opener.evaluate(() => {
  window.__bc = [];
  const bc = new BroadcastChannel('plotinium-drive-spike');
  bc.onmessage = (e) => window.__bc.push(e.data);
});
const popupPromise = context.waitForEvent('page');
await opener.evaluate((u) => {
  window.__w = window.open(u, 'plotinium-drive-connect', 'popup,width=520,height=680');
}, `http://127.0.0.1:${port}/o/oauth2/v2/auth`);
const popup = await popupPromise;
await popup.waitForURL(/version\.json\?code=/, { timeout: 15_000 });
await popup.waitForLoadState('load');
out.popupUrl = popup.url();
out.popupIsolated = await popup.evaluate(() => self.crossOriginIsolated);
out.popupHasOpener = await popup.evaluate(() => window.opener !== null);
out.me = await popup.evaluate(async () => {
  const r = await fetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' });
  return r.status;
});
out.csrfPost = await popup.evaluate(async () => {
  const r = await fetch('/api/telemetry', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ events: [] }),
  });
  let body = null;
  try {
    body = await r.json();
  } catch {
    body = null;
  }
  return { status: r.status, errno: body?.errno ?? null, reason: body?.reason ?? null };
});
await popup.evaluate(() => {
  new BroadcastChannel('plotinium-drive-spike').postMessage({ type: 'drive-connected' });
});
await opener.waitForTimeout(300);
out.bcReceived = await opener.evaluate(() => window.__bc);
out.openerHandleClosed = await opener.evaluate(() => window.__w?.closed ?? null);
out.openerStillIsolated = await opener.evaluate(() => self.crossOriginIsolated);
out.landingNavigation = navCookie.map((n) => ({
  isNavigation: n.isNavigation,
  cookieHeaderPresent: 'cookie' in n.headers,
  secFetchSite: n.headers['sec-fetch-site'] ?? null,
}));
// Probe: what does a missing static path under /oauth/ return? (index.html fallback = the OS)
const probe = await context.request.get(`${BASE}/oauth/drive/callback.html`);
out.missingCallbackPath = {
  status: probe.status(),
  isOsShell: (await probe.text()).includes('<title>'),
  coop: probe.headers()['cross-origin-opener-policy'] ?? null,
  csp: (probe.headers()['content-security-policy'] ?? '').slice(0, 80),
};
await popup.evaluate(() => {
  window.close();
});
await opener.waitForTimeout(500);
out.popupClosedByScript = popup.isClosed();
console.log(JSON.stringify(out, null, 2));
await browser.close();
fake.close();
