/**
 * Auto lock timing (FLOWS.md section 11). Pure so it can be unit tested.
 * - Counts from the last click or key press in the popup or full page.
 * - Never waits for a payment (security audit v1): a payment link or Payjoin send in progress
 *   keeps going after Lock with only the keys of its own coins (wallet.ts PjGrant).
 */
export type ActivityState = {
  last: number;
};

export type AutoLockDecision = {
  lock: boolean;
  next: ActivityState;
  /** When it would lock if nothing else happens. */
  dueAt: number;
};

export function autoLockDecision(state: ActivityState, now: number, minutes: number): AutoLockDecision {
  const dueAt = state.last + minutes * 60_000;
  return { lock: now >= dueAt, next: { last: state.last }, dueAt };
}

export function touch(_state: ActivityState | undefined, now: number): ActivityState {
  return { last: now };
}
