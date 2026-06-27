import { UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { OpsConfigService } from '../config/ops-config.service';
import { IdentityService } from './identity.service';

describe('IdentityService', () => {
  const service = new IdentityService(new OpsConfigService());

  it('maps trusted groups to roles', () => {
    const principal = service.principalFromRequest({
      headers: {
        'x-forwarded-user': 'support@example.org',
        'x-forwarded-email': 'support@example.org',
        'x-forwarded-groups': 'lb-map-first-level,lb-map-operator',
      },
    } as unknown as Request);

    expect(principal.roles).toEqual(['first-level', 'operator']);
  });

  it('fails closed when trusted identity headers are missing', () => {
    expect(() => service.principalFromRequest({ headers: {} } as unknown as Request)).toThrow(
      UnauthorizedException
    );
  });
});
