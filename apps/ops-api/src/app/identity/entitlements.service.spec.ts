import { EntitlementsService } from './entitlements.service';

describe('EntitlementsService', () => {
  const fixedDate = new Date('2026-06-29T12:00:00Z');

  it('only returns active when entitlement and app resource are active', async () => {
    const db = {
      query: jest.fn().mockResolvedValue({
        rows: [
          {
            id: '1',
            subject: 'sub-1',
            username: 'alice',
            app: 'varlens',
            environment: 'test',
            role: 'user',
            status: 'active',
            resource_status: 'pending',
            updated_at: fixedDate,
          },
        ],
      }),
    };
    const service = new EntitlementsService({ record: jest.fn() } as never, db as never);

    await expect(
      service.decision({ subject: 'sub-1', app: 'varlens', environment: 'test' }),
    ).resolves.toEqual({
      active: false,
      subject: 'sub-1',
      app: 'varlens',
      environment: 'test',
      role: 'user',
      status: 'active',
      resourceStatus: 'pending',
      reason: 'inactive-resource',
    });
  });

  it('grants app-entitlement state and audits the change', async () => {
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const db = {
      query: jest.fn().mockResolvedValue({
        rows: [
          {
            id: '7',
            subject: 'sub-2',
            username: 'bob',
            app: 'varlens',
            environment: 'dev',
            role: 'admin',
            status: 'active',
            resource_status: 'active',
            updated_at: fixedDate,
          },
        ],
      }),
    };
    const service = new EntitlementsService(audit as never, db as never);

    await expect(
      service.grant({
        subject: 'sub-2',
        username: 'bob',
        app: 'varlens',
        environment: 'dev',
        role: 'admin',
        resourceStatus: 'active',
        actor: 'ops-admin',
      }),
    ).resolves.toEqual({
      id: '7',
      subject: 'sub-2',
      username: 'bob',
      app: 'varlens',
      environment: 'dev',
      role: 'admin',
      status: 'active',
      resourceStatus: 'active',
      active: true,
      updatedAt: '2026-06-29T12:00:00.000Z',
    });
    expect(db.query.mock.calls[0][0]).toContain('ON CONFLICT');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: 'ops-admin',
        action: 'identity_entitlement_grant',
        targetApp: 'varlens',
        targetEnvironment: 'dev',
        result: 'success',
      }),
    );
  });

  it('revokes entitlement and resource state together', async () => {
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const db = {
      query: jest.fn().mockResolvedValue({
        rows: [
          {
            id: '8',
            subject: 'sub-3',
            username: null,
            app: 'varlens',
            environment: 'test',
            role: 'user',
            status: 'revoked',
            resource_status: 'revoked',
            updated_at: fixedDate,
          },
        ],
      }),
    };
    const service = new EntitlementsService(audit as never, db as never);

    const result = await service.revoke({
      subject: 'sub-3',
      app: 'varlens',
      environment: 'test',
      actor: 'ops-admin',
    });

    expect(result.active).toBe(false);
    expect(result.status).toBe('revoked');
    expect(result.resourceStatus).toBe('revoked');
    expect(db.query.mock.calls[0][0]).toContain("status = 'revoked'");
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'identity_entitlement_revoke' }),
    );
  });

  it('audits resource-status updates', async () => {
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const db = {
      query: jest.fn().mockResolvedValue({
        rows: [
          {
            id: '9',
            subject: 'sub-4',
            username: null,
            app: 'varlens',
            environment: 'dev',
            role: 'user',
            status: 'active',
            resource_status: 'active',
            updated_at: fixedDate,
          },
        ],
      }),
    };
    const service = new EntitlementsService(audit as never, db as never);

    await service.setResourceStatus({
      subject: 'sub-4',
      app: 'varlens',
      environment: 'dev',
      resourceStatus: 'active',
      actor: 'ops-admin',
    });

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'identity_resource_status_update',
        metadata: expect.objectContaining({ subject: 'sub-4', resourceStatus: 'active' }),
      }),
    );
  });
});
