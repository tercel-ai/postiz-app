export interface ClaimTaskUnitSelector {
  platform: 'x' | 'reddit';
  scanType: 'keyword' | 'channel' | 'tracked';
  scanKey: string;
}

export function buildClaimTasksPayload(args: {
  want: number;
  selectedUnits?: ClaimTaskUnitSelector[];
}) {
  const selectedUnits = Array.isArray(args.selectedUnits) && args.selectedUnits.length
    ? args.selectedUnits
    : undefined;
  return selectedUnits
    ? { want: args.want, force: true, selectedUnits }
    : { want: args.want };
}
