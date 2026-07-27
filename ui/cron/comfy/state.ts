export const COMFY_TERMINAL_STATES = ['terminated', 'expired', 'failed_confirmed_absent'] as const;
export const COMFY_OPENABLE_STATES = ['ready', 'busy', 'idle_grace'] as const;

export const isComfyTerminalState = (state: string): boolean =>
  (COMFY_TERMINAL_STATES as readonly string[]).includes(state);

const TRANSITIONS: Record<string, readonly string[]> = {
  requested: ['preparing_bundle', 'terminating', 'failed_confirmed_absent'],
  preparing_bundle: ['waiting_for_capacity', 'terminating', 'failed_confirmed_absent'],
  waiting_for_capacity: ['provisioning', 'terminating', 'failed_confirmed_absent'],
  provisioning: ['waiting_for_capacity', 'booting', 'provisioning_unknown', 'terminating', 'failed_confirmed_absent'],
  provisioning_unknown: ['booting', 'terminating', 'failed_confirmed_absent'],
  booting: ['transferring', 'terminating'],
  transferring: ['validating', 'terminating'],
  validating: ['ready', 'busy', 'terminating'],
  ready: ['busy', 'idle_grace', 'syncing_outputs', 'terminating'],
  busy: ['ready', 'idle_grace', 'syncing_outputs', 'terminating'],
  idle_grace: ['ready', 'busy', 'syncing_outputs', 'terminating'],
  syncing_outputs: ['ready', 'busy', 'terminating'],
  terminating: ['terminated', 'expired', 'failed_confirmed_absent'],
};

export const assertComfyTransition = (from: string, to: string): void => {
  if (!(TRANSITIONS[from] || []).includes(to)) throw new Error(`Invalid Comfy workspace transition: ${from} -> ${to}`);
};
