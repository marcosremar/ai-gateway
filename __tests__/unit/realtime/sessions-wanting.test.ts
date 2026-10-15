import { beforeEach, describe, expect, it } from 'vitest';
import { _resetExternalLoad, noteRefusedSession, reportExternalLoad, sessionsWanting, WANTING_WINDOW_MS } from '../../../src/realtime/external-load';

describe('sessionsWanting', () => {
  beforeEach(() => _resetExternalLoad());

  it('is not available for a deployment with no realtime report and no refusal', () => {
    expect(sessionsWanting('dep', 1_000)).toBeNull();
  });

  it('adds seated sessions and learners refused recently', () => {
    reportExternalLoad('dep', 'r1', 8, 8, 1_000);
    noteRefusedSession('dep', 'a', 1_000);
    noteRefusedSession('dep', 'b', 1_000);
    noteRefusedSession('dep', 'a', 2_000);
    expect(sessionsWanting('dep', 2_000)).toBe(10);
  });

  it('forgets a refusal after the window', () => {
    reportExternalLoad('dep', 'r1', 8, 8, 1_000);
    noteRefusedSession('dep', 'a', 1_000);
    reportExternalLoad('dep', 'r1', 8, 8, 1_000 + WANTING_WINDOW_MS);
    expect(sessionsWanting('dep', 1_001 + WANTING_WINDOW_MS)).toBe(8);
  });
});
