/**
 * Integration Routing Resolver
 *
 * Determines which integration(s) to use based on:
 * - User-selected channels from frontend (runtimeContext.integrations)
 * - LLM-provided integrationId (optional, may be wrong)
 *
 * Routing rules:
 * 1. User selected 1 channel → use it directly, ignore LLM value
 * 2. User selected multiple, LLM specifies one in the list → use that one
 * 3. User selected multiple, LLM doesn't specify → use ALL selected
 * 4. User selected none → error: "please select a channel first"
 * 5. LLM specifies a channel NOT in selected list → error: "please select the correct channel"
 */

export interface SelectedIntegration {
  id: string;
  platform?: string;
  identifier?: string;
  providerIdentifier?: string;
  name?: string;
}

export type ResolveResult =
  | { kind: 'single'; integrationIds: string[] }
  | { kind: 'matched'; integrationIds: string[] }
  | { kind: 'all'; integrationIds: string[] }
  | { kind: 'error'; message: string };

export function resolveIntegrationIds(
  selectedIntegrations: SelectedIntegration[],
  llmIntegrationId: string | undefined,
): ResolveResult {
  // Rule 4: no channels selected
  if (!selectedIntegrations || selectedIntegrations.length === 0) {
    return {
      kind: 'error',
      message: 'No channels selected. Please select a channel from the left panel first.',
    };
  }

  // Rule 1: single channel selected
  if (selectedIntegrations.length === 1) {
    // If LLM didn't specify, or specified the selected one → use it
    if (!llmIntegrationId || llmIntegrationId.trim() === '') {
      return {
        kind: 'single',
        integrationIds: [selectedIntegrations[0].id],
      };
    }

    // LLM specified something — check if it matches the single selected channel
    const lower = llmIntegrationId.toLowerCase();
    const single = selectedIntegrations[0];
    const matches =
      single.id === llmIntegrationId ||
      single.id.toLowerCase() === lower ||
      (single.platform || '').toLowerCase() === lower ||
      (single.identifier || '').toLowerCase() === lower ||
      (single.providerIdentifier || '').toLowerCase() === lower ||
      (single.name || '').toLowerCase() === lower;

    if (matches) {
      return {
        kind: 'single',
        integrationIds: [single.id],
      };
    }

    // LLM specified a different channel not in the selected list
    return {
      kind: 'error',
      message: `The specified channel "${llmIntegrationId}" is not selected. You have selected: ${single.name || single.platform || single.identifier} (id: ${single.id}). Please select the correct channel.`,
    };
  }

  // Multiple channels selected
  if (!llmIntegrationId || llmIntegrationId.trim() === '') {
    // Rule 3: LLM didn't specify → all selected
    return {
      kind: 'all',
      integrationIds: selectedIntegrations.map((si) => si.id),
    };
  }

  // Rule 2 & 5: LLM specified, check if in selected list
  const lower = llmIntegrationId.toLowerCase();
  const match = selectedIntegrations.find(
    (si) =>
      si.id === llmIntegrationId ||
      si.id.toLowerCase() === lower ||
      (si.platform || '').toLowerCase() === lower ||
      (si.identifier || '').toLowerCase() === lower ||
      (si.providerIdentifier || '').toLowerCase() === lower ||
      (si.name || '').toLowerCase() === lower,
  );

  if (match) {
    // Rule 2: matched
    return {
      kind: 'matched',
      integrationIds: [match.id],
    };
  }

  // Rule 5: not in selected list
  const available = selectedIntegrations
    .map((si) => `${si.name || si.platform || si.identifier} (id: ${si.id})`)
    .join(', ');
  return {
    kind: 'error',
    message: `The specified channel "${llmIntegrationId}" is not in your selected channels. Available: ${available}. Please select the correct channel.`,
  };
}
