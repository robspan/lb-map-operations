import {
  ActionEvidence,
  AppOperationsContract,
  DiagnosisFinding,
  DiagnosisReport,
  OpsRole,
  SuggestedRemedy,
  roleAllows,
} from '@lb-map-operations/ops-contract';
import type { LokiLogObservation } from '../clients/loki.client';
import type {
  PrometheusMetricObservation,
  PrometheusSeries,
} from '../clients/prometheus.client';

export interface EndpointProbe {
  readonly url: string;
  readonly ok: boolean;
  readonly status: number | string;
  readonly durationMs: number;
  readonly error?: string;
}

export interface DiagnosisFacts {
  readonly argo?: {
    readonly status?: {
      readonly health?: { readonly status?: string };
      readonly sync?: { readonly status?: string; readonly revision?: string };
      readonly operationState?: { readonly phase?: string };
    };
  };
  readonly deployment?: {
    readonly status?: {
      readonly readyReplicas?: number;
      readonly replicas?: number;
      readonly updatedReplicas?: number;
      readonly availableReplicas?: number;
    };
  };
  readonly pods: readonly {
    readonly metadata?: {
      readonly name?: string;
      readonly ownerReferences?: readonly {
        readonly kind?: string;
      }[];
    };
    readonly status?: {
      readonly phase?: string;
      readonly containerStatuses?: readonly {
        readonly restartCount?: number;
      }[];
    };
  }[];
  readonly smokeJobs: readonly {
    readonly metadata?: {
      readonly name?: string;
      readonly creationTimestamp?: string;
    };
    readonly status?: {
      readonly succeeded?: number;
      readonly failed?: number;
      readonly active?: number;
    };
  }[];
  readonly endpoints: {
    readonly liveness?: EndpointProbe;
    readonly readiness?: EndpointProbe;
    readonly publicHealth?: EndpointProbe;
  };
  readonly observability?: {
    readonly metrics: readonly PrometheusMetricObservation[];
    readonly logs?: LokiLogObservation;
  };
  readonly collectionErrors: readonly ActionEvidence[];
}

type RemedyTemplate = Omit<SuggestedRemedy, 'enabled' | 'disabledReason'>;

const REMEDIES = {
  argoSync: {
    remedyId: 'argo-sync-no-prune',
    title: 'ArgoCD Sync ausführen',
    description: 'Wendet den GitOps-Sollzustand erneut ohne Prune an.',
    actionId: 'argo-sync',
    requiredRole: 'operator',
    risk: 'low',
  },
  argoStatus: {
    remedyId: 'read-argo-status',
    title: 'ArgoCD Details anzeigen',
    description: 'Zeigt Sync, Health, Revision und optional Ressourcenstatus.',
    actionId: 'argo-status',
    requiredRole: 'first-level',
    risk: 'none',
    defaultInputs: { detailLevel: 'resources', resourceLimit: '10' },
  },
  podSummary: {
    remedyId: 'read-pod-summary',
    title: 'Pod-Übersicht anzeigen',
    description: 'Zeigt Pods, Phasen, Neustarts und Namespace-Events.',
    actionId: 'pod-summary',
    requiredRole: 'first-level',
    risk: 'none',
  },
  logSummary: {
    remedyId: 'read-log-summary',
    title: 'Log-Auszug anzeigen',
    description: 'Liest begrenzte technische Pod-Logs mit Redaction.',
    actionId: 'log-summary',
    requiredRole: 'first-level',
    risk: 'none',
  },
  observabilityLinks: {
    remedyId: 'open-observability',
    title: 'Observability-Links öffnen',
    description:
      'Zeigt standardisierte Grafana-, Loki-, Prometheus- und ArgoCD-Hinweise.',
    actionId: 'observability-links',
    requiredRole: 'first-level',
    risk: 'none',
  },
  smokeResult: {
    remedyId: 'read-smoke-result',
    title: 'Smoke-Status anzeigen',
    description: 'Zeigt die letzten in-cluster Smoke-Jobs und deren Status.',
    actionId: 'smoke-result',
    requiredRole: 'first-level',
    risk: 'none',
  },
  escalationBundle: {
    remedyId: 'create-escalation-bundle',
    title: 'Eskalationspaket erstellen',
    description:
      'Bündelt Status, Events, ArgoCD-Zustand und Observability-Hinweise.',
    actionId: 'escalation-bundle',
    requiredRole: 'first-level',
    risk: 'none',
  },
} satisfies Record<string, RemedyTemplate>;

export function buildDiagnosisReport(
  contract: AppOperationsContract,
  facts: DiagnosisFacts,
  roles: readonly OpsRole[],
  generatedAt = new Date().toISOString(),
): DiagnosisReport {
  const findings: DiagnosisFinding[] = [];

  for (const error of facts.collectionErrors) {
    findings.push({
      findingId: `collection-${slug(String(error.label))}`,
      severity: 'warning',
      confidence: 'medium',
      summary: `${error.label} konnte nicht gelesen werden.`,
      likelyCause:
        'Operations API, Kubernetes API oder ArgoCD ist für dieses Signal nicht erreichbar.',
      evidence: [error],
      remedies: remedies(
        roles,
        REMEDIES.observabilityLinks,
        REMEDIES.escalationBundle,
      ),
    });
  }

  addArgoFindings(findings, facts, roles);
  addEndpointFindings(findings, contract, facts, roles);
  addWorkloadFindings(findings, facts, roles);
  addSmokeFindings(findings, facts, roles);
  addObservabilityFindings(findings, facts, roles);

  if (!findings.length) {
    findings.push({
      findingId: 'no-obvious-fault',
      severity: 'info',
      confidence: 'medium',
      summary: 'Keine eindeutige Standardstörung erkannt.',
      likelyCause:
        'Die geprüften Standard-Signale zeigen keinen klaren technischen Fehler. Wenn Nutzer weiterhin betroffen sind, fachlichen Kontext und Request-ID einsammeln.',
      evidence: [
        { label: 'ArgoCD Sync', value: argoSyncStatus(facts) || 'unbekannt' },
        {
          label: 'ArgoCD Health',
          value: argoHealthStatus(facts) || 'unbekannt',
        },
        {
          label: 'Readiness',
          value: facts.endpoints.readiness?.ok
            ? 'ok'
            : facts.endpoints.readiness?.status || 'unbekannt',
        },
        { label: 'Pods', value: facts.pods.length },
        {
          label: 'Prometheus-Signale',
          value: facts.observability?.metrics.length ?? 0,
        },
      ],
      remedies: remedies(
        roles,
        REMEDIES.observabilityLinks,
        REMEDIES.argoStatus,
        REMEDIES.podSummary,
        REMEDIES.smokeResult,
        REMEDIES.escalationBundle,
      ),
    });
  }

  return {
    targetApp: contract.app,
    targetEnvironment: contract.environment,
    generatedAt,
    findings,
  };
}

function addArgoFindings(
  findings: DiagnosisFinding[],
  facts: DiagnosisFacts,
  roles: readonly OpsRole[],
): void {
  const syncStatus = argoSyncStatus(facts);
  const healthStatus = argoHealthStatus(facts);
  const operationPhase = facts.argo?.status?.operationState?.phase;

  if (syncStatus === 'OutOfSync') {
    findings.push({
      findingId: 'argocd-out-of-sync',
      severity: healthStatus === 'Healthy' ? 'warning' : 'critical',
      confidence: 'high',
      summary: 'ArgoCD meldet OutOfSync.',
      likelyCause:
        'Der Live-Zustand entspricht nicht dem GitOps-Sollzustand oder ein vorheriger Sync ist nicht vollständig angekommen.',
      evidence: [
        { label: 'ArgoCD Sync', value: syncStatus },
        { label: 'ArgoCD Health', value: healthStatus || 'unbekannt' },
        {
          label: 'Revision',
          value: facts.argo?.status?.sync?.revision || null,
        },
      ],
      remedies: remedies(
        roles,
        REMEDIES.argoSync,
        REMEDIES.argoStatus,
        REMEDIES.escalationBundle,
      ),
    });
  }

  if (healthStatus && healthStatus !== 'Healthy') {
    findings.push({
      findingId: 'argocd-health-not-healthy',
      severity: 'warning',
      confidence: 'medium',
      summary: `ArgoCD Health ist ${healthStatus}.`,
      likelyCause:
        'Eine oder mehrere Kubernetes-Ressourcen der Anwendung melden keinen gesunden Zustand.',
      evidence: [
        { label: 'ArgoCD Health', value: healthStatus },
        { label: 'ArgoCD Sync', value: syncStatus || 'unbekannt' },
      ],
      remedies: remedies(
        roles,
        REMEDIES.argoStatus,
        REMEDIES.podSummary,
        REMEDIES.escalationBundle,
      ),
    });
  }

  if (operationPhase && operationPhase !== 'Succeeded') {
    findings.push({
      findingId: 'argocd-operation-active',
      severity: 'info',
      confidence: 'medium',
      summary: `ArgoCD Operation ist ${operationPhase}.`,
      likelyCause:
        'Ein Sync oder eine vorherige GitOps-Operation läuft oder ist noch nicht abgeschlossen.',
      evidence: [{ label: 'ArgoCD Operation', value: operationPhase }],
      remedies: remedies(roles, REMEDIES.argoStatus),
    });
  }
}

function addEndpointFindings(
  findings: DiagnosisFinding[],
  contract: AppOperationsContract,
  facts: DiagnosisFacts,
  roles: readonly OpsRole[],
): void {
  const liveness = facts.endpoints.liveness;
  const readiness = facts.endpoints.readiness;
  const publicHealth = facts.endpoints.publicHealth;

  if (liveness && !liveness.ok) {
    findings.push({
      findingId: 'liveness-failing',
      severity: 'critical',
      confidence: 'high',
      summary: 'Liveness-Endpunkt antwortet nicht erfolgreich.',
      likelyCause:
        'Der App-Prozess ist nicht stabil erreichbar oder der Service-Pfad ist defekt.',
      evidence: endpointEvidence('Liveness', liveness),
      remedies: remedies(
        roles,
        REMEDIES.podSummary,
        REMEDIES.logSummary,
        REMEDIES.escalationBundle,
      ),
    });
    return;
  }

  if (readiness && !readiness.ok) {
    findings.push({
      findingId: 'readiness-failing',
      severity: 'critical',
      confidence: 'high',
      summary: 'Readiness-Endpunkt antwortet nicht erfolgreich.',
      likelyCause:
        'Der Prozess lebt, aber eine harte Laufzeitabhängigkeit oder Konfiguration verhindert Nutzbarkeit.',
      evidence: endpointEvidence('Readiness', readiness),
      remedies: remedies(
        roles,
        REMEDIES.podSummary,
        REMEDIES.logSummary,
        REMEDIES.observabilityLinks,
        REMEDIES.escalationBundle,
      ),
    });
  }

  if (
    contract.endpoints.publicHealthUrl &&
    publicHealth &&
    !publicHealth.ok &&
    readiness?.ok
  ) {
    findings.push({
      findingId: 'public-endpoint-failing-internal-ready',
      severity: 'warning',
      confidence: 'high',
      summary: 'Öffentlicher Endpunkt ist gestört, interne Readiness ist ok.',
      likelyCause:
        'Ingress, DNS, TLS, Route oder externes Netzwerk ist wahrscheinlicher als die App selbst.',
      evidence: [
        ...endpointEvidence('Public Health', publicHealth),
        { label: 'Interne Readiness', value: 'ok' },
      ],
      remedies: remedies(
        roles,
        REMEDIES.observabilityLinks,
        REMEDIES.escalationBundle,
      ),
    });
  }
}

function addWorkloadFindings(
  findings: DiagnosisFinding[],
  facts: DiagnosisFacts,
  roles: readonly OpsRole[],
): void {
  if (!hasCollectionError(facts, 'Deployment')) {
    const desiredReplicas = facts.deployment?.status?.replicas ?? 0;
    const readyReplicas = facts.deployment?.status?.readyReplicas ?? 0;
    if (desiredReplicas > 0 && readyReplicas === 0) {
      findings.push({
        findingId: 'deployment-no-ready-replicas',
        severity: 'critical',
        confidence: 'high',
        summary: 'Deployment hat keine bereiten Replicas.',
        likelyCause:
          'Pods starten nicht, hängen in Readiness oder crashen vor Nutzbarkeit.',
        evidence: [
          { label: 'Replicas bereit', value: readyReplicas },
          { label: 'Replicas gewünscht', value: desiredReplicas },
        ],
        remedies: remedies(
          roles,
          REMEDIES.podSummary,
          REMEDIES.logSummary,
          REMEDIES.escalationBundle,
        ),
      });
    } else if (desiredReplicas > 0 && readyReplicas < desiredReplicas) {
      findings.push({
        findingId: 'deployment-partially-ready',
        severity: 'warning',
        confidence: 'high',
        summary: 'Deployment ist nur teilweise bereit.',
        likelyCause:
          'Ein Rollout, Ressourcenproblem oder einzelner fehlerhafter Pod verhindert volle Kapazität.',
        evidence: [
          { label: 'Replicas bereit', value: readyReplicas },
          { label: 'Replicas gewünscht', value: desiredReplicas },
        ],
        remedies: remedies(
          roles,
          REMEDIES.podSummary,
          REMEDIES.logSummary,
          REMEDIES.escalationBundle,
        ),
      });
    }
  }

  if (hasCollectionError(facts, 'Pods')) {
    return;
  }

  const workloadPods = facts.pods.filter(isWorkloadPod);
  if (!workloadPods.length) {
    findings.push({
      findingId: 'no-pods-found',
      severity: 'critical',
      confidence: 'high',
      summary: 'Keine App-Pods gefunden.',
      likelyCause:
        'Deployment/Selector passt nicht, Rollout ist fehlgeschlagen oder die App wurde nicht ausgerollt.',
      evidence: [{ label: 'Pods', value: 0 }],
      remedies: remedies(
        roles,
        REMEDIES.argoStatus,
        REMEDIES.podSummary,
        REMEDIES.escalationBundle,
      ),
    });
    return;
  }

  const nonRunningPods = workloadPods.filter(
    (pod) => pod.status?.phase !== 'Running',
  );
  if (nonRunningPods.length) {
    findings.push({
      findingId: 'pods-not-running',
      severity: 'warning',
      confidence: 'high',
      summary: `${nonRunningPods.length} Pod(s) laufen nicht.`,
      likelyCause:
        'Pods hängen in Pending, Failed, Unknown oder einem Startzustand.',
      evidence: nonRunningPods.slice(0, 5).map((pod) => ({
        label: `Pod ${pod.metadata?.name || 'unbekannt'}`,
        value: pod.status?.phase || 'unbekannt',
      })),
      remedies: remedies(
        roles,
        REMEDIES.podSummary,
        REMEDIES.logSummary,
        REMEDIES.escalationBundle,
      ),
    });
  }

  const restarts = workloadPods.reduce((sum, pod) => sum + restartCount(pod), 0);
  if (restarts >= 3) {
    findings.push({
      findingId: 'pod-restart-spike',
      severity: 'warning',
      confidence: 'medium',
      summary: 'Pod-Neustarts sind auffällig erhöht.',
      likelyCause:
        'CrashLoop, OOM, Startfehler oder instabile Laufzeitabhängigkeit.',
      evidence: [{ label: 'Container-Neustarts gesamt', value: restarts }],
      remedies: remedies(
        roles,
        REMEDIES.podSummary,
        REMEDIES.logSummary,
        REMEDIES.escalationBundle,
      ),
    });
  }
}

function addSmokeFindings(
  findings: DiagnosisFinding[],
  facts: DiagnosisFacts,
  roles: readonly OpsRole[],
): void {
  if (hasCollectionError(facts, 'Smoke-Jobs')) {
    return;
  }

  const latestJob = [...facts.smokeJobs].sort(compareCreatedAt).at(-1);
  if (!latestJob) {
    findings.push({
      findingId: 'no-smoke-result',
      severity: 'info',
      confidence: 'medium',
      summary: 'Kein Smoke-Ergebnis gefunden.',
      likelyCause:
        'Es wurde noch kein Smoke-Job ausgeführt oder der Job ist nicht mehr im Cluster vorhanden.',
      evidence: [{ label: 'Smoke-Jobs', value: 0 }],
      remedies: remedies(roles, REMEDIES.smokeResult, REMEDIES.escalationBundle),
    });
    return;
  }

  if (latestJob.status?.failed) {
    findings.push({
      findingId: 'latest-smoke-failed',
      severity: 'warning',
      confidence: 'high',
      summary: 'Der letzte Smoke-Job ist fehlgeschlagen.',
      likelyCause:
        'Der technische Health-Pfad oder ein smoke-naher Kernpfad ist aus Nutzersicht nicht erfolgreich.',
      evidence: [
        { label: 'Smoke-Job', value: latestJob.metadata?.name || 'unbekannt' },
        { label: 'Fehlgeschlagen', value: latestJob.status.failed },
      ],
      remedies: remedies(
        roles,
        REMEDIES.smokeResult,
        REMEDIES.logSummary,
        REMEDIES.escalationBundle,
      ),
    });
  }
}

function addObservabilityFindings(
  findings: DiagnosisFinding[],
  facts: DiagnosisFacts,
  roles: readonly OpsRole[],
): void {
  const metrics = facts.observability?.metrics || [];
  addDependencyMetricFindings(findings, metrics, roles);
  addHttpMetricFindings(findings, metrics, roles);
  addOperationMetricFindings(findings, metrics, roles);
  addLogFindings(findings, facts.observability?.logs, roles);
}

function addDependencyMetricFindings(
  findings: DiagnosisFinding[],
  metrics: readonly PrometheusMetricObservation[],
  roles: readonly OpsRole[],
): void {
  for (const metric of metrics.filter(isDependencyHealthMetric)) {
    if (metric.status !== 'ok') {
      continue;
    }
    const lowest = minSeriesValue(metric.series);
    if (lowest === undefined || lowest > 0) {
      continue;
    }

    findings.push({
      findingId: `dependency-health-unhealthy-${slug(metric.name)}`,
      severity: 'critical',
      confidence: 'high',
      summary: `${metric.name} meldet eine ungesunde Abhängigkeit.`,
      likelyCause:
        'Eine harte Laufzeitabhängigkeit der Anwendung ist laut App-Metrik nicht gesund.',
      evidence: [
        { label: 'Metrik', value: metric.name },
        { label: 'Niedrigster Wert', value: lowest },
        { label: 'Beschreibung', value: metric.description },
      ],
      remedies: remedies(
        roles,
        REMEDIES.observabilityLinks,
        REMEDIES.logSummary,
        REMEDIES.escalationBundle,
      ),
    });
  }
}

function addHttpMetricFindings(
  findings: DiagnosisFinding[],
  metrics: readonly PrometheusMetricObservation[],
  roles: readonly OpsRole[],
): void {
  const requests = metricByName(metrics, 'http_requests_total');
  if (requests?.status === 'ok') {
    const total = sumSeries(requests.series);
    const errors = sumSeries(
      requests.series.filter((series) => /^5/.test(series.labels.status || '')),
    );
    const ratio = total > 0 ? errors / total : 0;
    if (errors >= 1 && ratio >= 0.05) {
      findings.push({
        findingId: 'http-5xx-ratio-elevated',
        severity: ratio >= 0.2 ? 'critical' : 'warning',
        confidence: 'medium',
        summary: 'HTTP-5xx-Anteil ist auffällig erhöht.',
        likelyCause:
          'Die Anwendung verarbeitet Anfragen, aber ein technischer Fehlerpfad produziert Serverfehler.',
        evidence: [
          { label: '5xx in Abfragefenster', value: round(errors) },
          { label: 'Anfragen gesamt', value: round(total) },
          { label: '5xx-Anteil', value: `${round(ratio * 100)}%` },
        ],
        remedies: remedies(
          roles,
          REMEDIES.observabilityLinks,
          REMEDIES.logSummary,
          REMEDIES.escalationBundle,
        ),
      });
    }
  }

  const latency = metricByName(metrics, 'http_request_duration_seconds');
  if (latency?.status === 'ok') {
    const slowest = maxSeries(latency.series);
    if (slowest && slowest.value >= 2) {
      findings.push({
        findingId: 'http-p95-latency-elevated',
        severity: slowest.value >= 5 ? 'critical' : 'warning',
        confidence: 'medium',
        summary: 'HTTP-p95-Latenz ist auffällig erhöht.',
        likelyCause:
          'Die Anwendung ist erreichbar, aber mindestens ein technischer Pfad ist langsam.',
        evidence: [
          { label: 'Metrik', value: latency.name },
          { label: 'Langsamster Wert', value: `${round(slowest.value)}s` },
          {
            label: 'Route',
            value: slowest.labels.route || slowest.labels.path || 'unbekannt',
          },
        ],
        remedies: remedies(
          roles,
          REMEDIES.observabilityLinks,
          REMEDIES.logSummary,
          REMEDIES.escalationBundle,
        ),
      });
    }
  }
}

function addOperationMetricFindings(
  findings: DiagnosisFinding[],
  metrics: readonly PrometheusMetricObservation[],
  roles: readonly OpsRole[],
): void {
  for (const metric of metrics.filter((item) =>
    item.name.endsWith('operation_events_total'),
  )) {
    if (metric.status !== 'ok') {
      continue;
    }
    const failedSeries = metric.series.filter(isFailedOperationSeries);
    const failures = sumSeries(failedSeries);
    if (failures < 1) {
      continue;
    }

    findings.push({
      findingId: `operation-failures-${slug(metric.name)}`,
      severity: 'warning',
      confidence: 'medium',
      summary: 'App-Operationen melden technische Fehler.',
      likelyCause:
        'Eine app-spezifische technische Operation liefert Fehlerklassen, die First Level sammeln und weitergeben kann.',
      evidence: [
        { label: 'Metrik', value: metric.name },
        { label: 'Fehler im Abfragefenster', value: round(failures) },
        ...failedSeries.slice(0, 5).map((series) => ({
          label: series.labels.operation || 'Operation',
          value: [
            series.labels.result,
            series.labels.failure_class,
            round(series.value),
          ]
            .filter(Boolean)
            .join(' / '),
        })),
      ],
      remedies: remedies(
        roles,
        REMEDIES.observabilityLinks,
        REMEDIES.logSummary,
        REMEDIES.escalationBundle,
      ),
    });
  }
}

function addLogFindings(
  findings: DiagnosisFinding[],
  logs: LokiLogObservation | undefined,
  roles: readonly OpsRole[],
): void {
  if (!logs || logs.errorEntries < 1) {
    return;
  }

  findings.push({
    findingId: 'recent-structured-log-errors',
    severity: logs.errorEntries >= 10 ? 'critical' : 'warning',
    confidence: 'medium',
    summary: 'Aktuelle strukturierte Logs enthalten technische Fehler.',
    likelyCause:
      'Die App schreibt Fehler- oder Failure-Class-Signale in den technischen Logs.',
    evidence: [
      { label: 'Log-Einträge geprüft', value: logs.entries },
      { label: 'Fehler-Einträge', value: logs.errorEntries },
      { label: 'Warnungen', value: logs.warningEntries },
      ...logs.failureClasses.map((item) => ({
        label: `Failure-Class ${item.value}`,
        value: item.count,
      })),
      ...logs.errorCodes.map((item) => ({
        label: `Error-Code ${item.value}`,
        value: item.count,
      })),
    ],
    remedies: remedies(
      roles,
      REMEDIES.logSummary,
      REMEDIES.observabilityLinks,
      REMEDIES.escalationBundle,
    ),
  });
}

function hasCollectionError(facts: DiagnosisFacts, label: string): boolean {
  return facts.collectionErrors.some((error) => error.label === label);
}

function remedies(
  roles: readonly OpsRole[],
  ...templates: readonly RemedyTemplate[]
): readonly SuggestedRemedy[] {
  return templates.map((template) => {
    const enabled = roleAllows(roles, template.requiredRole);
    return {
      ...template,
      enabled,
      disabledReason: enabled
        ? undefined
        : `Benötigt Rolle ${template.requiredRole}.`,
    };
  });
}

function argoSyncStatus(facts: DiagnosisFacts): string | undefined {
  return facts.argo?.status?.sync?.status;
}

function argoHealthStatus(facts: DiagnosisFacts): string | undefined {
  return facts.argo?.status?.health?.status;
}

function endpointEvidence(
  label: string,
  probe: EndpointProbe,
): readonly ActionEvidence[] {
  return [
    { label: `${label} URL`, value: probe.url },
    { label: `${label} Status`, value: probe.status },
    { label: `${label} Dauer`, value: `${probe.durationMs}ms` },
    ...(probe.error ? [{ label: `${label} Fehler`, value: probe.error }] : []),
  ];
}

function restartCount(pod: {
  readonly status?: {
    readonly containerStatuses?: readonly { readonly restartCount?: number }[];
  };
}): number {
  return (pod.status?.containerStatuses || []).reduce(
    (sum, status) => sum + (status.restartCount || 0),
    0,
  );
}

function isWorkloadPod(pod: {
  readonly metadata?: {
    readonly ownerReferences?: readonly {
      readonly kind?: string;
    }[];
  };
  readonly status?: { readonly phase?: string };
}): boolean {
  if (
    pod.metadata?.ownerReferences?.some(
      (owner) => owner.kind?.toLowerCase() === 'job',
    )
  ) {
    return false;
  }
  const phase = pod.status?.phase;
  return phase !== 'Succeeded' && phase !== 'Failed';
}

function compareCreatedAt(
  left: { readonly metadata?: { readonly creationTimestamp?: string } },
  right: { readonly metadata?: { readonly creationTimestamp?: string } },
): number {
  return createdAtMs(left) - createdAtMs(right);
}

function createdAtMs(resource: {
  readonly metadata?: { readonly creationTimestamp?: string };
}): number {
  const timestamp = resource.metadata?.creationTimestamp;
  return timestamp ? Date.parse(timestamp) || 0 : 0;
}

function isDependencyHealthMetric(metric: PrometheusMetricObservation): boolean {
  return (
    metric.name.endsWith('_healthy') ||
    metric.name.endsWith('_health') ||
    metric.name.includes('dependency')
  );
}

function metricByName(
  metrics: readonly PrometheusMetricObservation[],
  name: string,
): PrometheusMetricObservation | undefined {
  return metrics.find((metric) => metric.name === name);
}

function minSeriesValue(series: readonly PrometheusSeries[]): number | undefined {
  return series.length
    ? Math.min(...series.map((item) => item.value))
    : undefined;
}

function maxSeries(
  series: readonly PrometheusSeries[],
): PrometheusSeries | undefined {
  return [...series].sort((left, right) => right.value - left.value)[0];
}

function sumSeries(series: readonly PrometheusSeries[]): number {
  return series.reduce((sum, item) => sum + item.value, 0);
}

function isFailedOperationSeries(series: PrometheusSeries): boolean {
  const result = (series.labels.result || series.labels.status || '').toLowerCase();
  const failureClass = series.labels.failure_class || '';
  return (
    result === 'failed' ||
    result === 'failure' ||
    result === 'error' ||
    Boolean(failureClass)
  );
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
