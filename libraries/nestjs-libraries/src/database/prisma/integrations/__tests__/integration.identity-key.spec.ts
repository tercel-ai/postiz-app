import { beforeEach, afterEach } from 'vitest';
beforeEach(() => vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true'));
afterEach(() => vi.unstubAllEnvs());
import { describe, expect, it, vi } from 'vitest';
import { IntegrationRepository } from '../integration.repository';

function setup() {
  const integration = {
    findFirst: vi.fn().mockResolvedValue(null),
    upsert: vi.fn().mockResolvedValue({ id: 'account' }),
    updateMany: vi.fn(),
  };
  const repository = new IntegrationRepository(
    { model: { integration } } as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any
  );
  return { integration, repository };
}

describe('platform-scoped integration identity key', () => {
  it('uses platform and namespace in upsert so equal bare IDs cannot overwrite another platform', async () => {
    const { integration, repository } = setup();
    await repository.createOrUpdateIntegration(
      undefined,
      false,
      'org',
      'Alice',
      undefined,
      'social',
      '123',
      'devto',
      'oauth',
      '',
      0
    );
    const call = integration.upsert.mock.calls[0][0];
    expect(
      call.where.organizationId_providerIdentifier_identityNamespace_internalId
    ).toEqual({
      organizationId: 'org',
      providerIdentifier: 'devto',
      identityNamespace: 'legacy',
      internalId: '123',
    });
    expect(call.create.identityNamespace).toBe('legacy');
  });
  it('qualifies settings lookups by provider instead of merging another platform settings', async () => {
    const { integration, repository } = setup();
    await repository.createOrUpdateIntegration(
      [
        {
          title: 'custom',
          description: '',
          type: 'text',
          value: 'value',
          regex: '',
        },
      ],
      false,
      'org',
      'Alice',
      undefined,
      'social',
      '123',
      'devto',
      'oauth',
      '',
      0
    );
    expect(integration.findFirst.mock.calls[0][0].where).toMatchObject({
      providerIdentifier: 'devto',
      identityNamespace: 'legacy',
    });
  });
  it('preserves the legacy LinkedIn credential family while excluding unrelated providers and namespaces', async () => {
    vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'false');
    const { integration, repository } = setup();
    await repository.createOrUpdateIntegration(
      undefined,
      true,
      'org',
      'Alice',
      undefined,
      'social',
      '123',
      'linkedin-page',
      'oauth',
      '',
      0
    );
    expect(integration.findFirst).toHaveBeenCalledWith({ where: expect.objectContaining({ providerIdentifier: 'linkedin-page', identityNamespace: 'legacy' }) });
    expect(integration.upsert.mock.calls[0][0].create.identityNamespace).toBe('legacy');
    expect(integration.updateMany.mock.calls[0][0].where).toMatchObject({
      providerIdentifier: { in: ['linkedin', 'linkedin-page'] },
      identityNamespace: 'legacy',
      rootInternalId: '123',
    });
  });
  it('requires provider-qualified page lookup', async () => {
    const { integration, repository } = setup();
    await repository.findIntegrationByInternalId(
      'org',
      '123',
      'linkedin-page',
      'legacy'
    );
    expect(integration.findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: 'org',
        internalId: '123',
        providerIdentifier: 'linkedin-page',
        identityNamespace: 'legacy',
      },
    });
  });
});

import { memorySendDatabase } from '../../../../extension/__tests__/support/memory-send-database';
import { SocialAccountIdentityService } from '../../../../extension/social-account-identity.service';
function stableFixture() {
  const db = memorySendDatabase();
  const repository = new IntegrationRepository({model:db} as any,{} as any,{} as any,{} as any,{} as any,{} as any,{} as any);
  const oauth = (id='123', creation?:{maxChannels:number|null}) => repository.createOrUpdateIntegration(undefined,false,'org','OAuth name',undefined,'social',id,'x','new-oauth','new-refresh',3600,'alice',false,undefined,undefined,undefined,'legacy',creation);
  const identities = new SocialAccountIdentityService(db as any);
  const plugin = () => db.$transaction((tx:any)=>identities.resolveIn(tx,'org','x','x.rest_id','123',{source:'EXTENSION',canCreate:true,maxChannels:2,handle:'alice'}));
  return {db,repository,oauth,plugin};
}
describe('OAuth and extension identity convergence',()=>{
  it('attaches OAuth credentials to the existing plugin row and retains project/post references',async()=>{
    const f=stableFixture();const session=await f.plugin();
    f.db.seed('post',{id:'historic',integrationId:session.account!.id});
    f.db.seed('integrationProject',{id:'relation',integrationId:session.account!.id});
    const connected=await f.oauth();
    expect(connected).toMatchObject({id:session.account!.id,token:'new-oauth',refreshToken:'new-refresh',identityNamespace:'x.rest_id',metadata:{credentialSource:'OAUTH'}});
    expect(f.db.rows('post')[0].integrationId).toBe(connected.id);
    expect(f.db.rows('integrationProject')[0].integrationId).toBe(connected.id);
    expect(f.db.rows('integration')).toHaveLength(1);
  });
  it('reuses an OAuth-first actor from a terminal and preserves the namespace on refresh',async()=>{
    const f=stableFixture();const connected=await f.oauth('123',{maxChannels:2});
    expect((await f.plugin()).account?.id).toBe(connected.id);
    expect((await f.oauth()).id).toBe(connected.id);
    expect(f.db.rows('integration')).toHaveLength(1);
  });
  it('coalesces concurrent OAuth and plugin discovery without a second channel',async()=>{
    const f=stableFixture();const [oauth,plugin]=await Promise.all([f.oauth('123',{maxChannels:1}),f.plugin()]);
    expect(oauth.id).toBe(plugin.account?.id);
    expect(f.db.rows('integration')).toHaveLength(1);
  });
  it('does not create or change credentials when stable identity is ambiguous',async()=>{
    const f=stableFixture();for(const [id,ns] of [['old','legacy'],['new','x.rest_id']])f.db.seed('integration',{id,identityNamespace:ns,internalId:'123',organizationId:'org',providerIdentifier:'x',token:'original'});
    await expect(f.oauth()).rejects.toThrow('ACCOUNT_IDENTITY_CONFLICT');
    expect(f.db.rows('integration').map(r=>r.token)).toEqual(['original','original']);
  });
});

it('rejects an invalid X actor before it can bypass the stable-identity creation quota',async()=>{
  const f=stableFixture();await expect(f.oauth('invalid-handle',{maxChannels:0})).rejects.toThrow('ACCOUNT_IDENTITY_UNRESOLVED');
  expect(f.db.rows('integration')).toHaveLength(0);
});
