import { beforeEach, expect, it, vi } from 'vitest';
const client = vi.hoisted(() => vi.fn(function (this: { options: unknown }, options: unknown) { this.options = options; }));
vi.mock('@prisma/client', () => ({ PrismaClient: client }));
import { createDiagnosisClient, formatDiagnosisFailure } from './diagnose-send-attempts';
beforeEach(() => { client.mockClear(); });
it('uses the verified configured URL even when the generated client embeds a test datasource', () => {
 const url = 'postgresql://operator:private-password@remote-host/aisee_postiz_dev?schema=public';
 createDiagnosisClient(url);
 expect(client).toHaveBeenCalledExactlyOnceWith({ datasources: { db: { url } } });
});
it('rejects invalid configuration before constructing a database client', () => {
 expect(() => createDiagnosisClient('postgresql://operator:secret@remote-host/')).toThrow('DATABASE_URL');
 expect(client).not.toHaveBeenCalled();
});
it.each(['code', 'errorCode'])('explains Prisma failures from %s without disclosing connection details', key => {
 const result = formatDiagnosisFailure({ [key]: 'P1001', message: 'postgresql://operator:private-password@remote-host/database' });
 expect(result).toMatchObject({ code: 'P1001' });
 expect(result.message).toContain('configured PostgreSQL server');
 expect(JSON.stringify(result)).not.toMatch(/private-password|remote-host|postgresql:\/\//);
});
it('retains a safe fallback for unclassified errors', () => {
 expect(JSON.stringify(formatDiagnosisFailure(new Error('secret=private-password')))).not.toContain('private-password');
});
