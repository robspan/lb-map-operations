import { UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { OpsConfigService } from '../config/ops-config.service';
import { IdentityService } from './identity.service';

describe('IdentityService', () => {
  const auth = {
    principalForSessionToken: jest.fn().mockResolvedValue(null),
  };
  const service = new IdentityService(auth as never, new OpsConfigService());

  beforeEach(() => {
    auth.principalForSessionToken.mockResolvedValue(null);
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    delete process.env.NODE_ENV;
  });

  it('maps trusted groups to roles in non-production mode', async () => {
    const principal = await service.principalFromRequest({
      headers: {
        'x-forwarded-user': 'support@example.org',
        'x-forwarded-email': 'support@example.org',
        'x-forwarded-groups': 'lb-map-first-level,lb-map-operator',
      },
    } as unknown as Request);

    expect(principal.roles).toEqual(['first-level', 'operator']);
  });

  it('uses a valid DB-backed session principal first', async () => {
    auth.principalForSessionToken.mockResolvedValue({
      user: 'operator',
      groups: ['lb-map-operator'],
      roles: ['operator'],
    });

    const principal = await service.principalFromRequest({
      headers: { cookie: 'lb-map-ops.sid=session-token' },
    } as unknown as Request);

    expect(principal.user).toBe('operator');
    expect(principal.roles).toEqual(['operator']);
  });

  it('fails closed in production when session cookie is missing', async () => {
    process.env.NODE_ENV = 'production';
    await expect(service.principalFromRequest({ headers: {} } as unknown as Request)).rejects.toThrow(
      UnauthorizedException
    );
  });
});
