import { AppOperationsContract } from '@lb-map-operations/ops-contract';
import { DiagnosisFacts, buildDiagnosisReport } from './diagnosis-rules';

describe('diagnosis rules', () => {
  it('suggests Argo sync for OutOfSync but disables it for first-level users', () => {
    const report = buildDiagnosisReport(
      contract(),
      {
        ...healthyFacts(),
        argo: {
          status: {
            sync: { status: 'OutOfSync', revision: 'abc123' },
            health: { status: 'Healthy' },
          },
        },
      },
      ['first-level'],
      '2026-06-27T10:00:00.000Z',
    );

    const finding = report.findings.find(
      (item) => item.findingId === 'argocd-out-of-sync',
    );
    const remedy = finding?.remedies.find(
      (item) => item.actionId === 'argo-sync',
    );

    expect(finding?.severity).toBe('warning');
    expect(remedy).toMatchObject({
      requiredRole: 'admin',
      enabled: false,
      disabledReason: 'Benötigt Rolle admin.',
    });
  });

  it('enables the same Argo remedy for admins', () => {
    const report = buildDiagnosisReport(
      contract(),
      {
        ...healthyFacts(),
        argo: {
          status: {
            sync: { status: 'OutOfSync', revision: 'abc123' },
            health: { status: 'Healthy' },
          },
        },
      },
      ['admin'],
      '2026-06-27T10:00:00.000Z',
    );

    expect(
      report.findings
        .find((item) => item.findingId === 'argocd-out-of-sync')
        ?.remedies.find((item) => item.actionId === 'argo-sync'),
    ).toMatchObject({ enabled: true });
  });

  it('classifies public endpoint failures with internal readiness as platform-facing', () => {
    const report = buildDiagnosisReport(
      contract(),
      {
        ...healthyFacts(),
        endpoints: {
          liveness: endpoint('/livez', true, 200),
          readiness: endpoint('/readyz', true, 200),
          publicHealth: endpoint('https://varlens.example/healthz', false, 502),
        },
      },
      ['first-level'],
      '2026-06-27T10:00:00.000Z',
    );

    const finding = report.findings.find(
      (item) => item.findingId === 'public-endpoint-failing-internal-ready',
    );
    expect(finding?.likelyCause).toContain('Ingress');
    expect(finding?.remedies.map((item) => item.actionId)).toEqual([
      'observability-links',
      'escalation-bundle',
    ]);
  });

  it('returns a neutral finding when no standard fault is visible', () => {
    const report = buildDiagnosisReport(
      contract(),
      healthyFacts(),
      ['first-level'],
      '2026-06-27T10:00:00.000Z',
    );

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({
      findingId: 'no-obvious-fault',
      severity: 'info',
    });
    expect(
      report.findings[0].remedies.map((remedy) => remedy.actionId),
    ).toEqual([
      'observability-links',
      'argo-status',
      'pod-summary',
      'smoke-result',
      'escalation-bundle',
    ]);
    expect(
      report.findings.flatMap((finding) =>
        finding.remedies.map((remedy) => remedy.actionId),
      ),
    ).not.toContain('smoke-trigger');
  });

  it('does not infer missing pods or smoke results when collection failed', () => {
    const report = buildDiagnosisReport(
      contract(),
      {
        ...healthyFacts(),
        pods: [],
        smokeJobs: [],
        collectionErrors: [
          { label: 'Pods', value: 'Kubernetes API unavailable' },
          { label: 'Smoke-Jobs', value: 'Kubernetes API unavailable' },
        ],
      },
      ['first-level'],
      '2026-06-27T10:00:00.000Z',
    );

    expect(report.findings.map((finding) => finding.findingId)).toContain(
      'collection-pods',
    );
    expect(report.findings.map((finding) => finding.findingId)).toContain(
      'collection-smoke-jobs',
    );
    expect(report.findings.map((finding) => finding.findingId)).not.toContain(
      'no-pods-found',
    );
    expect(report.findings.map((finding) => finding.findingId)).not.toContain(
      'no-smoke-result',
    );
  });

  it('ignores terminal Job pods when evaluating workload pod health', () => {
    const report = buildDiagnosisReport(
      contract(),
      {
        ...healthyFacts(),
        pods: [
          {
            metadata: { name: 'varlens-123' },
            status: {
              phase: 'Running',
              containerStatuses: [{ restartCount: 0 }],
            },
          },
          {
            metadata: {
              name: 'varlens-deployed-smoke-old',
              ownerReferences: [{ kind: 'Job' }],
            },
            status: { phase: 'Failed', containerStatuses: [] },
          },
          {
            metadata: {
              name: 'varlens-deployed-smoke-done',
              ownerReferences: [{ kind: 'Job' }],
            },
            status: { phase: 'Succeeded', containerStatuses: [] },
          },
        ],
      },
      ['first-level'],
      '2026-06-27T10:00:00.000Z',
    );

    expect(report.findings.map((finding) => finding.findingId)).not.toContain(
      'pods-not-running',
    );
  });

  it('detects an unhealthy dependency from contract-defined metrics', () => {
    const report = buildDiagnosisReport(
      contract(),
      {
        ...healthyFacts(),
        observability: {
          metrics: [
            metric('varlens_database_healthy', [{ labels: {}, value: 0 }]),
          ],
        },
      },
      ['first-level'],
      '2026-06-27T10:00:00.000Z',
    );

    const finding = report.findings.find(
      (item) =>
        item.findingId ===
        'dependency-health-unhealthy-varlens-database-healthy',
    );
    expect(finding).toMatchObject({
      severity: 'critical',
      confidence: 'high',
    });
    expect(finding?.remedies.map((item) => item.actionId)).toContain(
      'observability-links',
    );
  });

  it('detects elevated HTTP 5xx ratio from contract-defined metrics', () => {
    const report = buildDiagnosisReport(
      contract(),
      {
        ...healthyFacts(),
        observability: {
          metrics: [
            metric('http_requests_total', [
              { labels: { status: '200', route: '/cases' }, value: 80 },
              { labels: { status: '500', route: '/cases' }, value: 20 },
            ]),
          ],
        },
      },
      ['first-level'],
      '2026-06-27T10:00:00.000Z',
    );

    expect(report.findings.map((item) => item.findingId)).toContain(
      'http-5xx-ratio-elevated',
    );
  });

  it('detects recent structured log errors from Loki summaries', () => {
    const report = buildDiagnosisReport(
      contract(),
      {
        ...healthyFacts(),
        observability: {
          metrics: [],
          logs: {
            query: '{namespace="varlens-test",app="varlens"} | json',
            entries: 12,
            errorEntries: 3,
            warningEntries: 1,
            failureClasses: [{ value: 'database', count: 2 }],
            errorCodes: [{ value: 'DB_TIMEOUT', count: 2 }],
          },
        },
      },
      ['first-level'],
      '2026-06-27T10:00:00.000Z',
    );

    const finding = report.findings.find(
      (item) => item.findingId === 'recent-structured-log-errors',
    );
    expect(finding?.evidence).toEqual(
      expect.arrayContaining([
        { label: 'Failure-Class database', value: 2 },
        { label: 'Error-Code DB_TIMEOUT', value: 2 },
      ]),
    );
  });
});

function healthyFacts(): DiagnosisFacts {
  return {
    argo: {
      status: {
        sync: { status: 'Synced', revision: 'abc123' },
        health: { status: 'Healthy' },
        operationState: { phase: 'Succeeded' },
      },
    },
    deployment: {
      status: {
        readyReplicas: 1,
        replicas: 1,
        updatedReplicas: 1,
        availableReplicas: 1,
      },
    },
    pods: [
      {
        metadata: { name: 'varlens-123' },
        status: {
          phase: 'Running',
          containerStatuses: [{ restartCount: 0 }],
        },
      },
    ],
    smokeJobs: [
      {
        metadata: {
          name: 'varlens-smoke-1',
          creationTimestamp: '2026-06-27T09:00:00.000Z',
        },
        status: { succeeded: 1 },
      },
    ],
    endpoints: {
      liveness: endpoint('/livez', true, 200),
      readiness: endpoint('/readyz', true, 200),
      publicHealth: endpoint('https://varlens.example/healthz', true, 200),
    },
    collectionErrors: [],
  };
}

function endpoint(url: string, ok: boolean, status: number) {
  return {
    url,
    ok,
    status,
    durationMs: 12,
  };
}

function metric(
  name: string,
  series: readonly { labels: Record<string, string>; value: number }[],
) {
  return {
    name,
    description: `${name} description`,
    query: `${name}{app="varlens"}`,
    status: 'ok' as const,
    series,
  };
}

function contract(): AppOperationsContract {
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
      publicHealthUrl: 'https://varlens.example/healthz',
    },
    workload: {
      namespace: 'varlens-test',
      deployment: 'varlens',
      serviceName: 'varlens',
      podSelector:
        'app.kubernetes.io/instance=varlens,app.kubernetes.io/name=varlens,!platform.robspan.net/test',
      statelessRestartAllowed: true,
    },
    argo: {
      application: 'varlens-test',
      namespace: 'argocd-dev-test',
    },
    observability: {
      prometheusBaseUrl: 'http://prometheus.example',
      prometheusMetrics: [],
      lokiBaseUrl: 'http://loki.example',
      loki: {
        selector: '{namespace="varlens-test",app="varlens"}',
        requiredFields: ['request_id'],
        redactedFields: ['token'],
        sampleQuery: '{namespace="varlens-test",app="varlens"} | json',
      },
      grafanaDashboards: [],
    },
    smoke: {
      jobLabelSelector:
        'app.kubernetes.io/name=varlens,platform.robspan.net/test in (deployed-smoke,ops-smoke)',
      triggerAllowed: true,
      coreChecks: ['health-contract'],
    },
    firstLevel: {
      issueClasses: ['app-unreachable'],
      evidenceSources: [
        'http',
        'kubernetes',
        'argocd',
        'prometheus',
        'loki',
        'grafana',
        'smoke',
      ],
      escalationFields: ['request_id', 'failure_class'],
    },
  };
}
