/** Parse a PostgreSQL target without exposing connection credentials in errors. */
export function databaseNameFromUrl(databaseUrl: string | undefined): string {
  if (!databaseUrl?.trim()) throw new Error('DATABASE_URL is required');
  try {
    const url = new URL(databaseUrl);
    const database = decodeURIComponent(url.pathname.slice(1));
    if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
        !url.hostname || !url.pathname.startsWith('/') ||
        url.pathname.slice(1).includes('/') || !database.trim() ||
        /[\u0000-\u001f\u007f]/.test(database) || url.hash) {
      throw new Error('INVALID_DATABASE_URL');
    }
    return database;
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL URL with an explicit database name');
  }
}
