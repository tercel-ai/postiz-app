import { describe, expect, it } from 'vitest';
import { buildClaimTasksPayload } from '../claim-tasks.payload';

describe('buildClaimTasksPayload', () => {
  it('sets force=true when selected units are present', () => {
    expect(
      buildClaimTasksPayload({
        want: 1,
        selectedUnits: [{ platform: 'x', scanType: 'keyword', scanKey: 'world cup' }],
      })
    ).toEqual({
      want: 1,
      force: true,
      selectedUnits: [{ platform: 'x', scanType: 'keyword', scanKey: 'world cup' }],
    });
  });

  it('omits selected units and force for unselected bootstrap claims', () => {
    expect(buildClaimTasksPayload({ want: 3 })).toEqual({ want: 3 });
  });
});
