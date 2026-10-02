import { describe, expect, it } from 'vitest';

import { budget } from '../budgets.ts';
import type { Envelope } from '../envelope.ts';
import { validatePerfResult } from '../result.ts';

import { bootResult, bootRunSummary, bootTimes, countResult, largeAssetRequests } from './runs.ts';

const env: Envelope = {
  commit: 'a1f93c2',
  build: '0.3.0+a1f93c2',
  machine: { class: 'lab-spec', cpu: 'Intel Core i5-12500', hwc: 12, ramGiB: 16, os: 'linux 6.8' },
  chrome: { version: '153.0.7310.12', channel: 'stable' },
};
const timing = { startedAt: '2026-10-20T21:30:00Z', durationMs: 60_000 };

describe('BOOT-10 boot harness', () => {
  it('BOOT-10 the boot budget value is the nearest-rank p95 of 20 runs, the 19th value', () => {
    const times = Array.from({ length: 20 }, (_, i) => 500 + 10 * i);
    const r = bootResult(budget('BOOT-10.warm'), times, env, timing);
    expect(r.value).toBe(680);
    expect(r.runs[0]).toMatchObject({ n: 20, max: 690, valid: true });
    expect(validatePerfResult(r, 'boot-harness')).toEqual([]);
    expect(bootRunSummary([700]).p95).toBe(700);
  });

  it('BOOT-10 no model, ort, transformers, xterm, CodeMirror or app view request may start before the mark', () => {
    const entries = [
      { name: 'http://localhost:4717/assets/kernel-1a2b.js', startTime: 20 },
      { name: 'http://localhost:4717/assets/xterm-9f.js', startTime: 800 },
      { name: 'http://localhost:4717/models/minilm/model.onnx', startTime: 400 },
      { name: 'http://localhost:4717/ort/1.23/ort-wasm.wasm', startTime: 1200 },
      { name: 'http://localhost:4717/assets/view-editor-77.js', startTime: 300 },
      { name: 'http://localhost:4717/assets/desktop-shell-1c.js', startTime: 100 },
    ];
    expect(largeAssetRequests(entries, 731)).toEqual([
      'http://localhost:4717/models/minilm/model.onnx',
      'http://localhost:4717/assets/view-editor-77.js',
    ]);
    const r = countResult(budget('BOOT-10.no-large-assets'), 2, 20, env, timing, {
      offenders: ['a', 'b'],
    });
    expect(r.value).toBe(2);
    expect(validatePerfResult(r, 'resource-timing')).toEqual([]);
  });

  it('BOOT-10 a boot of the wrong kind or one that never became interactive fails the setup', () => {
    expect(bootTimes([{ kind: 'warm', bootMs: 700, userWaitMs: 0 }], 'warm')).toEqual([700]);
    expect(() => bootTimes([{ kind: 'cold', bootMs: 900, userWaitMs: 0 }], 'warm')).toThrow(
      /were cold, expected warm/,
    );
    expect(() => bootTimes([{ kind: 'warm', bootMs: null, userWaitMs: 0 }], 'warm')).toThrow(
      /never reached/,
    );
  });
});
