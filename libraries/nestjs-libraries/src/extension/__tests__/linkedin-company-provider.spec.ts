import { describe, expect, it, vi } from 'vitest';
import { LinkedinPageProvider } from '../../integrations/social/linkedin.page.provider';
describe('LinkedIn organization identity audit', () => {
  it('checks live admin membership using the existing read-only company API', async () => {
    const provider = new LinkedinPageProvider();
    const companies = vi.spyOn(provider, 'companies').mockResolvedValue([{ id: '123' }] as any);
    const account = { providerIdentifier: 'linkedin-page', internalId: '123', token: 'secret' } as any;
    expect(await provider.getSendActor(account)).toEqual({ id: '123', idNamespace: 'linkedin.organization_id' });
    expect(companies).toHaveBeenCalledWith('secret');
    companies.mockResolvedValue([]);
    await expect(provider.getSendActor(account)).rejects.toThrow('LINKEDIN_ORGANIZATION_ADMIN_REQUIRED');
  });
  it.each(['alice', 'urn:li:organization:123', ''])('never treats a member or vanity name as a numeric organization: %s', async internalId => {
    const provider = new LinkedinPageProvider();
    const companies = vi.spyOn(provider, 'companies');
    await expect(provider.getSendActor({ providerIdentifier: 'linkedin-page', internalId } as any)).rejects.toThrow('LINKEDIN_ORGANIZATION_ID_REQUIRED');
    expect(companies).not.toHaveBeenCalled();
  });
});
