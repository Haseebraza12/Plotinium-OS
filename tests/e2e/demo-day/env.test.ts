/**
 * Switches of the Demo Day rehearsal suite (spec §17.1; testing §3.16; C7 for fault injection).
 */
import { describe, expect, it } from 'vitest';

import {
  bringupAllowed,
  demoDay,
  faultNode,
  headless,
  hiddenInstruction,
  hiddenQuery,
  isLocalStack,
  networkLabel,
  plannerAvailable,
  PROPOSED_TID,
  proposedSelectorsAdopted,
  rehearsalLabel,
} from './env.ts';

describe('demo-day switches', () => {
  it('TST-18 the rehearsal suite and its gated parts run only when their switch is exactly 1', () => {
    expect(demoDay({})).toBe(false);
    expect(demoDay({ PLT_DEMO_DAY: 'true' })).toBe(false);
    expect(demoDay({ PLT_DEMO_DAY: '1' })).toBe(true);
    expect(bringupAllowed({ PLT_DEMO_BRINGUP: '1' })).toBe(true);
    expect(bringupAllowed({})).toBe(false);
    expect(plannerAvailable({ PLT_DEMO_AI: '1' })).toBe(true);
    expect(proposedSelectorsAdopted({})).toBe(false);
    expect(headless({})).toBe(false);
    expect(headless({ PLT_DEMO_HEADLESS: '1' })).toBe(true);
  });

  it('DB-02 isLocalStack accepts only loopback hosts, so fault injection never targets production (C7)', () => {
    expect(isLocalStack('http://localhost:4717')).toBe(true);
    expect(isLocalStack('http://127.0.0.1:4718/')).toBe(true);
    expect(isLocalStack('http://[::1]:4717')).toBe(true);
    expect(isLocalStack('https://plotinium.example')).toBe(false);
    expect(isLocalStack('http://192.168.1.20:4717')).toBe(false);
  });

  it('DB-02 faultNode defaults to 500, takes the examiner choice, and rejects a non-positive or fractional node', () => {
    expect(faultNode({})).toBe(500);
    expect(faultNode({ PLT_DEMO_FAULT_NODE: '999' })).toBe(999);
    expect(() => faultNode({ PLT_DEMO_FAULT_NODE: '0' })).toThrow(RangeError);
    expect(() => faultNode({ PLT_DEMO_FAULT_NODE: '1.5' })).toThrow(RangeError);
    expect(() => faultNode({ PLT_DEMO_FAULT_NODE: 'x' })).toThrow(RangeError);
  });

  it('AIS-11 the hidden prompts fall back to the rehearsal defaults and take the examiner-style ones when set', () => {
    expect(hiddenQuery({})).toBe('how does LRU eviction work');
    expect(hiddenQuery({ PLT_DEMO_QUERY: '  where is the memory leak  ' })).toBe(
      'where is the memory leak',
    );
    expect(hiddenInstruction({})).toBeUndefined();
    expect(hiddenInstruction({ PLT_DEMO_INSTRUCTION: ' ' })).toBeUndefined();
    expect(hiddenInstruction({ PLT_DEMO_INSTRUCTION: 'archive my reports' })).toBe(
      'archive my reports',
    );
  });

  it('TST-18 the rehearsal label defaults to the date and the network label to unspecified', () => {
    const d = new Date('2026-12-01T09:00:00Z');
    expect(rehearsalLabel({}, d)).toBe('2026-12-01');
    expect(rehearsalLabel({ PLT_DEMO_REHEARSAL: 'rehearsal-3' }, d)).toBe('rehearsal-3');
    expect(networkLabel({})).toBe('unspecified');
    expect(networkLabel({ PLT_DEMO_NETWORK: '4G hotspot' })).toBe('4G hotspot');
  });

  it('TST-18 every proposed test id is kebab-case and none collides with another', () => {
    const ids = Object.values(PROPOSED_TID);
    for (const id of ids) expect(id).toMatch(/^[a-z]+(?:-[a-z]+)*$/);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
