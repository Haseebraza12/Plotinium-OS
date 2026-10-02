/**
 * KPS-04: the 32-byte SharedArrayBuffer control block layout and its helpers.
 */
import { describe, expect, it } from 'vitest';

import {
  clearFlag,
  createControlBlock,
  CTL,
  CTL_BYTES,
  CTL_FLAG,
  CTL_SLOTS,
  execBeginSlice,
  execEndSlice,
  execYieldPoint,
  hasFlag,
  isControlBlock,
  MAX_STEP_US_SATURATED,
  PREEMPT_KILL,
  PREEMPT_NONE,
  PREEMPT_YIELD,
  preemptionMode,
  readPreempt,
  readRunningPid,
  readSliceSeq,
  setFlag,
  setPreempt,
  snapshotControl,
  wrapControlBlock,
  writeSliceSeq,
} from './control-block.ts';

describe('KPS-04 control block', () => {
  it('KPS-04 the control block is 8 Int32 slots in 32 bytes with the spec indices', () => {
    expect(CTL_BYTES).toBe(32);
    expect(CTL_SLOTS).toBe(8);
    expect(CTL).toEqual({
      PREEMPT: 0,
      RUNNING_PID: 1,
      HEARTBEAT: 2,
      SLICE_SEQ: 3,
      STEPS: 4,
      MAX_STEP_US: 5,
      FLAGS: 6,
      RESERVED: 7,
    });
    expect(CTL_FLAG).toEqual({ DRAINING: 1, CHECKPOINT_WANTED: 2, SUSPECT: 4 });
    const ctl = createControlBlock(true);
    expect(ctl).not.toBeNull();
    expect(ctl?.buffer).toBeInstanceOf(SharedArrayBuffer);
    expect(isControlBlock(ctl)).toBe(true);
    expect(isControlBlock(new Int32Array(4))).toBe(false);
    expect(preemptionMode(ctl)).toBe('sab');
  });

  it('PROC-05 without cross-origin isolation there is no block and pre-emption falls back to messages', () => {
    const ctl = createControlBlock(false);
    expect(ctl).toBeNull();
    expect(preemptionMode(ctl)).toBe('message');
  });

  it('KPS-04 the slice protocol: begin clears PREEMPT, yield points bump HEARTBEAT, end clears RUNNING_PID', () => {
    const ctl = wrapControlBlock(new SharedArrayBuffer(32));
    writeSliceSeq(ctl, 41);
    setPreempt(ctl, 1); // a stale request from the previous slice
    execBeginSlice(ctl, 501);
    expect(readPreempt(ctl)).toBe(PREEMPT_NONE);
    expect(readRunningPid(ctl)).toBe(501);
    expect(readSliceSeq(ctl)).toBe(41);
    expect(execYieldPoint(ctl, 1, 80)).toBe(PREEMPT_NONE);
    setPreempt(ctl, 1);
    expect(execYieldPoint(ctl, 2, 120.4)).toBe(PREEMPT_YIELD);
    setPreempt(ctl, 2);
    setPreempt(ctl, 1); // a yield request never downgrades a pending kill
    expect(execYieldPoint(ctl, 3, 1e12)).toBe(PREEMPT_KILL);
    const snap = snapshotControl(ctl);
    expect(snap).toMatchObject({
      preempt: 2,
      runningPid: 501,
      heartbeat: 3,
      sliceSeq: 41,
      steps: 3,
      maxStepUs: MAX_STEP_US_SATURATED,
    });
    execEndSlice(ctl);
    expect(readRunningPid(ctl)).toBe(0);
    expect(ctl[CTL.RESERVED]).toBe(0);
  });

  it('KPS-04 FLAGS bits are set and cleared independently', () => {
    const ctl = wrapControlBlock(new ArrayBuffer(32));
    setFlag(ctl, CTL_FLAG.DRAINING);
    setFlag(ctl, CTL_FLAG.SUSPECT);
    expect(hasFlag(ctl, CTL_FLAG.DRAINING)).toBe(true);
    expect(hasFlag(ctl, CTL_FLAG.CHECKPOINT_WANTED)).toBe(false);
    clearFlag(ctl, CTL_FLAG.DRAINING);
    expect(hasFlag(ctl, CTL_FLAG.DRAINING)).toBe(false);
    expect(hasFlag(ctl, CTL_FLAG.SUSPECT)).toBe(true);
    expect(() => wrapControlBlock(new ArrayBuffer(16))).toThrow(RangeError);
  });
});
