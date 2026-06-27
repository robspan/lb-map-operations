import {
  AppOperationsContract,
  assertAppOperationsContract,
  roleAllows,
} from './operations';

describe('operations contract', () => {
  it('treats roles as a one-way support hierarchy', () => {
    expect(roleAllows(['first-level'], 'first-level')).toBe(true);
    expect(roleAllows(['first-level'], 'operator')).toBe(false);
    expect(roleAllows(['operator'], 'first-level')).toBe(true);
    expect(roleAllows(['admin'], 'operator')).toBe(true);
  });

  it('accepts a complete app operations interface', () => {
    expect(() => assertAppOperationsContract(validContract())).not.toThrow();
  });

  it('rejects support metrics with unsafe labels', () => {
    expect(() =>
      assertAppOperationsContract({
        ...validContract(),
        observability: {
          ...validContract().observability,
          prometheusMetrics: [
            {
              name: 'unsafe_metric_total',
              description: 'unsafe',
              requiredLabels: ['app', 'patient_id'],
              sampleQuery: 'unsafe_metric_total',
            },
          ],
        },
      }),
    ).toThrow(/patient/);
  });

  it('requires every standard first-level signal source', () => {
    expect(() =>
      assertAppOperationsContract({
        ...validContract(),
        firstLevel: {
          ...validContract().firstLevel,
          evidenceSources: ['http', 'kubernetes', 'argocd'],
        },
      }),
    ).toThrow(/prometheus/);
  });
});

function validContract(): AppOperationsContract {
  return {
    app: 'varlens',
    environment: 'test',
    endpoints: {
      livenessPath: '/livez',
      readinessPath: '/readyz',
      healthPath: '/healthz',
      internalBaseUrl: 'http://varlens.varlens-test.svc.cluster.local',
      livenessUrl: 'http://varlens.varlens-test.svc.cluster.local/livez',
      readinessUrl: 'http://varlens.varlens-test.svc.cluster.local/readyz',
      healthUrl: 'http://varlens.varlens-test.svc.cluster.local/healthz',
    },
    workload: {
      namespace: 'varlens-test',
      deployment: 'varlens',
      serviceName: 'varlens',
      podSelector: 'app.kubernetes.io/instance=varlens',
      statelessRestartAllowed: true,
    },
    argo: {
      application: 'varlens-test',
      namespace: 'argocd-dev-test',
    },
    observability: {
      prometheusBaseUrl: 'https://prometheus.example.test',
      prometheusMetrics: [
        {
          name: 'varlens_operation_events_total',
          description:
            'Bounded support-relevant application operation results.',
          requiredLabels: [
            'app',
            'environment',
            'operation',
            'result',
            'failure_class',
          ],
          sampleQuery:
            'sum by (operation,result,failure_class) (increase(varlens_operation_events_total[30m]))',
        },
      ],
      lokiBaseUrl: 'https://loki.example.test',
      loki: {
        selector: '{namespace="varlens-test", app="varlens"}',
        requiredFields: [
          'request_id',
          'route',
          'status',
          'duration_ms',
          'result',
          'failure_class',
        ],
        redactedFields: ['authorization', 'cookie'],
        sampleQuery:
          '{namespace="varlens-test", app="varlens"} | json | request_id != ""',
      },
      grafanaDashboards: [
        { label: 'VarLens', url: 'https://grafana.example.test/d/varlens' },
      ],
    },
    smoke: {
      jobLabelSelector: 'app.kubernetes.io/name=varlens',
      triggerAllowed: true,
      coreChecks: ['health-contract', 'login-entry', 'core-workflow'],
    },
    firstLevel: {
      issueClasses: [
        'app-unreachable',
        'dependency-unhealthy',
        'oidc-login',
        'upload-import',
      ],
      evidenceSources: [
        'http',
        'kubernetes',
        'argocd',
        'prometheus',
        'loki',
        'grafana',
        'smoke',
      ],
      escalationFields: [
        'environment',
        'time_window',
        'request_id',
        'operation',
        'failure_class',
      ],
    },
  };
}
