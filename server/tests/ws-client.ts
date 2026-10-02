/**
 * A small WebSocket protocol v1 client for server tests and the deploy smoke check
 * (offline-and-sync.md §4.1-§4.4). It speaks to a real /ws over the `ws` package, so the Origin
 * and Cookie headers can be set (a browser sets them itself), and it parses EVERY server frame
 * with the protocol's own `S2CFrame` schema: a frame the server sends that the client could not
 * decode fails the test at once.
 *
 *   const c = await WsTestClient.connect(`ws://127.0.0.1:${port}/ws`, { origin, cookie });
 *   c.send('hello', {...});
 *   const ok = await c.next('hello.ok');
 */
import WebSocket from 'ws';
import * as v from 'valibot';

import { S2CFrame, type C2S_BODIES, type C2SType, type S2CType } from '@plotinium/protocol';

export type ServerFrame<T extends S2CType = S2CType> = S2CFrame<T>;

/** An upgrade the server refused before it became a WebSocket (backend-api.md §3.7). */
export class UpgradeRefused extends Error {
  readonly statusCode: number;
  readonly body: string;
  constructor(statusCode: number, body: string) {
    super(`upgrade refused with ${statusCode}: ${body}`);
    this.name = 'UpgradeRefused';
    this.statusCode = statusCode;
    this.body = body;
  }
}

interface Waiter {
  readonly match: (f: ServerFrame) => boolean;
  readonly resolve: (f: ServerFrame) => void;
  readonly reject: (e: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface Closed {
  readonly code: number;
  readonly reason: string;
}

const DEFAULT_TIMEOUT_MS = 5_000;

export class WsTestClient {
  readonly #socket: WebSocket;
  readonly #buffer: ServerFrame[] = [];
  readonly #waiters: Waiter[] = [];
  #nextId = 1;
  /** Frames that failed the S2CFrame schema (should stay empty). */
  readonly invalid: string[] = [];
  readonly closed: Promise<Closed>;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        this.invalid.push('<binary>');
        return;
      }
      const text = Buffer.isBuffer(data)
        ? data.toString('utf8')
        : Array.isArray(data)
          ? Buffer.concat(data).toString('utf8')
          : Buffer.from(data).toString('utf8');
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        this.invalid.push(text);
        return;
      }
      const parsed = v.safeParse(S2CFrame, json);
      if (!parsed.success) {
        this.invalid.push(text);
        return;
      }
      this.#deliver(parsed.output as ServerFrame);
    });
    this.closed = new Promise((resolve) => {
      socket.on('close', (code, reason) => {
        const err = new Error(`socket closed ${code} ${reason.toString('utf8')}`);
        for (const w of this.#waiters.splice(0)) {
          clearTimeout(w.timer);
          w.reject(err);
        }
        resolve({ code, reason: reason.toString('utf8') });
      });
    });
  }

  /** Opens the socket; rejects with UpgradeRefused when the server answers the upgrade with HTTP. */
  static connect(url: string, headers: Readonly<Record<string, string>>): Promise<WsTestClient> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { headers: { ...headers } });
      socket.once('unexpected-response', (_req, res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          reject(new UpgradeRefused(res.statusCode ?? 0, Buffer.concat(chunks).toString('utf8')));
          socket.terminate();
        });
      });
      socket.once('error', (e) => reject(e));
      // Listeners are attached synchronously, so no frame can be missed after 'open'.
      const client = new WsTestClient(socket);
      socket.once('open', () => resolve(client));
    });
  }

  get readyState(): number {
    return this.#socket.readyState;
  }

  /** Sends `{v: 1, t, id, body}` and returns the frame id. */
  send<T extends C2SType>(t: T, body: v.InferInput<(typeof C2S_BODIES)[T]>): number {
    const id = this.#nextId++;
    this.#socket.send(JSON.stringify({ v: 1, t, id, body }));
    return id;
  }

  /** Sends raw text (protocol-error tests). */
  sendRaw(text: string): void {
    this.#socket.send(text);
  }

  /** The first not yet consumed frame of type `t` (matching `pred`), waiting up to `timeoutMs`. */
  next<T extends S2CType>(
    t: T,
    pred: (body: ServerFrame<T>['body']) => boolean = () => true,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<ServerFrame<T>> {
    const match = (f: ServerFrame): boolean => f.t === t && pred((f as ServerFrame<T>).body);
    const i = this.#buffer.findIndex(match);
    if (i >= 0) {
      const [f] = this.#buffer.splice(i, 1);
      return Promise.resolve(f as ServerFrame<T>);
    }
    return new Promise<ServerFrame<T>>((resolve, reject) => {
      const timer = setTimeout(() => {
        const at = this.#waiters.findIndex((w) => w.timer === timer);
        if (at >= 0) this.#waiters.splice(at, 1);
        const seen = this.#buffer.map((f) => f.t).join(', ');
        reject(new Error(`no ${t} frame within ${timeoutMs} ms (buffered: ${seen || 'none'})`));
      }, timeoutMs);
      this.#waiters.push({
        match,
        resolve: (f) => resolve(f as ServerFrame<T>),
        reject,
        timer,
      });
    });
  }

  /** Frames received and not consumed by next(), in arrival order. */
  pending(): readonly ServerFrame[] {
    return [...this.#buffer];
  }

  close(code = 1000, reason = ''): void {
    this.#socket.close(code, reason);
  }

  terminate(): void {
    this.#socket.terminate();
  }

  #deliver(f: ServerFrame): void {
    const i = this.#waiters.findIndex((w) => w.match(f));
    if (i < 0) {
      this.#buffer.push(f);
      return;
    }
    const [w] = this.#waiters.splice(i, 1);
    if (w === undefined) return;
    clearTimeout(w.timer);
    w.resolve(f);
  }
}
