# TODO: Post Now Failure Cleanup & Overage Deduction Refactor

**Status**: Deferred — high risk, low urgency
**Created**: 2026-04-07
**Owner**: TBD

## Problem

Two related issues in the post send flow:

### 1. `post now` failure leaves an ERROR record in DB

When a user clicks "Post Now" and the send fails, the post is created in the
database and marked `state='ERROR'`. The frontend shows an error toast in the
modal (which stays open with all user input intact), but a stale ERROR record
remains in the calendar.

User intuition: an immediate-send failure is a synchronous interaction; the
user expects to fix the error in the modal and re-send, not to navigate back
to the calendar to manage a "ghost" failed record.

### 2. `deductIfOverage` runs on failed sends

Current `posts.service.ts:844-852` calls `_postOverageService.deductIfOverage`
unconditionally after `createPost` returns, regardless of whether the workflow
succeeds. This means:

- Post Now failures still deduct overage credits (the user is charged for a
  send that never actually happened).
- Scheduled / recurring posts deduct **at creation time**, not at publish time.
  If the workflow later fails, the user has already been charged.

Additionally, `PostOverageService` currently has two latent bugs:

- `post-overage.service.ts:47` calls `getUserLimits(userId)` with the JWT
  user, not the org owner. Limits should be billed against the organization's
  owner (SUPERADMIN > ADMIN), consistent with how `AiseeCreditService` resolves
  user identity.
- `post-overage.service.ts:74` passes `userId: orgId` to
  `aiseeCreditService.deductAndConfirm()`. Aisee bills by user, not by org —
  this should be the resolved owner ID via
  `aiseeCreditService.resolveOwnerUserId(orgId)`.

Agent / autopost code paths (`integration.schedule.post.ts:258`,
`autopost.service.ts:270`) call `createPost` without a userId, so today they
**skip overage deduction entirely** — another consequence of the JWT-based
identity coupling.

## Why Deferred

The fix requires coordinated changes across:
- `posts.service.ts` (createPost, updatePost, finalizeRecurringCycle)
- `posts.repository.ts` (new soft-delete helper)
- `post-overage.service.ts` (signature + identity resolution)
- Multiple test suites (`posts.service.createPost.spec.ts`,
  `post-overage.service.spec.ts`, `post-workflow.spec.ts`)

The investigation surfaced several edge cases that could regress production
behavior if mishandled:

1. **Multi-post threads**: workflow calls `updatePost` per thread item;
   deduction must filter `parentPostId === null` to avoid multi-charging.
2. **Recurring originals**: must be skipped (deduction belongs on the clone).
3. **Edit-then-postNow flow**: `createOrUpdatePost` is an upsert; soft-deleting
   on failure would corrupt the user's pre-existing scheduled record (Prisma
   `upsert` matches by primary key regardless of `deletedAt`, so a re-submit
   would update an invisible row that workflow then publishes silently — user
   sees neither the original nor the published result).
4. **PUBLISHED state writes bypass `changeState`**: actual publish path is
   `posts.repository.ts:637 updatePost` and `:751 finalizeCycleClone`, not
   `changeState`. Hooking deduction in `changeState` would miss the success
   path entirely.
5. **Owner fallback**: `resolveOwnerUserId` falls back to `orgId` when no
   SUPERADMIN/ADMIN exists; `getUserLimits` would then return 0/0 (hard
   block) — acceptable degradation but worth verifying for orgs in unusual
   states.
6. **Existing retry feature**: `retryPost` (`posts.service.ts:895`) requires
   `state === 'ERROR'` and reads via `getPostById`. The feature is only
   meaningful for scheduled posts that fail in the background. Soft-deleting
   postNow failures removes them from retry, which is acceptable because the
   modal stays open and users retry inline — but this is a behavioral
   asymmetry that needs documentation if implemented.

Risk-vs-benefit: the current behavior is incorrect (especially the overage
deduction on failure) but not blocking. Pushing this without thorough test
coverage risks billing regressions or losing user data on edit-then-postNow
flows.

## Proposed Solution

### Backend changes (frontend requires zero changes — see below)

1. **`posts.repository.ts`**: add `softDeleteFailedPost(id: string)` —
   updates a single post's `parentPostId: null, deletedAt: new Date()`. Cannot
   reuse `softDeleteGroupPosts` because it filters
   `state IN ('QUEUE','DRAFT')` and excludes ERROR.

2. **`posts.service.ts:796-805`** (postNow catch block) **and `:824-827`**
   (postNow sync state check): when ERROR is detected, branch on whether the
   call is a new creation or an edit:
   - New creation (`post.value?.every(v => !v.id)`):
     `_postRepository.softDeleteFailedPost(posts[0].id)`. Push error to
     `postNowErrors`.
   - Edit (`post.value?.some(v => !!v.id)`): leave the ERROR record (current
     behavior). The frontend modal stays open and re-submission upserts the
     same row, which is functionally equivalent to retry.
   - Both branches still throw `BadRequestException` so the user sees the
     error message in the modal toast.

3. **`posts.service.ts:844-852`**: delete the entire `deductIfOverage` call
   from `createPost`. Deduction is no longer creation-time.

4. **`posts.service.ts updatePost` (line 127)**: after the existing recurring-
   original guard returns and `_postRepository.updatePost` succeeds, fire-and-
   forget call `_postOverageService.deductIfOverage(orgId, postId)` **only
   when `post.parentPostId == null`** to avoid charging for thread children.

5. **`posts.service.ts finalizeRecurringCycle` (line 92)**: after
   `finalizeCycleClone` succeeds, when `result.state === 'PUBLISHED'`, fire-
   and-forget call `_postOverageService.deductIfOverage(post.organizationId,
   cloneId)`. Recurring clones always have `parentPostId === null`.

6. **`post-overage.service.ts deductIfOverage`**:
   - Change signature to `deductIfOverage(orgId: string, postId: string)` —
     drop the `userId` parameter.
   - Internally resolve owner:
     `const ownerId = await this._aiseeCreditService.resolveOwnerUserId(orgId)`.
   - Use `ownerId` for `getUserLimits(ownerId)`.
   - Pass `userId: ownerId` to `deductAndConfirm` (fixes the orgId-as-userId
     bug).

### Frontend (no changes needed)

`manage.modal.tsx:382-401` already implements the desired error handling:

```ts
const res = await fetch('/posts', { method: 'POST', body: JSON.stringify(data) });
if (!res.ok) {
  const { message } = await res.json().catch(() => ({ message: 'Post failed' }));
  toaster.show(message || 'Post failed', 'warning');
  setLoading(false);
  return;  // ← modal stays open, all React state preserved
}
mutate();
toaster.show('updated_successfully');
modal.closeAll();  // ← only on success
```

The "Post Now" button (`schedule('now')`, line 621) shares this same path
with the regular "Add to calendar" submit. On failure:
- Toast displayed with error message
- `loading` reset
- Modal **not closed**
- Editor content, attached media (already uploaded with `id`/`path`),
  settings, integrations, tags, and date all preserved in React state
- User can fix and click again

For new creations, `existingData.group` is null so `makeId(10)` generates a
fresh group on each click → re-submission creates a brand new post (no
collision with the soft-deleted predecessor). For edits, `value.id` is
preserved so the upsert hits the same row.

### Tests

- `posts.service.createPost.spec.ts`: remove the existing
  "createPost calls deductIfOverage" assertions. Add cases for postNow
  failure → soft delete (new) / leave ERROR (edit).
- `post-overage.service.spec.ts`: update for new signature; mock
  `aiseeCreditService.resolveOwnerUserId`; cover owner-resolution path and
  fallback behavior.
- `post-workflow.spec.ts`: verify `finalizeRecurringCycle` triggers deduction
  only on PUBLISHED, never on ERROR.
- New: `posts.service.updatePost` test verifying deduction skipped when
  `parentPostId !== null` (thread children).

## Verification Checklist (when implementing)

- [ ] Post Now success on a new post → soft delete not triggered, deduction
      fires once (on the parent), no double-charge for thread children
- [ ] Post Now failure on a new post → DB row soft-deleted, modal preserves
      content, no deduction
- [ ] Post Now failure on an edit (existing scheduled post) → DB row stays
      ERROR, re-submission upserts cleanly, no duplicate deduction
- [ ] Scheduled post success → deduction fires once at PUBLISHED via the
      workflow, with owner userId
- [ ] Scheduled post failure → no deduction
- [ ] Recurring post cycle success → deduction fires per published clone
- [ ] Recurring post cycle failure → no deduction
- [ ] Multi-post thread → deduction fires once for the parent only
- [ ] Agent / autopost paths now correctly deduct (previously skipped due to
      missing userId)
- [ ] Org without SUPERADMIN/ADMIN → fallback resolves to orgId →
      `getUserLimits` returns 0/0 → block (graceful degradation)
- [ ] Existing retry button on ERROR records still works for scheduled
      failures

## Related Code

- `libraries/nestjs-libraries/src/database/prisma/posts/posts.service.ts`
  (createPost, updatePost, finalizeRecurringCycle, changeState, retryPost)
- `libraries/nestjs-libraries/src/database/prisma/posts/posts.repository.ts`
  (updatePost, finalizeCycleClone, changeState, softDeleteGroupPosts,
  createOrUpdatePost)
- `libraries/nestjs-libraries/src/database/prisma/posts/post-overage.service.ts`
- `libraries/nestjs-libraries/src/database/prisma/ai-pricing/aisee-credit.service.ts`
  (`resolveOwnerUserId`)
- `apps/orchestrator/src/workflows/post-workflows/post.workflow.v1.0.1.ts`
  (publish path, error handling, finalizeRecurringCycle calls)
- `apps/orchestrator/src/activities/post.activity.ts` (updatePost,
  finalizeRecurringCycle, changeState activities)
- `apps/frontend/src/components/new-launch/manage.modal.tsx` (no changes
  expected, but verify behavior holds)
