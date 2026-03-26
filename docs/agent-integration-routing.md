# Agent Integration Routing

## Overview

When a user interacts with the Postiz chat agent to schedule posts, the system needs to determine **which channel(s)** to send the post to. This document describes the routing logic that bridges the frontend channel selection with the backend tool execution.

**Design Principle:** Routing decisions are made in code (deterministic), not by the LLM (probabilistic). The LLM's `integrationId` is treated as a hint — the resolver validates it against the user's actual selection and provides clear errors when mismatched.

## Data Flow

```
Frontend (left panel)          Backend (copilot controller)         Agent Tools
┌──────────────────┐          ┌─────────────────────────┐         ┌──────────────────────┐
│ User selects      │          │ runtimeContext.set(      │         │ resolveIntegrationIds│
│ channels in UI    │─────────▶│   'integrations',       │────────▶│ (selectedIntegrations,│
│                   │          │   properties.integrations│         │  llmIntegrationId)   │
└──────────────────┘          │ )                        │         └──────────────────────┘
                               └─────────────────────────┘
```

### Step by Step

1. **Frontend**: User clicks channels in the left sidebar (`AgentList` component in `agent.tsx`). Selected channels (full Prisma `Integration` objects) are stored in `PropertiesContext`.

2. **CopilotKit**: The `CopilotKit` component sends `properties.integrations` (the full Integration objects) with every request (`agent.chat.tsx` line 50-52).

3. **Frontend Message Context**: `NewInput` component also appends a simplified version to each user message as hidden text (`[--integrations--]`), mapping `identifier` → `platform`. This is for the LLM to read in conversation context only — it does NOT drive routing.

4. **Backend**: `copilot.controller.ts` extracts `properties.integrations` and stores it in `runtimeContext` (line 128-131). The data retains all Prisma fields including `id`, `identifier`, `name`, `providerIdentifier`.

5. **Tools**: `schedulePostTool` and `triggerTool` read `runtimeContext.get('integrations')` and call `resolveIntegrationIds()` to determine which channel(s) to operate on.

### Data Shape Through the Chain

| Layer | Source | Key Fields Available |
|-------|--------|---------------------|
| Frontend `PropertiesContext` | Prisma `Integration` | `id`, `identifier`, `name`, `providerIdentifier`, `picture`, ... |
| CopilotKit `properties.integrations` | Same objects | `id`, `identifier`, `name`, `providerIdentifier`, `picture`, ... |
| `runtimeContext.get('integrations')` | From request body | `id`, `identifier`, `name`, `providerIdentifier`, `picture`, ... |
| `[--integrations--]` in message text | Mapped by `NewInput` | `id`, `platform` (= `identifier`), `profilePicture`, `additionalSettings` |

**Note:** The `platform` field only exists in the message text context. The `runtimeContext` data has `identifier` instead. The resolver checks both fields to handle either source.

## Routing Rules

| # | Condition | Action | Example |
|---|-----------|--------|---------|
| **1a** | Selected **1 channel**, LLM didn't specify or specified one that **matches** | Use the selected channel directly | User selects "aipartnerup-team (X)", says "send it" → goes to X |
| **1b** | Selected **1 channel**, LLM specified a **different** channel | **Error**: "The specified channel is not selected" | User selects X, says "post to Facebook" → error, Facebook not selected |
| **2** | Selected **multiple**, LLM specifies one **in the list** | Use the specified one | User selects X + LinkedIn, says "post to X" → only X |
| **3** | Selected **multiple**, LLM **doesn't specify** | Post to **ALL** selected channels | User selects X + LinkedIn, says "post this" → both get the post |
| **4** | Selected **none** | **Error**: "Please select a channel first" | User starts chatting without selecting any channel |
| **5** | Selected **multiple**, LLM specifies one **NOT in the list** | **Error**: "Please select the correct channel" | User selects X + LinkedIn, LLM passes "facebook" → error with available list |

## Matching Logic (Rules 1a/1b, 2, 5)

When the LLM provides an `integrationId`, the resolver matches against selected integrations in this priority:

1. **Exact ID match** — `si.id === llmIntegrationId`
2. **ID match** (case-insensitive) — `si.id.toLowerCase() === lower`
3. **Platform match** (case-insensitive) — `si.platform === lower` (from message context)
4. **Identifier match** (case-insensitive) — `si.identifier === lower` (from Prisma, e.g., "x")
5. **Provider identifier match** (case-insensitive) — `si.providerIdentifier === lower`
6. **Name match** (case-insensitive) — `si.name === lower` (e.g., "aipartnerup-team")

If any level matches → use that channel (Rule 1a or 2).
If none match → error (Rule 1b or 5).

This means the LLM can pass any of these values and the resolver will find the right channel:
- Exact ID: `"cmn2mcbn40002qmiwi2b9v1h0"` ✅
- Platform: `"x"` ✅
- Account name: `"aipartnerup-team"` ✅
- Wrong value: `"facebook"` → error ✅

## Tool-Specific Behavior

### schedulePostTool

- `integrationId` is **optional** in the input schema.
- When omitted with 1 channel selected → auto-resolved to that channel.
- When omitted with multiple channels selected (Rule 3) → the post is **expanded** to all selected channels. One DB post is created per channel.
- Each expanded post goes through independent validation (settings DTO, character limits) per platform.
- If a tool error occurs (e.g., character limit exceeded), it returns the error for the LLM to auto-retry with corrected content.

### triggerTool

- `integrationId` is **optional** in the input schema.
- Single channel → auto-resolved, same as schedulePostTool.
- Multiple channels without specification → returns error asking the LLM to specify which channel (triggers are per-channel operations, "all" doesn't apply).

### integrationSchema

- No changes. Takes a `platform` string (e.g., "x"), not an integration ID.

## Error Handling

| Error | Cause | User-Facing Message |
|-------|-------|---------------------|
| No channels selected | User didn't click any channel in left panel | "No channels selected. Please select a channel from the left panel first." |
| Channel not matching (single) | LLM specified a channel different from the one selected | "The specified channel '[name]' is not selected. You have selected: [name] (id: [id]). Please select the correct channel." |
| Channel not in list (multiple) | LLM specified a channel not in the selected list | "The specified channel '[name]' is not in your selected channels. Available: [list]. Please select the correct channel." |
| Integration not in DB | Resolved ID not found in database (shouldn't happen normally) | "Integration [id] not found in database." |

## Agent System Prompt Instructions

The agent's system prompt (`load.tools.service.ts`) includes these routing-related instructions:

- If 1 channel selected → omit `integrationId`, it's auto-resolved.
- If multiple selected and user wants a specific one → pass its `integrationId`.
- If multiple selected and user wants all → omit `integrationId`.
- If no channels selected → tell user to select from the left panel. Do NOT call `schedulePostTool`.
- If user mentions a channel not in their selection → tell them to select the correct channel.
- **NEVER** suggest the user go to a social media website to post manually.

## Files

| File | Role |
|------|------|
| `libraries/nestjs-libraries/src/chat/tools/resolve-integration.ts` | Shared routing resolver — implements all 6 rules |
| `libraries/nestjs-libraries/src/chat/tools/integration.schedule.post.ts` | Post scheduling tool — uses resolver, supports multi-channel expansion |
| `libraries/nestjs-libraries/src/chat/tools/integration.trigger.tool.ts` | Platform trigger tool — uses resolver, single-channel only |
| `libraries/nestjs-libraries/src/chat/load.tools.service.ts` | Agent system prompt — routing instructions for LLM |
| `apps/backend/src/api/routes/copilot.controller.ts` | Sets `runtimeContext.integrations` from frontend properties |
| `apps/frontend/src/components/agents/agent.tsx` | Frontend channel selection UI (`AgentList`) |
| `apps/frontend/src/components/agents/agent.chat.tsx` | Passes integrations to CopilotKit + appends `[--integrations--]` text context |
| `scripts/test-agent-simple.ts` | E2E test — 21 scenarios covering tool calling, routing, and verification |
