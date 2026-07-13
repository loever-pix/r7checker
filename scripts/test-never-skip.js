'use strict';
const assert = require('assert');
const { drainSlowLane, TRANSIENT } = require('../lib/checker/neverSkip');

assert(TRANSIENT.has('network') && TRANSIENT.has('retry') && !TRANSIENT.has('invalid'), 'transient set');

(async () => {
  const sleep = async () => {};                 // no real waiting in tests

  // Case 1: an account that fails (network) twice then succeeds is RECORDED as
  // success, never as an error.
  {
    const tries = {};
    const recorded = [];
    const deferred = [{ id: 'a' }, { id: 'b' }];
    const attempt = async (item) => {
      tries[item.id] = (tries[item.id] || 0) + 1;
      return tries[item.id] >= 3 ? { outcome: 'success', playerData: { u: item.id } } : { outcome: 'network' };
    };
    const record = (item, outcome, pd) => recorded.push({ id: item.id, outcome, pd });
    const res = await drainSlowLane(deferred, { attempt, record, sleep }, { rounds: 5, delayMs: 0 });
    assert.strictEqual(recorded.length, 2, 'both eventually recorded');
    assert(recorded.every(r => r.outcome === 'success'), 'recorded as success not error');
    assert.strictEqual(res.terminal, 0, 'no terminal errors');
  }

  // Case 2: an account that ALWAYS fails is NOT recorded as an error by default —
  // it's left unresolved (→ the job's "unchecked" set) so results stay error-free.
  {
    const recorded = [];
    const attempt = async () => ({ outcome: 'retry' });
    const record = (item, outcome) => recorded.push({ id: item.id, outcome });
    const res = await drainSlowLane([{ id: 'x' }], { attempt, record, sleep }, { rounds: 3, delayMs: 0 });
    assert.strictEqual(recorded.length, 0, 'survivor NOT recorded (no error line)');
    assert.strictEqual(res.terminal, 0, 'no terminal errors written');
    assert.strictEqual(res.unresolved, 1, 'one left unresolved for resume');
  }

  // Case 2b: opting in to recordTerminalAs restores writing a terminal outcome.
  {
    const recorded = [];
    const attempt = async () => ({ outcome: 'retry' });
    const record = (item, outcome) => recorded.push({ id: item.id, outcome });
    const res = await drainSlowLane([{ id: 'y' }], { attempt, record, sleep }, { rounds: 2, delayMs: 0, recordTerminalAs: 'network' });
    assert.strictEqual(recorded.length, 1, 'recorded once when opted in');
    assert.strictEqual(recorded[0].outcome, 'network', 'terminal network');
    assert.strictEqual(res.terminal, 1, 'one terminal');
  }

  // Case 2c: when acquire/release are supplied, EVERY attempt goes through the
  // governor gate (fast lane and slow lane obey the same adaptive limit).
  {
    let acq = 0, rel = 0, inFlight = 0, peak = 0, attempts = 0;
    const deferred = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
    const acquire = async () => { acq++; inFlight++; peak = Math.max(peak, inFlight); };
    const release = () => { rel++; inFlight--; };
    const attempt = async () => { attempts++; await new Promise(r => setTimeout(r, 2)); return { outcome: 'success' }; };
    const res = await drainSlowLane(deferred, {
      attempt, record: () => {}, sleep, aborted: () => false,
      concurrency: 2, acquire, release,
    }, { rounds: 2, delayMs: 0 });
    assert.strictEqual(acq, attempts, 'acquire called once per attempt');
    assert.strictEqual(rel, attempts, 'release called once per attempt (finally)');
    assert.strictEqual(inFlight, 0, 'all slots released');
    assert.strictEqual(res.unresolved, 0, 'all resolved');
  }

  // Case 3: abort stops the drain and stops recording.
  {
    const recorded = [];
    let calls = 0;
    const attempt = async () => ({ outcome: 'network' });
    const record = (item, o) => recorded.push(o);
    const aborted = () => (++calls > 1);         // abort after first check
    await drainSlowLane([{ id: 'q' }, { id: 'r' }], { attempt, record, sleep, aborted }, { rounds: 5, delayMs: 0 });
    assert(recorded.length === 0, 'nothing terminal-recorded once aborted');
  }

  console.log('OK test-never-skip');
})().catch(e => { console.error(e); process.exit(1); });
