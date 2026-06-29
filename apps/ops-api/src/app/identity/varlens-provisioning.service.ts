import { BadRequestException, Injectable } from '@nestjs/common';
import {
  AppResourceStatus,
  TargetApp,
  TargetEnvironment,
} from '@lb-map-operations/ops-contract';
import { OpsConfigService } from '../config/ops-config.service';

export interface VarLensPlatformUserInput {
  readonly subject: string;
  readonly displayName: string;
  readonly role: string;
  readonly environment: TargetEnvironment;
  readonly privateDbSecretRef?: string;
  readonly resourceStatus?: AppResourceStatus;
  readonly publicAnnotationSnapshotId?: string;
}

@Injectable()
export class VarLensProvisioningService {
  constructor(private readonly config: OpsConfigService) {}

  async upsertPlatformUser(input: VarLensPlatformUserInput): Promise<void> {
    this.assertConfigured();
    if (input.role !== 'user' && input.role !== 'admin') {
      throw new BadRequestException('VarLens role must be user or admin');
    }
    const target = this.config.target('varlens' satisfies TargetApp, input.environment);
    const response = await fetch(`${target.internalBaseUrl}/platform/provisioning/users`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${this.config.varlensProvisioningToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        subject: input.subject,
        displayName: input.displayName,
        role: input.role,
        privateDbSecretRef: input.privateDbSecretRef,
        privateDbStatus: input.resourceStatus,
        publicAnnotationSnapshotId: input.publicAnnotationSnapshotId,
      }),
    });
    if (!response.ok) {
      throw new Error(`VarLens platform user provisioning failed with HTTP ${response.status}`);
    }
  }

  private assertConfigured(): void {
    if (!this.config.varlensProvisioningToken) {
      throw new Error('VarLens platform provisioning token is not configured');
    }
  }
}
