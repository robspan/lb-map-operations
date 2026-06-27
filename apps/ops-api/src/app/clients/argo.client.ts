import { Injectable } from '@nestjs/common';
import { KubernetesClient } from './kubernetes.client';
import { OpsConfigService, TargetConfig } from '../config/ops-config.service';

export interface ArgoResourceStatus {
  readonly kind?: string;
  readonly name?: string;
  readonly namespace?: string;
  readonly status?: string;
  readonly hookPhase?: string;
  readonly message?: string;
  readonly health?: {
    readonly status?: string;
    readonly message?: string;
  };
}

export interface ArgoApplicationStatus {
  readonly metadata?: {
    readonly name?: string;
  };
  readonly status?: {
    readonly health?: {
      readonly status?: string;
      readonly message?: string;
    };
    readonly sync?: {
      readonly status?: string;
      readonly revision?: string;
    };
    readonly operationState?: {
      readonly phase?: string;
      readonly message?: string;
      readonly syncResult?: {
        readonly resources?: readonly ArgoResourceStatus[];
      };
    };
    readonly resources?: readonly ArgoResourceStatus[];
  };
}

@Injectable()
export class ArgoClient {
  constructor(
    private readonly config: OpsConfigService,
    private readonly kubernetes: KubernetesClient
  ) {}

  async application(target: TargetConfig): Promise<ArgoApplicationStatus> {
    return this.kubernetes.getPath<ArgoApplicationStatus>(this.applicationPath(target));
  }

  async sync(target: TargetConfig): Promise<ArgoApplicationStatus> {
    return this.kubernetes.patchMergePath<ArgoApplicationStatus>(this.applicationPath(target), {
      operation: {
        sync: {
          prune: false,
          dryRun: false,
        },
      },
    });
  }

  private applicationPath(target: TargetConfig): string {
    return `/apis/argoproj.io/v1alpha1/namespaces/${this.config.argoNamespace}/applications/${target.argoApplication}`;
  }
}
