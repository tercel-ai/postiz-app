// Single source of truth for the `Post.source` attribution field.
// Backed by a plain String column in Prisma (schema.prisma `Post.source`,
// default "calendar"), but writes and validation are constrained to these
// values. Keep this list in sync with every place that writes Post.source.
export const VALID_POST_SOURCES = ['calendar', 'chat', 'engage'] as const;

export type PostSource = (typeof VALID_POST_SOURCES)[number];
