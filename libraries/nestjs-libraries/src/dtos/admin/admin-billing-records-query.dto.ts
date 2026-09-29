import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { CsvSetTransform } from '@gitroom/nestjs-libraries/dtos/util/csv-set.transform';

/**
 * A credit amount as it is stored: a plain decimal string. Shared with the query
 * compiler, which casts the bound value to `numeric`, so a value that does not
 * match this must be rejected at the boundary rather than reaching the cast.
 */
export const AMOUNT_PATTERN = /^-?\d+(\.\d+)?$/;

/** Matches the cap the sibling admin list DTOs apply to their set parameters. */
const SET_FILTER_MAX = 30;

/**
 * Sortable columns. `amount` sorts NUMERICALLY (the column is a decimal string,
 * where '9' would otherwise sort after '10') — see BILLING_AMOUNT in
 * billing-records.query.ts.
 */
export const BILLING_SORT_FIELDS = ['createdAt', 'amount'] as const;
export type BillingSortField = (typeof BILLING_SORT_FIELDS)[number];

/**
 * Filters for the admin BillingRecord views. Every list-shaped field accepts a
 * comma-separated set (`status=failed,pending`) so one request can answer the
 * question operations actually asks ("what did Engage cost us, charged or not").
 *
 * Deliberately no @IsIn on scene / businessType / subType / status: the sets are
 * open-ended (a new billing call site adds to them), and an unknown value must
 * narrow to nothing rather than 400 the page.
 *
 * The date and amount bounds are the opposite: they are validated here and a
 * malformed one is REJECTED. Silently ignoring them would answer with the whole
 * ledger and its credit total while the operator believes they are looking at a
 * scoped window — fail-open on a money figure.
 */
export class AdminBillingRecordsQueryDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(SET_FILTER_MAX)
  @IsString({ each: true })
  @CsvSetTransform
  status?: string[];

  @IsOptional()
  @IsString()
  organizationId?: string;

  @IsOptional()
  @IsString()
  userId?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(SET_FILTER_MAX)
  @IsString({ each: true })
  @CsvSetTransform
  businessType?: string[];

  /**
   * The business-scene id(s) from GET /admin/billing/meta — the single filter
   * that separates spend by what triggered it (editor copilot vs agent chat vs
   * calendar post generation…), which businessType alone cannot express.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(SET_FILTER_MAX)
  @IsString({ each: true })
  @CsvSetTransform
  scene?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(SET_FILTER_MAX)
  @IsString({ each: true })
  @CsvSetTransform
  subType?: string[];

  /** data.source — calendar | chat | engage. */
  @IsOptional()
  @IsString()
  source?: string;

  /** data.surface — copilot_chat | agent_chat. */
  @IsOptional()
  @IsString()
  surface?: string;

  /** data.platform — set by the analytics-sync charge. */
  @IsOptional()
  @IsString()
  platform?: string;

  /** data.projectId — set by operation-plan generation. */
  @IsOptional()
  @IsString()
  projectId?: string;

  /** Substring of the costItems breakdown, i.e. "charges that used this model". */
  @IsOptional()
  @IsString()
  model?: string;

  /** Exact business entity: post / media / opportunity / plan / integration id. */
  @IsOptional()
  @IsString()
  relatedId?: string;

  /** Partial idempotency key — a taskId embeds the entity it was built from. */
  @IsOptional()
  @IsString()
  taskId?: string;

  @IsOptional()
  @IsString()
  transactionId?: string;

  /** Free text over description / taskId / relatedId / transactionId / id. */
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsISO8601()
  dateFrom?: string;

  @IsOptional()
  @IsISO8601()
  dateTo?: string;

  /** Credit bounds, e.g. minAmount=1 to find the expensive single charges. */
  @IsOptional()
  @Matches(AMOUNT_PATTERN)
  minAmount?: string;

  @IsOptional()
  @Matches(AMOUNT_PATTERN)
  maxAmount?: string;

  @IsOptional()
  @IsIn(BILLING_SORT_FIELDS as unknown as string[])
  sortBy: string = 'createdAt';

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder: 'asc' | 'desc' = 'desc';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize: number = 50;
}
