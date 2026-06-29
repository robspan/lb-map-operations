import { BadRequestException } from '@nestjs/common';
import { OpsConfigService } from '../config/ops-config.service';
import { AuthService } from './auth.service';

describe('AuthService bootstrap user convergence', () => {
  const previousEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...previousEnv,
      OPS_BOOTSTRAP_USERNAME: 'ops-admin',
      OPS_BOOTSTRAP_PASSWORD_HASH: 'bootstrap-hash',
      OPS_BOOTSTRAP_DISPLAY_NAME: 'Operations Admin',
      OPS_BOOTSTRAP_EMAIL: 'ops-admin@example.invalid',
      OPS_BOOTSTRAP_ROLE: 'admin',
    };
  });

  afterEach(() => {
    process.env = previousEnv;
  });

  it('reconciles a drifted bootstrap user back to the bootstrap secret', async () => {
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const db = {
      enabled: () => true,
      query: jest
        .fn()
        .mockResolvedValueOnce({
          rows: [
            {
              id: '1',
              username: 'ops-admin',
              display_name: 'Changed',
              email: null,
              password_hash: 'changed-hash',
              role: 'first-level',
              active: false,
              must_change_password: true,
            },
          ],
        })
        .mockResolvedValue({ rows: [] }),
    };

    await new AuthService(audit as never, new OpsConfigService(), db as never).onModuleInit();

    expect(db.query).toHaveBeenCalledTimes(3);
    expect(db.query.mock.calls[1][0]).toContain('UPDATE ops_users');
    expect(db.query.mock.calls[1][1]).toEqual([
      'ops-admin',
      'Operations Admin',
      'ops-admin@example.invalid',
      'bootstrap-hash',
      'admin',
    ]);
    expect(db.query.mock.calls[2][0]).toContain('DELETE FROM ops_sessions');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: 'ops-admin',
        role: 'admin',
        action: 'auth-bootstrap-reconcile',
        result: 'success',
      }),
    );
  });

  it('does not touch a converged bootstrap user', async () => {
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const db = {
      enabled: () => true,
      query: jest.fn().mockResolvedValueOnce({
        rows: [
          {
            id: '1',
            username: 'ops-admin',
            display_name: 'Operations Admin',
            email: 'ops-admin@example.invalid',
            password_hash: 'bootstrap-hash',
            role: 'admin',
            active: true,
            must_change_password: false,
          },
        ],
      }),
    };

    await new AuthService(audit as never, new OpsConfigService(), db as never).onModuleInit();

    expect(db.query).toHaveBeenCalledTimes(1);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rejects API password reset for the bootstrap user', async () => {
    const service = new AuthService(
      { record: jest.fn() } as never,
      new OpsConfigService(),
      { enabled: () => true, query: jest.fn() } as never,
    );

    await expect(service.resetPassword('ops-admin', 'new-password')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rejects API deactivation for the bootstrap user', async () => {
    const service = new AuthService(
      { record: jest.fn() } as never,
      new OpsConfigService(),
      { enabled: () => true, query: jest.fn() } as never,
    );

    await expect(service.setUserActive('ops-admin', false)).rejects.toThrow(
      BadRequestException,
    );
  });
});
