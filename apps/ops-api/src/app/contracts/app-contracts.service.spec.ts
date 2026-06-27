import { AppContractsService } from './app-contracts.service';
import { OpsConfigService } from '../config/ops-config.service';

describe('app contracts service', () => {
  const service = new AppContractsService(new OpsConfigService());

  it('generates validated contracts for every supported target', () => {
    expect(() => service.assertAll()).not.toThrow();

    expect(
      service
        .all()
        .map((contract) => `${contract.app}/${contract.environment}`),
    ).toEqual(['varlens/dev', 'varlens/test']);
  });

  it('makes VarLens first-level support depend on standard platform signals', () => {
    const contract = service.contract('varlens', 'test');

    expect(contract.endpoints.livenessUrl).toBe(
      'http://varlens.varlens-test.svc.cluster.local/livez',
    );
    expect(contract.endpoints.readinessUrl).toBe(
      'http://varlens.varlens-test.svc.cluster.local/readyz',
    );
    expect(contract.workload.podSelector).toBe(
      'app.kubernetes.io/instance=varlens',
    );
    expect(contract.smoke.jobLabelSelector).toContain('ops-smoke');
    expect(contract.firstLevel.evidenceSources).toEqual([
      'http',
      'kubernetes',
      'argocd',
      'prometheus',
      'loki',
      'grafana',
      'smoke',
    ]);
  });

  it('declares bounded support metrics and log fields without raw user data', () => {
    const contract = service.contract('varlens', 'test');
    const operationMetric = contract.observability.prometheusMetrics.find(
      (metric) => metric.name === 'varlens_operation_events_total',
    );

    expect(operationMetric?.requiredLabels).toEqual([
      'app',
      'environment',
      'namespace',
      'operation',
      'result',
      'failure_class',
    ]);
    expect(contract.observability.loki.requiredFields).toContain('request_id');
    expect(contract.firstLevel.escalationFields).toContain('failure_class');
    expect(contract.firstLevel.escalationFields).not.toContain('email');
  });
});
