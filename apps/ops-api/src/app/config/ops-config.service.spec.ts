import { OpsConfigService } from './ops-config.service';

describe('ops config service', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('defaults this deployment to the test target', () => {
    delete process.env.OPS_TARGET_ENVIRONMENT;

    const service = new OpsConfigService();

    expect(service.targetEnvironment).toBe('test');
    expect(service.target('varlens', service.targetEnvironment).namespace).toBe(
      'varlens-test',
    );
  });

  it('allows a future prod deployment to own the prod target', () => {
    process.env.OPS_TARGET_ENVIRONMENT = 'prod';

    const service = new OpsConfigService();

    expect(service.targetEnvironment).toBe('prod');
    expect(service.target('varlens', service.targetEnvironment).namespace).toBe(
      'varlens-prod',
    );
  });

  it('rejects unsupported deployment targets at startup', () => {
    process.env.OPS_TARGET_ENVIRONMENT = 'staging';

    expect(() => new OpsConfigService()).toThrow(
      'OPS_TARGET_ENVIRONMENT must be dev, test, or prod.',
    );
  });

  it('normalizes trailing newlines in the bootstrap password hash', () => {
    process.env = {
      ...originalEnv,
      OPS_BOOTSTRAP_PASSWORD_HASH: 'argon-hash\n',
    };

    const service = new OpsConfigService();

    expect(service.bootstrapPasswordHash).toBe('argon-hash');
  });
});
