export type OpsRole = 'first-level' | 'admin';

export type ActionKind = 'diagnostic' | 'mutation';

export type ActionStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'rejected';

export type TargetApp = 'varlens';

export type TargetEnvironment = 'dev' | 'test';

export type OperationsSignalSource =
  | 'http'
  | 'kubernetes'
  | 'argocd'
  | 'prometheus'
  | 'loki'
  | 'grafana'
  | 'smoke';

export type SupportIssueClass =
  | 'app-unreachable'
  | 'dependency-unhealthy'
  | 'oidc-login'
  | 'upload-import'
  | 'background-job'
  | 'release-change'
  | 'escalation';

export type DiagnosisSeverity = 'info' | 'warning' | 'critical';

export type DiagnosisConfidence = 'low' | 'medium' | 'high';

export type RemedyRisk = 'none' | 'low' | 'medium';

export type DiagnosisStreamEventType = 'started' | 'step' | 'result' | 'error';

export type DiagnosisStepStatus =
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped';

export interface OpsPrincipal {
  readonly user: string;
  readonly email?: string;
  readonly groups: readonly string[];
  readonly roles: readonly OpsRole[];
}

export interface ActionInputDefinition {
  readonly name: string;
  readonly label: string;
  readonly type: 'text' | 'select';
  readonly required: boolean;
  readonly options?: readonly string[];
  readonly defaultValue?: string;
  readonly pattern?: string;
  readonly maxLength?: number;
}

export interface OperationAction {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly role: OpsRole;
  readonly kind: ActionKind;
  readonly targetApp: TargetApp;
  readonly inputs: readonly ActionInputDefinition[];
}

export interface ActionRunRequest {
  readonly targetApp: TargetApp;
  readonly targetEnvironment: TargetEnvironment;
  readonly inputs?: Record<string, string>;
}

export interface ActionEvidence {
  readonly label: string;
  readonly value: string | number | boolean | null;
}

export interface ActionRunResult {
  readonly runId: string;
  readonly actionId: string;
  readonly status: ActionStatus;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly targetApp: TargetApp;
  readonly targetEnvironment: TargetEnvironment;
  readonly actor: string;
  readonly role: OpsRole;
  readonly summary: string;
  readonly evidence: readonly ActionEvidence[];
  readonly diagnosis?: DiagnosisReport;
  readonly message?: string;
}

export interface MeResponse {
  readonly principal: OpsPrincipal;
}

export interface ActionsResponse {
  readonly actions: readonly OperationAction[];
}

export interface ActionRunResponse {
  readonly run: ActionRunResult;
}

export interface AppEndpointContract {
  readonly livenessPath: string;
  readonly readinessPath: string;
  readonly healthPath: string;
  readonly internalBaseUrl: string;
  readonly livenessUrl: string;
  readonly readinessUrl: string;
  readonly healthUrl: string;
  readonly publicHealthUrl?: string;
}

export interface AppWorkloadContract {
  readonly namespace: string;
  readonly deployment: string;
  readonly serviceName: string;
  readonly podSelector: string;
  readonly statelessRestartAllowed: boolean;
}

export interface ArgoContract {
  readonly application: string;
  readonly namespace: string;
  readonly publicUrl?: string;
}

export interface PrometheusMetricContract {
  readonly name: string;
  readonly description: string;
  readonly requiredLabels: readonly string[];
  readonly sampleQuery: string;
}

export interface LokiLogContract {
  readonly selector: string;
  readonly requiredFields: readonly string[];
  readonly redactedFields: readonly string[];
  readonly sampleQuery: string;
}

export interface GrafanaLinkContract {
  readonly label: string;
  readonly url: string;
}

export interface ObservabilityContract {
  readonly prometheusBaseUrl?: string;
  readonly prometheusMetrics: readonly PrometheusMetricContract[];
  readonly lokiBaseUrl?: string;
  readonly loki: LokiLogContract;
  readonly grafanaDashboards: readonly GrafanaLinkContract[];
}

export interface SmokeContract {
  readonly jobLabelSelector: string;
  readonly triggerAllowed: boolean;
  readonly coreChecks: readonly string[];
}

export interface FirstLevelContract {
  readonly issueClasses: readonly SupportIssueClass[];
  readonly evidenceSources: readonly OperationsSignalSource[];
  readonly escalationFields: readonly string[];
}

export interface AppOperationsContract {
  readonly app: TargetApp;
  readonly environment: TargetEnvironment;
  readonly endpoints: AppEndpointContract;
  readonly workload: AppWorkloadContract;
  readonly argo: ArgoContract;
  readonly observability: ObservabilityContract;
  readonly smoke: SmokeContract;
  readonly firstLevel: FirstLevelContract;
}

export interface ContractsResponse {
  readonly contracts: readonly AppOperationsContract[];
}

export interface SuggestedRemedy {
  readonly remedyId: string;
  readonly title: string;
  readonly description: string;
  readonly actionId: string;
  readonly requiredRole: OpsRole;
  readonly risk: RemedyRisk;
  readonly enabled: boolean;
  readonly disabledReason?: string;
  readonly defaultInputs?: Record<string, string>;
}

export interface DiagnosisFinding {
  readonly findingId: string;
  readonly severity: DiagnosisSeverity;
  readonly confidence: DiagnosisConfidence;
  readonly summary: string;
  readonly likelyCause: string;
  readonly evidence: readonly ActionEvidence[];
  readonly remedies: readonly SuggestedRemedy[];
}

export interface DiagnosisReport {
  readonly targetApp: TargetApp;
  readonly targetEnvironment: TargetEnvironment;
  readonly generatedAt: string;
  readonly findings: readonly DiagnosisFinding[];
}

export interface DiagnosisStepEvent {
  readonly stepId: string;
  readonly label: string;
  readonly status: DiagnosisStepStatus;
  readonly detail?: string;
}

export type DiagnosisStreamEvent =
  | {
      readonly type: 'started';
      readonly runId: string;
      readonly targetApp: TargetApp;
      readonly targetEnvironment: TargetEnvironment;
      readonly startedAt: string;
    }
  | {
      readonly type: 'step';
      readonly runId: string;
      readonly step: DiagnosisStepEvent;
    }
  | {
      readonly type: 'result';
      readonly runId: string;
      readonly run: ActionRunResult;
    }
  | {
      readonly type: 'error';
      readonly runId: string;
      readonly message: string;
    };

export const OPS_ROLE_ORDER: readonly OpsRole[] = [
  'first-level',
  'admin',
];

export const REQUIRED_SIGNAL_SOURCES: readonly OperationsSignalSource[] = [
  'http',
  'kubernetes',
  'argocd',
  'prometheus',
  'loki',
  'grafana',
  'smoke',
];

export const SAFE_TELEMETRY_LABELS: readonly string[] = [
  'app',
  'environment',
  'namespace',
  'route',
  'method',
  'status',
  'job',
  'operation',
  'result',
  'reason',
  'failure_class',
  'dependency',
  'version',
  'revision',
];

export const FORBIDDEN_TELEMETRY_FRAGMENTS: readonly string[] = [
  'patient',
  'case',
  'sample',
  'variant',
  'file',
  'filename',
  'user',
  'email',
  'token',
  'secret',
  'password',
  'payload',
  'message',
  'error_message',
];

export function roleAllows(
  grantedRoles: readonly OpsRole[],
  requiredRole: OpsRole,
): boolean {
  const requiredIndex = OPS_ROLE_ORDER.indexOf(requiredRole);
  return grantedRoles.some(
    (role) => OPS_ROLE_ORDER.indexOf(role) >= requiredIndex,
  );
}

export function assertAppOperationsContract(
  contract: AppOperationsContract,
): void {
  if (
    !contract.endpoints.livenessUrl ||
    !contract.endpoints.readinessUrl ||
    !contract.endpoints.healthUrl
  ) {
    throw new Error(
      `${contract.app}/${contract.environment} must expose livez, readyz and healthz URLs`,
    );
  }

  for (const source of REQUIRED_SIGNAL_SOURCES) {
    if (!contract.firstLevel.evidenceSources.includes(source)) {
      throw new Error(
        `${contract.app}/${contract.environment} is missing ${source} as first-level evidence`,
      );
    }
  }

  if (!contract.observability.prometheusMetrics.length) {
    throw new Error(
      `${contract.app}/${contract.environment} must define support Prometheus metrics`,
    );
  }
  if (
    contract.firstLevel.evidenceSources.includes('prometheus') &&
    !contract.observability.prometheusBaseUrl
  ) {
    throw new Error(
      `${contract.app}/${contract.environment} must define a Prometheus base URL`,
    );
  }
  if (
    contract.firstLevel.evidenceSources.includes('loki') &&
    !contract.observability.lokiBaseUrl
  ) {
    throw new Error(
      `${contract.app}/${contract.environment} must define a Loki base URL`,
    );
  }
  if (
    contract.firstLevel.evidenceSources.includes('grafana') &&
    !contract.observability.grafanaDashboards.length
  ) {
    throw new Error(
      `${contract.app}/${contract.environment} must define at least one Grafana dashboard`,
    );
  }
  for (const metric of contract.observability.prometheusMetrics) {
    assertSafeTelemetryLabels(metric.name, metric.requiredLabels);
  }

  if (!contract.observability.loki.requiredFields.includes('request_id')) {
    throw new Error(
      `${contract.app}/${contract.environment} Loki contract must include request_id`,
    );
  }

  if (!contract.smoke.coreChecks.length) {
    throw new Error(
      `${contract.app}/${contract.environment} must define smoke core checks`,
    );
  }

  for (const field of contract.firstLevel.escalationFields) {
    assertSafeTelemetryValue(field, 'escalation field');
  }
}

function assertSafeTelemetryLabels(
  metricName: string,
  labels: readonly string[],
): void {
  for (const label of labels) {
    assertSafeTelemetryValue(label, `metric label for ${metricName}`);
    if (!SAFE_TELEMETRY_LABELS.includes(label)) {
      throw new Error(`unsupported telemetry label ${label} for ${metricName}`);
    }
  }
}

function assertSafeTelemetryValue(value: string, context: string): void {
  const normalized = value.toLowerCase();
  for (const fragment of FORBIDDEN_TELEMETRY_FRAGMENTS) {
    if (normalized.includes(fragment)) {
      throw new Error(`forbidden ${context} fragment ${fragment}: ${value}`);
    }
  }
}
