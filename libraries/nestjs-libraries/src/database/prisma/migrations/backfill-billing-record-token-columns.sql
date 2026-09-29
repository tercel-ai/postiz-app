-- Backfill: BillingRecord token columns, derived from costItems
-- Date: 2026-09-29
-- Run AFTER add-billing-record-token-columns.sql (or after `prisma db push`).
--
-- WHAT IT DERIVES — this must stay identical to deriveTokenColumns() in
-- aisee.client.ts, which every write path uses. If the two drift, a backfilled row
-- and a freshly written one report different numbers for the same data.
--   totalTokens  = SUM(quantity) over per_token items only. per_image items are
--                  skipped: their `quantity` is an image COUNT, a different unit.
--                  A flat-rate charge (its synthetic item has quantity 0) lands on
--                  0, which is accurate — it used no LLM tokens.
--   the split    = populated ONLY when every per_token item carries both
--                  prompt_tokens and completion_tokens. Otherwise NULL, because a
--                  partial sum would look precise while failing to account for
--                  totalTokens. Rows written before the split was persisted have
--                  no split to find and keep only their total, by design — it was
--                  never stored anywhere, so it cannot be recovered.
--
-- SAFE TO RE-RUN, and designed to be: it only touches rows whose totalTokens is
-- still NULL, and processes at most `batch_size` of them per invocation so no
-- single transaction sits on a large ledger. Run it until it reports
-- `remaining 0`:
--
--   until psql "$DATABASE_URL" -f backfill-billing-record-token-columns.sql \
--         2>&1 | tee /dev/stderr | grep -q 'remaining 0'; do :; done
--
-- A row whose costItems is not valid JSON cannot be cast, so it is SKIPPED and its
-- id is printed — one bad row never aborts the run. Those rows keep totalTokens
-- NULL and stay visible as uncovered in `chargesWithTokenData`; find them with:
--
--   SELECT id, "createdAt", left("costItems", 80) FROM "BillingRecord"
--   WHERE "totalTokens" IS NULL ORDER BY "createdAt" DESC;

DO $$
DECLARE
    batch_size     int    := 5000;
    v_updated      bigint := 0;
    v_skipped      bigint := 0;
    v_remaining    bigint;
    r              record;
    v_items        int;
    v_with_split   int;
    v_total        numeric;
    v_prompt       numeric;
    v_completion   numeric;
    v_cached       numeric;
BEGIN
    FOR r IN
        SELECT id, "costItems"
        FROM "BillingRecord"
        WHERE "totalTokens" IS NULL
        ORDER BY "createdAt"
        LIMIT batch_size
    LOOP
        BEGIN
            SELECT
                COUNT(*),
                COUNT(*) FILTER (
                    WHERE jsonb_typeof(item->'prompt_tokens') = 'number'
                      AND jsonb_typeof(item->'completion_tokens') = 'number'
                ),
                COALESCE(SUM(CASE WHEN jsonb_typeof(item->'quantity') = 'number'
                                  THEN (item->>'quantity')::numeric ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN jsonb_typeof(item->'prompt_tokens') = 'number'
                                  THEN (item->>'prompt_tokens')::numeric ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN jsonb_typeof(item->'completion_tokens') = 'number'
                                  THEN (item->>'completion_tokens')::numeric ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN jsonb_typeof(item->'cached_prompt_tokens') = 'number'
                                  THEN (item->>'cached_prompt_tokens')::numeric ELSE 0 END), 0)
            INTO v_items, v_with_split, v_total, v_prompt, v_completion, v_cached
            FROM jsonb_array_elements(r."costItems"::jsonb) AS item
            WHERE item->>'billing_mode' = 'per_token';

            UPDATE "BillingRecord"
            SET "totalTokens" = v_total::int,
                "promptTokens" = CASE
                    WHEN v_items > 0 AND v_with_split = v_items THEN v_prompt::int
                END,
                "completionTokens" = CASE
                    WHEN v_items > 0 AND v_with_split = v_items THEN v_completion::int
                END,
                "cachedPromptTokens" = CASE
                    WHEN v_items > 0 AND v_with_split = v_items THEN v_cached::int
                END
            WHERE id = r.id;

            v_updated := v_updated + 1;
        EXCEPTION WHEN others THEN
            -- Most likely an unparseable costItems. Report and move on: one bad
            -- row must not abort a backfill over the whole ledger.
            v_skipped := v_skipped + 1;
            RAISE NOTICE 'skipped BillingRecord % — %', r.id, SQLERRM;
        END;
    END LOOP;

    SELECT COUNT(*) INTO v_remaining
    FROM "BillingRecord"
    WHERE "totalTokens" IS NULL;

    RAISE NOTICE 'backfilled %, skipped %, remaining %',
        v_updated, v_skipped, v_remaining;
END $$;
