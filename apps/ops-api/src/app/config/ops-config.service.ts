import { Injectable } from '@nestjs/common';
import { TargetApp, TargetEnvironment } from '@lb-map-operations/ops-contract';

export interface TargetConfig {
  readonly app: TargetApp;
  readonly environment: TargetEnvironment;
  readonly namespace: string;
  readonly argoApplication: string;
  readonly deployment: string;
  readonly serviceName: string;
  readonly internalBaseUrl: string;
  readonly internalLiveUrl: string;
  readonly internalReadyUrl: string;
  readonly internalHealthUrl: string;
  readonly publicBaseUrl?: string;
  readonly publicHealthUrl?: string;
  readonly podSelector: string;
  readonly smokeJobLabelSelector: string;
}

@Injectable()
export class OpsConfigService {
  readonly port = Number(process.env.PORT || 3000);
  readonly metricsPort = Number(process.env.OPS_METRICS_PORT || 9090);
  readonly uiPublicDir = process.env.OPS_UI_PUBLIC_DIR || '';
  readonly databaseUrl = process.env.OPS_PG_URL || process.env.DATABASE_URL || '';
  readonly kubernetesApiBase =
    process.env.OPS_KUBERNETES_API_BASE || 'https://kubernetes.default.svc';
  readonly kubernetesTokenFile =
    process.env.OPS_KUBERNETES_TOKEN_FILE ||
    '/var/run/secrets/kubernetes.io/serviceaccount/token';
  readonly argoNamespace =
    process.env.OPS_ARGOCD_NAMESPACE || 'argocd-dev-test';
  readonly argoPublicBaseUrl = process.env.OPS_ARGOCD_PUBLIC_URL || '';
  readonly prometheusBaseUrl =
    process.env.OPS_PROMETHEUS_URL ||
    'http://kube-prometheus-stack-prometheus.monitoring.svc.cluster.local:9090';
  readonly lokiBaseUrl =
    process.env.OPS_LOKI_URL ||
    'http://loki-gateway.monitoring.svc.cluster.local';
  readonly grafanaBaseUrl =
    process.env.OPS_GRAFANA_URL ||
    'http://kube-prometheus-stack-grafana.monitoring.svc.cluster.local';
  readonly firstLevelGroups = splitCsv(
    process.env.OPS_FIRST_LEVEL_GROUPS || 'lb-map-first-level',
  );
  readonly operatorGroups = splitCsv(
    process.env.OPS_OPERATOR_GROUPS || 'lb-map-operator',
  );
  readonly adminGroups = splitCsv(
    process.env.OPS_ADMIN_GROUPS || 'lb-map-admin',
  );
  readonly devAuthUser = process.env.OPS_DEV_AUTH_USER || '';
  readonly devAuthEmail = process.env.OPS_DEV_AUTH_EMAIL || '';
  readonly devAuthGroups = splitCsv(process.env.OPS_DEV_AUTH_GROUPS || '');
  readonly bootstrapUsername = process.env.OPS_BOOTSTRAP_USERNAME || '';
  readonly bootstrapPasswordHash = process.env.OPS_BOOTSTRAP_PASSWORD_HASH || '';
  readonly bootstrapDisplayName = process.env.OPS_BOOTSTRAP_DISPLAY_NAME || '';
  readonly bootstrapEmail = process.env.OPS_BOOTSTRAP_EMAIL || '';
  readonly bootstrapRole = process.env.OPS_BOOTSTRAP_ROLE || 'admin';
  readonly sessionCookieName =
    process.env.NODE_ENV === 'production' ? '__Host-lb-map-ops.sid' : 'lb-map-ops.sid';
  readonly sessionMaxAgeSeconds = Number(process.env.OPS_SESSION_MAX_AGE_SECONDS || 60 * 60 * 4);
  readonly auditRetentionDays = Number(process.env.OPS_AUDIT_RETENTION_DAYS || 90);

  target(app: TargetApp, environment: TargetEnvironment): TargetConfig {
    if (app !== 'varlens') {
      throw new Error(`unsupported target app: ${app}`);
    }

    const namespace = `varlens-${environment}`;
    const serviceName = 'varlens';
    const internalBaseUrl = `http://${serviceName}.${namespace}.svc.cluster.local`;
    const publicBaseUrl =
      process.env[`OPS_VARLENS_${environment.toUpperCase()}_PUBLIC_URL`];
    return {
      app,
      environment,
      namespace,
      argoApplication: namespace,
      deployment: 'varlens',
      serviceName,
      internalBaseUrl,
      internalLiveUrl: joinUrl(internalBaseUrl, '/livez'),
      internalReadyUrl: joinUrl(internalBaseUrl, '/readyz'),
      internalHealthUrl: joinUrl(internalBaseUrl, '/healthz'),
      publicBaseUrl,
      publicHealthUrl: publicBaseUrl
        ? joinUrl(publicBaseUrl, '/healthz')
        : undefined,
      podSelector: `app.kubernetes.io/instance=${serviceName}`,
      smokeJobLabelSelector: `app.kubernetes.io/name=${serviceName},app.kubernetes.io/component in (deployed-smoke,ops-smoke)`,
    };
  }
}

function splitCsv(value: string): string[] {
  return value
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}
