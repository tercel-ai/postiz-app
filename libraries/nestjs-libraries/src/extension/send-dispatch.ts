import { Prisma } from '@prisma/client';

function targetObject(target: unknown): Prisma.JsonObject {
  return target && typeof target === 'object' && !Array.isArray(target) && target !== Prisma.DbNull && target !== Prisma.JsonNull
    ? target as Prisma.JsonObject : {};
}

/** Read only valid server-authored immediate dispatch metadata. */
export function readPublishNowRequestedAt(target: unknown): Date | null {
  const dispatch = targetObject(targetObject(target).dispatch);
  if (dispatch.mode !== 'now' || typeof dispatch.requestedAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T/.test(dispatch.requestedAt)) return null;
  const date = new Date(dispatch.requestedAt);
  return Number.isFinite(date.getTime()) ? date : null;
}

/** Account projections never expose internal dispatch metadata. */
export function stripDispatchTarget(target: unknown): Prisma.JsonObject | null {
  const { dispatch, ...identity } = targetObject(target);
  return Object.keys(identity).length ? identity : null;
}

export function withPublishNowRequestedAt(target: unknown, at: Date | null): Prisma.InputJsonValue | Prisma.NullTypes.DbNull {
  const identity = stripDispatchTarget(target) ?? {};
  return at ? { ...identity, dispatch: { mode: 'now', requestedAt: at.toISOString() } } as Prisma.InputJsonValue
    : Object.keys(identity).length ? identity as Prisma.InputJsonValue : Prisma.DbNull;
}

/** Identity writers retain the existing server scheduling decision. */
export function preserveDispatchTarget(previous: unknown, next: unknown): Prisma.InputJsonValue | Prisma.NullTypes.DbNull {
  return withPublishNowRequestedAt(next, readPublishNowRequestedAt(previous));
}

export function sortPublishDispatchRows<T extends { id: string; sendTarget?: unknown; publishDate?: Date }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const left = readPublishNowRequestedAt(a.sendTarget)?.getTime();
    const right = readPublishNowRequestedAt(b.sendTarget)?.getTime();
    if (left !== undefined || right !== undefined) return (left ?? Infinity) - (right ?? Infinity) || a.id.localeCompare(b.id);
    return (a.publishDate?.getTime() ?? 0) - (b.publishDate?.getTime() ?? 0) || a.id.localeCompare(b.id);
  });
}
