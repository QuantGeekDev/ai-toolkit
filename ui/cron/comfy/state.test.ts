import { describe, expect, it } from 'vitest';
import { assertComfyTransition, isComfyTerminalState } from './state';

describe('Comfy workspace state machine', () => {
  it('permits the normal lifecycle and terminal release states', () => {
    const states = [
      'requested',
      'preparing_bundle',
      'waiting_for_capacity',
      'provisioning',
      'booting',
      'transferring',
      'validating',
      'ready',
      'busy',
      'terminating',
      'terminated',
    ];
    for (let index = 1; index < states.length; index++) {
      expect(() => assertComfyTransition(states[index - 1], states[index])).not.toThrow();
    }
    expect(isComfyTerminalState('terminated')).toBe(true);
    expect(isComfyTerminalState('terminating')).toBe(false);
  });

  it('rejects unsafe state skipping', () => {
    expect(() => assertComfyTransition('provisioning', 'ready')).toThrow(/Invalid/);
    expect(() => assertComfyTransition('terminating', 'ready')).toThrow(/Invalid/);
  });
});
