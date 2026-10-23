/**
 * Auto lock timing (FLOWS.md section 11). Pure so it can be unit tested.
 * - Counts from the last click or key press in the popup or full page.
 * - Never locks while a payment link or Payjoin send is waiting, because locking deletes its keys.
 * - After the payment ends, the timer counts from the end.
 */
export type ActivityState = {
  last: number;
  waitingSince?: number;
  waitEndedAt?: number;
};

export type AutoLockDecision = {
  lock: boolean;
  next: ActivityState;
  /** When it would lock if nothing else happens. Undefined while waiting. */
  dueAt?: number;
  /** When it would have locked if no payment was waiting. */
  wouldHaveLockedAt?: number;
};

export function autoLockDecision(
  state: ActivityState,
  now: number,
  minutes: number,
  waiting: boolean,
): AutoLockDecision {
  const span = minutes * 60_000;
  if (waiting) {
    const next: ActivityState = { last: state.last, waitingSince: state.waitingSince ?? now };
    return { lock: false, next, wouldHaveLockedAt: state.last + span };
  }
  const next: ActivityState = { last: state.last };
  let ended = state.waitEndedAt;
  if (state.waitingSince !== undefined) ended = now;
  if (ended !== undefined) next.waitEndedAt = ended;
  const base = Math.max(state.last, ended ?? 0);
  const dueAt = base + span;
  return { lock: now >= dueAt, next, dueAt };
}

export function touch(state: ActivityState | undefined, now: number): ActivityState {
  return { ...(state ?? {}), last: now };
}
