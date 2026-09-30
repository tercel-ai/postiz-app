import { Prisma } from '@prisma/client';
import {
  BILLING_SCENES,
  BILLING_SCENE_OTHER,
  BillingSceneDef,
  billingSceneDataKeys,
  findBillingScene,
} from '@gitroom/nestjs-libraries/database/prisma/ai-pricing/billing-scene';
import {
  AdminBillingRecordsQueryDto,
  AMOUNT_PATTERN,
  BILLING_SORT_FIELDS,
  BillingSortField,
} from '@gitroom/nestjs-libraries/dtos/admin/admin-billing-records-query.dto';
import { csvSet } from '@gitroom/nestjs-libraries/dtos/util/csv-set.transform';

/**
 * Query compiler for the admin BillingRecord views.
 *
 * Everything here is raw SQL for one reason: `amount` is a decimal STRING
 * column, so Prisma can neither sum it nor compare it as a number ('9' sorts
 * after '10' as text). Credit totals per business and "show me the charges over
 * N credits" are exactly what operations opens this page for, so the filter is
 * expressed once, as SQL, and shared by the list page, its totals and the
 * per-scene stats. No REQUEST value is ever interpolated: every one goes in as a
 * bound parameter. The only interpolation is the `data` JSON key and its SELECT
 * alias, both derived from repo-committed registries and both asserted against
 * SAFE_IDENTIFIER first — see dataText and buildSceneGrouping, which is where
 * that guard is load-bearing.
 *
 * LAYERING — a deliberate, and so far unique, deviation. Every other Prisma model
 * keeps its query logic in a `*.repository.ts` under
 * libraries/nestjs-libraries/src/database/prisma/; this compiler lives in the app
 * layer instead, so the service layer physically cannot reach it. That is the
 * point: these predicates exist only to serve the admin ledger views, none of the
 * product code should be able to depend on them, and pushing raw SQL into the
 * shared repository layer would invite exactly that. If a second consumer ever
 * appears, this belongs in a BillingRecord repository under libraries/ — until
 * then the coupling it avoids is worth the inconsistency it creates.
 */

/** Guarded numeric reading of `amount`: one malformed row must not 500 the page. */
export const BILLING_AMOUNT = Prisma.sql`(CASE WHEN "amount" ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN "amount"::numeric ELSE 0 END)`;

/**
 * The per_token fields a cost item can carry. `quantity` is always the total;
 * the other three are the split, and are ABSENT on anything written before the
 * split was persisted — which is why every sum below skips absent instead of
 * reading it as zero.
 */
export const BILLING_TOKEN_FIELDS = [
  'quantity',
  'prompt_tokens',
  'completion_tokens',
  'cached_prompt_tokens',
] as const;
export type BillingTokenField = (typeof BILLING_TOKEN_FIELDS)[number];

/**
 * True when a row carries a COMPLETE prompt/completion split — every one of its
 * per_token items has both fields.
 *
 * All-or-nothing, deliberately, and it must stay that way: `deriveTokenColumns`
 * (the write path), the backfill SQL and `summariseTokens` (per record) all apply
 * the same rule, and the point of it is that a partial split reads as precise
 * while under-accounting for the total. An `EXISTS` ("at least one item is split")
 * would make this the one path that disagrees — and the shape it disagrees on,
 * two per_token items where only one is split, is exactly the accrual window that
 * spans the change.
 */
export const BILLING_TOKEN_SPLIT_PRESENT = Prisma.raw(`(
    EXISTS (
      SELECT 1 FROM jsonb_array_elements("costItems"::jsonb) AS item
      WHERE item->>'billing_mode' = 'per_token'
    )
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements("costItems"::jsonb) AS item
      WHERE item->>'billing_mode' = 'per_token'
        -- COALESCE, not a bare NOT: an ABSENT key makes item->'x' SQL NULL and
        -- jsonb_typeof(NULL) NULL, so the comparison is NULL and NOT NULL is
        -- still NULL. The row would not be selected and an unsplit item would
        -- read as split -- the inversion of the whole rule.
        AND NOT COALESCE(
              jsonb_typeof(item->'prompt_tokens') = 'number'
          AND jsonb_typeof(item->'completion_tokens') = 'number',
          FALSE
        )
    )
  )`);

/**
 * Sum one numeric field across a row's **per_token** cost items.
 *
 * `costItems` is a TEXT column, so it has to be cast to jsonb to be read, and a
 * cast of malformed content RAISES. PostgreSQL 16's `IS JSON` predicate would
 * guard that, but the server this runs on is 15 (asserted in
 * billing-records.query.sql.spec.ts, which reads the version off the live
 * connection — the compose files pin 16/17 and are not evidence of what the app
 * connects to). There is no version-independent way to make the cast safe without
 * installing a function, so the caller isolates every token aggregate in its own
 * statement and degrades tokens as a unit when it fails, rather than letting one
 * corrupt row take the whole per-scene view down.
 *
 * The guards that DO work on 15:
 *  - `billing_mode = 'per_token'` excludes per_image items, whose `quantity` is an
 *    image COUNT — summing those in would inflate a token figure with a different
 *    unit entirely.
 *  - `jsonb_typeof(...) = 'number'` stops the inner cast raising on a non-numeric
 *    value.
 *  - the three SPLIT fields are additionally gated on
 *    BILLING_TOKEN_SPLIT_PRESENT, so a row whose split is incomplete contributes
 *    0 to them instead of a partial sum. Without that gate this would be the only
 *    one of the four implementations of the rule that reports
 *    prompt + completion < total as though it accounted for it.
 */
export function billingTokenSum(field: BillingTokenField): Prisma.Sql {
  if (!SAFE_IDENTIFIER.test(field)) {
    throw new Error(`Unsafe billing token field: ${field}`);
  }

  const sum = `(
      SELECT COALESCE(SUM((item->>'${field}')::numeric), 0)
      FROM jsonb_array_elements("costItems"::jsonb) AS item
      WHERE item->>'billing_mode' = 'per_token'
        AND jsonb_typeof(item->'${field}') = 'number'
    )`;

  if (field === 'quantity') {
    return Prisma.raw(sum);
  }

  return Prisma.sql`(CASE WHEN ${BILLING_TOKEN_SPLIT_PRESENT} THEN ${Prisma.raw(
    sum
  )} ELSE 0 END)`;
}

/** `data` JSON keys the admin filter can narrow on directly. */
export const BILLING_DATA_FILTER_KEYS = [
  'source',
  'surface',
  'platform',
  'projectId',
] as const;

const SAFE_IDENTIFIER = /^[a-z][a-z0-9_]*$/i;

export interface NormalizedBillingQuery {
  organizationIds?: string[];
  scenes?: string[];
  businessTypes?: string[];
  subTypes?: string[];
  statuses?: string[];
  /** Narrowing on `data` JSON keys, e.g. { source: 'engage' }. */
  data: Record<string, string>;
  /** Substring match against the serialised costItems — i.e. "which model". */
  model?: string;
  relatedId?: string;
  taskId?: string;
  transactionId?: string;
  /** Free text over description / taskId / relatedId / transactionId / id. */
  search?: string;
  from?: Date;
  to?: Date;
  minAmount?: string;
  maxAmount?: string;
  sortBy: BillingSortField;
  sortOrder: 'asc' | 'desc';
  page: number;
  pageSize: number;
}

/** Same contract as parseAmount: the DTO rejects, this is the internal fallback. */
function parseDate(value?: string): Date | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * Kept as a string: it is cast to `numeric` in SQL, so no float rounding.
 *
 * The DTO now REJECTS a malformed bound (@Matches(AMOUNT_PATTERN)), so over HTTP
 * this never silently drops a filter. It stays permissive here only for internal
 * callers that construct the DTO directly and bypass the ValidationPipe.
 */
function parseAmount(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed && AMOUNT_PATTERN.test(trimmed) ? trimmed : undefined;
}

function clampInt(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number
): number {
  const int = Math.trunc(Number(value));
  if (!Number.isFinite(int)) {
    return fallback;
  }
  return Math.min(Math.max(int, min), max);
}

/** `%` and `_` typed into a search box are literals, not wildcards. */
function likeContains(value: string): string {
  return `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

export function normalizeBillingQuery(
  dto: AdminBillingRecordsQueryDto,
  organizationId?: string | string[]
): NormalizedBillingQuery {
  const data: Record<string, string> = {};
  for (const key of BILLING_DATA_FILTER_KEYS) {
    const value = dto[key]?.trim();
    if (value) {
      data[key] = value;
    }
  }

  return {
    organizationIds: organizationId
      ? Array.isArray(organizationId)
        ? organizationId
        : [organizationId]
      : undefined,
    scenes: csvSet(dto.scene),
    businessTypes: csvSet(dto.businessType),
    subTypes: csvSet(dto.subType),
    statuses: csvSet(dto.status),
    data,
    model: dto.model?.trim() || undefined,
    relatedId: dto.relatedId?.trim() || undefined,
    taskId: dto.taskId?.trim() || undefined,
    transactionId: dto.transactionId?.trim() || undefined,
    search: dto.search?.trim() || undefined,
    from: parseDate(dto.dateFrom),
    to: parseDate(dto.dateTo),
    minAmount: parseAmount(dto.minAmount),
    maxAmount: parseAmount(dto.maxAmount),
    sortBy: (BILLING_SORT_FIELDS as readonly string[]).includes(dto.sortBy)
      ? (dto.sortBy as BillingSortField)
      : 'createdAt',
    sortOrder: dto.sortOrder === 'asc' ? 'asc' : 'desc',
    // Clamped here rather than trusted from the DTO: these two reach SQL as
    // LIMIT/OFFSET, and a caller that bypasses the ValidationPipe (a unit test,
    // an internal call) must not be able to send a negative OFFSET.
    page: clampInt(dto.page, 1, Number.MAX_SAFE_INTEGER, 1),
    pageSize: clampInt(dto.pageSize, 1, 200, 50),
  };
}

/**
 * `data->>'key'` — the key inlined as a SQL literal, deliberately NOT bound.
 *
 * It MUST be a literal because /stats emits this same expression twice, once in
 * the SELECT list and once in GROUP BY, and Postgres matches the two with
 * `equal()` over the parse tree. A bound key gets a fresh `$n` per occurrence,
 * and two Param nodes with different paramids are not equal, so the grouping
 * item would not match the select-list expression; the walker would then find
 * the bare `data` Var ungrouped and reject the statement outright with
 * `column "BillingRecord.data" must appear in the GROUP BY clause`. A literal
 * renders byte-identically in both places. The CAST stays because it pins
 * `jsonb ->> text` against the `jsonb ->> integer` overload.
 *
 * Injection-safe by assertion, not by binding: every caller's key comes from a
 * repo-committed registry (BILLING_SCENES / BILLING_DATA_FILTER_KEYS), never
 * from a request, and SAFE_IDENTIFIER — which forbids quotes — is checked here
 * so no caller can opt out of it.
 */
function dataText(key: string): Prisma.Sql {
  if (!SAFE_IDENTIFIER.test(key)) {
    throw new Error(`Unsafe billing data key: ${key}`);
  }
  return Prisma.raw(`"data"->>CAST('${key}' AS text)`);
}

function scenePredicate(def: BillingSceneDef): Prisma.Sql {
  const parts: Prisma.Sql[] = [Prisma.sql`"businessType" = ${def.businessType}`];

  if (def.subType !== undefined) {
    // IS NOT DISTINCT FROM rather than `=`: against a NULL subType `=` yields
    // NULL, and NULL propagates through the OR chain that scene=other negates,
    // which would hide exactly the unclassified rows that bucket exists for.
    parts.push(Prisma.sql`"subType" IS NOT DISTINCT FROM ${def.subType}`);
  }

  for (const [key, values] of Object.entries(def.data ?? {})) {
    const literals = values.filter((value): value is string => value !== null);
    const clauses: Prisma.Sql[] = [];
    if (literals.length) {
      clauses.push(
        Prisma.sql`COALESCE(${dataText(key)} IN (${Prisma.join(
          literals
        )}), FALSE)`
      );
    }
    if (values.includes(null)) {
      clauses.push(Prisma.sql`${dataText(key)} IS NULL`);
    }
    parts.push(
      clauses.length
        ? Prisma.sql`(${Prisma.join(clauses, ' OR ')})`
        : Prisma.sql`FALSE`
    );
  }

  return Prisma.sql`(${Prisma.join(parts, ' AND ')})`;
}

function sceneFilter(ids: string[]): Prisma.Sql {
  const clauses = ids
    .map(findBillingScene)
    .filter((def): def is BillingSceneDef => !!def)
    .map(scenePredicate);

  if (ids.includes(BILLING_SCENE_OTHER)) {
    clauses.push(
      Prisma.sql`NOT (${Prisma.join(
        BILLING_SCENES.map(scenePredicate),
        ' OR '
      )})`
    );
  }

  // An id no definition claims must match nothing — never everything.
  return clauses.length
    ? Prisma.sql`(${Prisma.join(clauses, ' OR ')})`
    : Prisma.sql`FALSE`;
}

export function buildBillingWhere(query: NormalizedBillingQuery): Prisma.Sql {
  const parts: Prisma.Sql[] = [];

  if (query.organizationIds?.length) {
    parts.push(
      Prisma.sql`"organizationId" IN (${Prisma.join(query.organizationIds)})`
    );
  }
  if (query.scenes?.length) {
    parts.push(sceneFilter(query.scenes));
  }
  if (query.businessTypes?.length) {
    parts.push(
      Prisma.sql`"businessType" IN (${Prisma.join(query.businessTypes)})`
    );
  }
  if (query.subTypes?.length) {
    parts.push(Prisma.sql`"subType" IN (${Prisma.join(query.subTypes)})`);
  }
  if (query.statuses?.length) {
    parts.push(Prisma.sql`"status" IN (${Prisma.join(query.statuses)})`);
  }
  for (const [key, value] of Object.entries(query.data)) {
    parts.push(Prisma.sql`${dataText(key)} = ${value}`);
  }
  if (query.model) {
    parts.push(Prisma.sql`"costItems" ILIKE ${likeContains(query.model)}`);
  }
  if (query.relatedId) {
    parts.push(Prisma.sql`"relatedId" = ${query.relatedId}`);
  }
  if (query.taskId) {
    // Contains, not equals: a taskId embeds the entity it was built from
    // (postiz_post_overage_<postId>), so a partial key is the useful lookup.
    parts.push(Prisma.sql`"taskId" ILIKE ${likeContains(query.taskId)}`);
  }
  if (query.transactionId) {
    parts.push(Prisma.sql`"transactionId" = ${query.transactionId}`);
  }
  if (query.search) {
    const pattern = likeContains(query.search);
    parts.push(Prisma.sql`(
      "description" ILIKE ${pattern}
      OR "taskId" ILIKE ${pattern}
      OR COALESCE("relatedId", '') ILIKE ${pattern}
      OR COALESCE("transactionId", '') ILIKE ${pattern}
      OR "id" = ${query.search}
    )`);
  }
  // `timestamp`, NOT `timestamptz`: BillingRecord.createdAt is TIMESTAMP(3)
  // WITHOUT time zone (migrations/add-billing-record.sql) holding UTC wall-clock.
  // Comparing it against a timestamptz would make Postgres convert the COLUMN
  // using the session TimeZone GUC, so the window would be right only on a UTC
  // database — and the cast landing on the column side would also make the
  // predicate non-sargable against the createdAt indexes. Casting the bound ISO
  // string to `timestamp` discards its trailing Z and yields exactly the UTC
  // wall-clock that was stored, independent of any server setting.
  if (query.from) {
    parts.push(
      Prisma.sql`"createdAt" >= CAST(${query.from.toISOString()} AS timestamp)`
    );
  }
  if (query.to) {
    parts.push(
      Prisma.sql`"createdAt" <= CAST(${query.to.toISOString()} AS timestamp)`
    );
  }
  if (query.minAmount) {
    parts.push(
      Prisma.sql`${BILLING_AMOUNT} >= CAST(${query.minAmount} AS numeric)`
    );
  }
  if (query.maxAmount) {
    parts.push(
      Prisma.sql`${BILLING_AMOUNT} <= CAST(${query.maxAmount} AS numeric)`
    );
  }

  return parts.length ? Prisma.join(parts, ' AND ') : Prisma.sql`TRUE`;
}

export function buildBillingOrderBy(query: NormalizedBillingQuery): Prisma.Sql {
  const direction =
    query.sortOrder === 'asc' ? Prisma.sql`ASC` : Prisma.sql`DESC`;

  // id as the final tiebreak: without a total order, two rows sharing a
  // timestamp can swap between pages and one of them is never shown.
  return query.sortBy === 'amount'
    ? Prisma.sql`${BILLING_AMOUNT} ${direction}, "createdAt" DESC, "id" DESC`
    : Prisma.sql`"createdAt" ${direction}, "id" ${direction}`;
}

/**
 * SELECT list + GROUP BY for the per-scene stats query. Derived from the scene
 * registry so a scene that starts discriminating on a new `data` key is grouped
 * by it automatically — a hand-written key list would silently merge two scenes
 * into one row instead.
 */
export function buildSceneGrouping(): {
  keys: string[];
  select: Prisma.Sql;
  groupBy: Prisma.Sql;
} {
  const keys = billingSceneDataKeys();
  for (const key of keys) {
    if (!SAFE_IDENTIFIER.test(key)) {
      throw new Error(`Unsafe billing scene data key: ${key}`);
    }
  }

  const dataSelects = keys.map(
    (key) => Prisma.sql`${dataText(key)} AS ${Prisma.raw(`"data_${key}"`)}`
  );
  const dataGroups = keys.map((key) => dataText(key));

  return {
    keys,
    select: Prisma.join(
      [Prisma.sql`"businessType"`, Prisma.sql`"subType"`, ...dataSelects],
      ', '
    ),
    groupBy: Prisma.join(
      [Prisma.sql`"businessType"`, Prisma.sql`"subType"`, ...dataGroups],
      ', '
    ),
  };
}
