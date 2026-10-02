/* global __ENV, __VU */
/**
 * k6 WebSocket and lock soak (testing-and-performance.md §3.11.2 k6 row; budgets VFS-09.lock-grant,
 * SRV-01.ws-idle, SRV-01.event-loop). SKELETON: runs on the lab-spec runner only, against the
 * local Compose stack, never from a pull request (TST-07).
 *
 *   k6 run -e BASE_URL=http://localhost:4717 -e USERS=50 -e PASSWORD=... tests/performance/k6/ws-soak.js
 *
 * Every virtual user logs in over HTTP (cookie session), opens /ws, sends `hello`, then loops:
 * acquire an X lease on the shared file, hold it for HOLD_MS with heartbeats, release it. The
 * `lock_grant_ms` Trend is the time from `lock.acquire` to `lock.granted`. A threshold breach
 * makes k6 exit 99, which the workflow maps to a failed budget. handleSummary writes the raw k6
 * summary; tests/performance/k6/to-result.ts turns it into the VFS-09.lock-grant result file that
 * check-budgets reads.
 *
 * TODO(R5): fill SHARED_INO from the demo seed (the ino of /home/shared/plan.md) and the build
 * identity from /version.json once the server's /ws lands; the frames follow protocol/src/ws.
 */
import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { WebSocket } from 'k6/websockets';

const BASE = __ENV.BASE_URL || 'http://localhost:4717';
const USERS = Number(__ENV.USERS || 50);
const HOLD_MS = Number(__ENV.HOLD_MS || 200);
const SHARED_INO = __ENV.SHARED_INO || '';

// Thresholds mirror budgets.json (VFS-09.lock-grant: p95 <= 50 ms; SRV-01.event-loop is read from
// the server's /metrics by the workflow, not here).
export const options = {
  scenarios: {
    soak: { executor: 'constant-vus', vus: USERS, duration: __ENV.DURATION || '5m' },
  },
  thresholds: {
    lock_grant_ms: ['p(95)<50'],
    ws_protocol_errors: ['count==0'],
  },
};

const lockGrant = new Trend('lock_grant_ms', true);
const protocolErrors = new Counter('ws_protocol_errors');

function uuidv7() {
  const ms = Date.now().toString(16).padStart(12, '0');
  const rnd = () => Math.floor(Math.random() * 16).toString(16);
  const r = (n) => Array.from({ length: n }, rnd).join('');
  return `${ms.slice(0, 8)}-${ms.slice(8, 12)}-7${r(3)}-${'89ab'[Math.floor(Math.random() * 4)]}${r(3)}-${r(12)}`;
}

export function setup() {
  const version = http.get(`${BASE}/version.json`).json();
  return {
    build: {
      name: 'Plotinium',
      version: version.version,
      build: version.build,
      date: version.date,
    },
  };
}

export default function soak(data) {
  const username = `soak${String(__VU).padStart(3, '0')}`;
  const login = http.post(
    `${BASE}/api/auth/login`,
    JSON.stringify({ username, password: __ENV.PASSWORD || '' }),
    {
      headers: { 'content-type': 'application/json' },
    },
  );
  if (!check(login, { 'logged in': (r) => r.status === 200 })) return;

  const url = `${BASE.replace(/^http/, 'ws')}/ws`;
  const ws = new WebSocket(url, null, {
    headers: { cookie: login.headers['Set-Cookie'] || '', origin: BASE },
  });
  let frameId = 0;
  let sentAt = 0;
  const send = (t, body) => ws.send(JSON.stringify({ v: 1, t, id: ++frameId, body }));

  ws.onopen = () => {
    send('hello', {
      proto: 1,
      build: data.build,
      osSessionId: uuidv7(),
      deviceId: uuidv7(),
      kernelEpoch: 1,
      lamport: 0,
      outbox: { pending: 0, held: 0 },
      heldLeases: [],
      resume: [],
    });
  };
  ws.onmessage = (event) => {
    const frame = JSON.parse(event.data);
    if (frame.t === 'hello.ok') {
      sentAt = Date.now();
      send('lock.acquire', {
        reqId: uuidv7(),
        ino: SHARED_INO,
        mode: 'X',
        wait: true,
        timeoutMs: 30000,
        principal: frame.body.auth.uid,
      });
    } else if (frame.t === 'lock.granted') {
      lockGrant.add(Date.now() - sentAt);
      const lease = { leaseId: frame.body.leaseId, ino: frame.body.ino, fence: frame.body.fence };
      setTimeout(() => {
        send('hb', { t: Date.now(), leases: [lease], lamport: 0 });
        send('lock.release', { leaseId: lease.leaseId });
        ws.close();
      }, HOLD_MS);
    } else if (frame.t === 'error' || frame.t === 'lock.denied') {
      protocolErrors.add(1);
      ws.close();
    }
  };
}

export function handleSummary(summary) {
  const grant = summary.metrics.lock_grant_ms;
  return {
    stdout: JSON.stringify({ lockGrantP95: grant ? grant.values['p(95)'] : null }, null, 2),
    'test-results/perf/k6-summary.json': JSON.stringify(summary, null, 2),
  };
}
