import { Injectable } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { OpsConfigService, TargetConfig } from '../config/ops-config.service';

interface KubernetesList<T> {
  readonly items?: readonly T[];
}

interface KubernetesMetadata {
  readonly name?: string;
  readonly namespace?: string;
  readonly labels?: Record<string, string>;
  readonly annotations?: Record<string, string>;
  readonly creationTimestamp?: string;
}

interface Pod {
  readonly metadata?: KubernetesMetadata;
  readonly status?: {
    readonly phase?: string;
    readonly containerStatuses?: readonly {
      readonly name?: string;
      readonly restartCount?: number;
      readonly ready?: boolean;
    }[];
  };
}

interface Event {
  readonly metadata?: KubernetesMetadata;
  readonly reason?: string;
  readonly type?: string;
  readonly message?: string;
  readonly lastTimestamp?: string;
  readonly eventTime?: string;
}

interface Deployment {
  readonly metadata?: KubernetesMetadata;
  readonly status?: {
    readonly readyReplicas?: number;
    readonly replicas?: number;
    readonly updatedReplicas?: number;
    readonly availableReplicas?: number;
  };
}

interface Job {
  readonly metadata?: KubernetesMetadata;
  readonly status?: {
    readonly succeeded?: number;
    readonly failed?: number;
    readonly active?: number;
    readonly startTime?: string;
    readonly completionTime?: string;
  };
}

@Injectable()
export class KubernetesClient {
  constructor(private readonly config: OpsConfigService) {}

  async deployment(target: TargetConfig): Promise<Deployment> {
    return this.request<Deployment>(
      `/apis/apps/v1/namespaces/${target.namespace}/deployments/${target.deployment}`,
    );
  }

  async pods(target: TargetConfig): Promise<readonly Pod[]> {
    const selector = encodeURIComponent(target.podSelector);
    const list = await this.request<KubernetesList<Pod>>(
      `/api/v1/namespaces/${target.namespace}/pods?labelSelector=${selector}`,
    );
    return list.items || [];
  }

  async events(target: TargetConfig): Promise<readonly Event[]> {
    const list = await this.request<KubernetesList<Event>>(
      `/api/v1/namespaces/${target.namespace}/events?limit=20`,
    );
    return list.items || [];
  }

  async logs(
    target: TargetConfig,
    podName: string,
    tailLines: number,
    previous = false,
  ): Promise<string> {
    const params = new URLSearchParams({ tailLines: String(tailLines) });
    if (previous) {
      params.set('previous', 'true');
    }
    return this.requestText(
      `/api/v1/namespaces/${target.namespace}/pods/${podName}/log?${params}`,
    );
  }

  async jobs(target: TargetConfig): Promise<readonly Job[]> {
    const selector = encodeURIComponent(target.smokeJobLabelSelector);
    const list = await this.request<KubernetesList<Job>>(
      `/apis/batch/v1/namespaces/${target.namespace}/jobs?labelSelector=${selector}`,
    );
    return list.items || [];
  }

  async restartDeployment(target: TargetConfig, actor: string): Promise<void> {
    const now = new Date().toISOString();
    await this.request(
      `/apis/apps/v1/namespaces/${target.namespace}/deployments/${target.deployment}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/strategic-merge-patch+json' },
        body: JSON.stringify({
          spec: {
            template: {
              metadata: {
                annotations: {
                  'ops.robspan.net/restarted-at': now,
                  'ops.robspan.net/restarted-by': actor,
                },
              },
            },
          },
        }),
      },
    );
  }

  async createSmokeJob(target: TargetConfig, actor: string): Promise<string> {
    const createdAt = new Date().toISOString();
    const body = {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        generateName: `${target.serviceName}-ops-smoke-`,
        labels: {
          'app.kubernetes.io/name': target.serviceName,
          'app.kubernetes.io/instance': target.serviceName,
          'app.kubernetes.io/component': 'ops-smoke',
          'platform.robspan.net/app': target.app,
          'platform.robspan.net/environment': target.environment,
        },
        annotations: {
          'ops.robspan.net/created-by': actor,
          'ops.robspan.net/created-at': createdAt,
        },
      },
      spec: {
        ttlSecondsAfterFinished: 3600,
        backoffLimit: 0,
        template: {
          spec: {
            restartPolicy: 'Never',
            containers: [
              {
                name: 'smoke',
                image: 'curlimages/curl:8.17.0',
                args: [
                  '--fail',
                  '--silent',
                  '--show-error',
                  target.internalReadyUrl,
                ],
                securityContext: {
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ['ALL'] },
                },
              },
            ],
          },
        },
      },
    };
    const job = await this.request<Job>(
      `/apis/batch/v1/namespaces/${target.namespace}/jobs`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    return job.metadata?.name || 'unknown';
  }

  async getPath<T = unknown>(path: string): Promise<T> {
    return this.request<T>(path);
  }

  async patchMergePath<T = unknown>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, {
      method: 'PATCH',
      headers: { 'content-type': 'application/merge-patch+json' },
      body: JSON.stringify(body),
    });
  }

  private async request<T = unknown>(
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    const response = await fetch(`${this.config.kubernetesApiBase}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token()}`,
        accept: 'application/json',
        ...(init.headers || {}),
      },
    });
    if (!response.ok) {
      throw new Error(
        `Kubernetes API ${response.status}: ${await response.text()}`,
      );
    }
    return (await response.json()) as T;
  }

  private async requestText(path: string): Promise<string> {
    const response = await fetch(`${this.config.kubernetesApiBase}${path}`, {
      headers: {
        authorization: `Bearer ${this.token()}`,
      },
    });
    if (!response.ok) {
      throw new Error(
        `Kubernetes API ${response.status}: ${await response.text()}`,
      );
    }
    return response.text();
  }

  private token(): string {
    return readFileSync(this.config.kubernetesTokenFile, 'utf8').trim();
  }
}
