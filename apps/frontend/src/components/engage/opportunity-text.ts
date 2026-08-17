/**
 * An opportunity's full text for display: title first, then body.
 *
 * The backend stores the two apart (EngageOpportunity.title) because on Q&A and
 * link-aggregator platforms the title is what a reply must answer, not a
 * summary of the body — and a link submission has a title and NO body at all,
 * so rendering postContent alone shows an empty card. Rows stored before the
 * title column existed have no title and still carry it inside postContent;
 * both shapes render the same through here.
 */
export function opportunityFullText(o: {
  title?: string | null;
  postContent?: string | null;
}): string {
  const title = (o.title ?? '').trim();
  const body = (o.postContent ?? '').trim();
  if (!title) return body;
  return body ? `${title}\n\n${body}` : title;
}
