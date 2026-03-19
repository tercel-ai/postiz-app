# Copilot Agent Schedule Post — Test Scenarios

## Prerequisites

- At least 1 integration (channel) connected (e.g. LinkedIn, X/Twitter)
- Select the channel(s) in the left panel before chatting
- Aisee service running (or BILL_TYPE=internal)

## Test Matrix

Each test should verify:
- [ ] Agent calls `integrationSchema` before scheduling
- [ ] Agent calls `schedulePostTool` with correct `type` (now/schedule/draft)
- [ ] Post appears in the DB with correct state (QUEUE/DRAFT)
- [ ] BillingRecord created with `ai_copywriting` type

---

## Group A: Direct Schedule Requests

### A1. Schedule — Explicit time, clear intent
**User message:**
> Help me schedule a post on LinkedIn to go live tomorrow at 10 AM. Content: Artificial intelligence is reshaping the boundaries of software engineering. From code generation to architecture design, AI isn't replacing developers — it's empowering every developer to become a 10x engineer. What do you think?

**Expected:**
1. Agent calls `integrationList` (or uses cached)
2. Agent calls `integrationSchema` for LinkedIn
3. Agent drafts content in HTML format, asks user confirmation
4. User confirms → Agent calls `schedulePostTool` with `type: "schedule"`, `date` = tomorrow 10:00 UTC
5. Post created in DB with state=QUEUE

---

### A2. Post Now — Immediate publish
**User message:**
> Help me post a tweet to X right now: Just finished refactoring an open-source project and cut build time from 3 minutes down to 18 seconds. The key was removing unnecessary polyfills and optimizing tree shaking config. Sharing with anyone else working on performance optimization #DevOps #Performance

**Expected:**
1. Agent calls `integrationSchema` for X
2. Agent checks character limit (280 for non-premium)
3. Asks confirmation
4. `schedulePostTool` with `type: "now"`, `date` = current UTC time

---

### A3. Draft — Save without publishing
**User message:**
> I want to write a LinkedIn post about remote work productivity. Save it as a draft first so I can review it before publishing. It's roughly about: 3 years of remote work experience — async communication beats synchronous meetings by 10x.

**Expected:**
1. `schedulePostTool` with `type: "draft"`
2. Post state = DRAFT, no Temporal workflow triggered

---

## Group B: Vague / Conversational Requests

### B1. No time specified — Agent should ask
**User message:**
> Help me post something about why TypeScript's type system is critical for large-scale projects

**Expected:**
Agent should ask: which channel? when to post? Then proceed after user answers.

**Follow-up:**
> Post to LinkedIn, tomorrow at 3 PM

**Expected:**
Now agent has enough info to schedule.

---

### B2. Casual tone — Still should trigger scheduling
**User message:**
> Hey, I want to share my thoughts on Rust's memory safety model on Twitter — something about why the ownership mechanism makes concurrent programming simpler. Can you help me put together a post? Schedule it for next Monday at 9 AM.

**Expected:**
Agent should understand this is a schedule request despite casual tone. Calls `integrationSchema` for X, drafts content, confirms, then `schedulePostTool` with `type: "schedule"`.

---

### B3. Multi-step conversation — Content refinement
**User message 1:**
> I want to write a post about anti-patterns in microservice architecture

**User message 2 (after agent drafts):**
> It's too long, please condense it — just focus on the "distributed monolith" anti-pattern

**User message 3 (after agent refines):**
> That looks good, post it to LinkedIn tomorrow at noon

**Expected:**
Agent should accumulate context across messages. Final call to `schedulePostTool` only after user says "That looks good" + specifies time.

---

## Group C: Multi-Channel / Multi-Post

### C1. Same content, multiple channels
**User message:**
> Post this to both LinkedIn and X simultaneously: One of the biggest misconceptions about the open-source community is that "free" means no cost. Maintaining an active open-source project requires continuous time investment, community management, and documentation updates. Sustainability is the core challenge of open source.

**Expected:**
- `schedulePostTool` with `socialPost` array length = 2
- Each entry has different `integrationId`
- X version may need truncation if > 280 chars

---

### C2. Thread / Series posts
**User message:**
> Help me post a thread on X about database selection, with 3 parts:
> 1. Why you shouldn't use PostgreSQL for every use case
> 2. The advantages of ClickHouse for time-series data
> 3. What problems Neo4j solves for graph data

**Expected:**
- `schedulePostTool` with `socialPost` array length = 1
- `postsAndComments` array length = 3 (thread posts)
- Each under 280 chars

---

### C3. Batch schedule — Multiple days
**User message:**
> Help me plan a week of LinkedIn content, one post per day, themed around "A Software Architect's Daily Life":
> Monday: Methods for quantifying technical debt
> Tuesday: How to promote Architecture Decision Records (ADR) within teams
> Wednesday: 5 prerequisites for migrating from monolith to microservices
> Thursday: Backward compatibility principles in API design
> Friday: The right way to conduct production incident post-mortems

**Expected:**
- `schedulePostTool` with `socialPost` array length = 5
- Each with different `date` (Mon-Fri at appropriate times)
- `type: "schedule"` for all

---

## Group D: With Image / Video Generation

### D1. Generate image + schedule
**User message:**
> Help me write a LinkedIn post about DevOps culture, with an illustration, and post it tomorrow morning

**Expected:**
1. Agent calls `generateImageTool` first
2. Gets image URL back
3. Calls `schedulePostTool` with image URL in `attachments`
4. Two BillingRecords: `image_gen` + `ai_copywriting`

---

### D2. User provides image URL
**User message:**
> Use this image to post on LinkedIn right now
> Image: https://example.com/my-diagram.png

**Expected:**
Agent uses provided URL in `attachments`, does NOT call `generateImageTool`. Only `ai_copywriting` billing.

---

## Group E: Edge Cases / Failure Scenarios

### E1. No channel selected
**User message (without selecting any channel in left panel):**
> Help me post something

**Expected:**
Agent should respond asking user to select a channel first. No tool calls. Properties array is empty → no `[--integrations--]` appended.

---

### E2. Content exceeds platform limit
**User message:**
> Post this 2000-word article directly to Twitter
> [paste long article]

**Expected:**
- Agent calls `integrationSchema` → gets maxLength (280)
- Agent should suggest splitting into thread or summarizing
- If agent tries to schedule anyway, `schedulePostTool` returns validation error, agent retries with shorter content

---

### E3. Invalid date
**User message:**
> Help me schedule a post to go out yesterday afternoon

**Expected:**
Agent should recognize the date is in the past and ask for a valid future date.

---

### E4. Confirm → Modal path (UI mode)
**User message:**
> Help me write a post about Kubernetes resource limits best practices and post it to LinkedIn

**Agent drafts content, user says:**
> OK

**Agent asks: schedule directly or open editor?**
> I'd like to edit it first

**Expected:**
Agent triggers `manualPosting` (frontend CopilotAction) → opens AddEditModal with pre-filled content. User edits and submits from the modal.

---

### E5. Confirm → Direct schedule path
**Same as E4, but user says:**
> Just post it directly

**Expected:**
Agent calls `schedulePostTool` with `type: "now"` or `type: "schedule"`.

---

## Group F: Real-World Discussion Topics (Comprehensive Scenarios)

### F1. Tech industry opinion
**User message:**
> I want to post an opinion to both LinkedIn and X:
> I've been seeing a lot of debate recently about whether AI will replace programmers. My take is — AI isn't changing programming itself, it's changing the barrier to entry and the speed of development. 10 years ago it took 3 months to learn a framework; now with AI assistance it might take 3 days to get up to speed. But deep thinking, architecture design, and product judgment — these are things AI can't do yet.
>
> Help me polish this and schedule it to go out tomorrow morning at 9 AM

**Expected:**
Full flow: integrationSchema × 2 platforms → draft → confirm → schedulePostTool × 2

---

### F2. Product launch announcement
**User message:**
> We're launching version v2.0 next Wednesday. Help me prepare a release announcement. Main updates:
> - Brand new dashboard interface
> - Support for 20+ social platforms
> - AI-powered smart scheduling recommendations
> Include a product screenshot-style image, and post to LinkedIn at 10 AM on Wednesday

**Expected:**
1. `generateImageTool` → product-style image
2. `integrationSchema` for LinkedIn
3. `schedulePostTool` with `type: "schedule"`, `date` = next Wednesday 10:00 UTC

---

### F3. Quick sharing — Minimal input
**User message:**
> Tweet: Ship fast, learn faster. 🚀

**Expected:**
Agent should handle this ultra-short request without over-complicating:
1. `integrationSchema` for X
2. Confirm content
3. `schedulePostTool` with `type: "now"`

---

## Verification Checklist (per test)

After each test, verify in the database:

```sql
-- Check post was created
SELECT id, state, "publishDate", content
FROM "Post"
ORDER BY "createdAt" DESC LIMIT 5;

-- Check billing record was created
SELECT id, "businessType", status, amount, description
FROM "BillingRecord"
ORDER BY "createdAt" DESC LIMIT 5;

-- Check Temporal workflow was started (for schedule/now)
-- Look in Temporal UI for workflow with the post ID
```

## Known Issues to Watch

1. **No channel selected** → `properties` empty → no `[--integrations--]` in message → agent has no channel info → cannot schedule
2. **Agent asks for confirmation but user gives ambiguous response** → may loop or skip scheduling
3. **UI mode "modal or direct?" question** → adds extra round trip, user may lose patience
4. **Time zone confusion** → agent instructions say "UTC time" but users think in local time
5. **integrationSchema not called** → missing settings → validation error in schedulePostTool → agent retries (should work, but adds latency)
