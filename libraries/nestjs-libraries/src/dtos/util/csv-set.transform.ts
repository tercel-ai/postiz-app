import { Transform } from 'class-transformer';

/**
 * Flatten a set-valued query parameter (`?status=a,b,c`) into a deduped array.
 *
 * Accepts what Express actually hands over — a single string, a repeated
 * parameter (already an array), or a mix — and is idempotent, so it can run both
 * as a DTO `@Transform` and again in a query compiler without changing the
 * result.
 *
 * Trims, drops empties and dedupes. `?status=failed,%20pending` — what a human
 * pasting a list produces — yields `['failed', 'pending']` rather than a
 * `' pending'` element that would silently match nothing.
 *
 * The same idiom is inlined at 17 sites across the DTO layer (admin-posts-query,
 * get.posts-list, get.posts, locate.post-in-list, dashboard, and a local copy
 * named `csvTransform` in admin-user-dashboard-query), none of which trim or
 * dedupe. This is the version they should converge on; migrating them is
 * deliberately not bundled with the change that introduced it.
 */
export function csvSet(value: unknown): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const flattened = (Array.isArray(value) ? value : [value]).flatMap((item) =>
    typeof item === 'string' ? item.split(',') : [item]
  );
  const set = [
    ...new Set(flattened.map((item) => String(item).trim()).filter(Boolean)),
  ];
  return set.length ? set : undefined;
}

/** DTO decorator form of {@link csvSet}. */
export const CsvSetTransform = Transform(({ value }) => csvSet(value) ?? []);
