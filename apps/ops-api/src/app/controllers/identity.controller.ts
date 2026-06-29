import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import {
  AppEntitlementDecisionResponse,
  AppEntitlementsResponse,
  AppResourceStatus,
  TargetApp,
  TargetEnvironment,
} from '@lb-map-operations/ops-contract';
import { OpsConfigService } from '../config/ops-config.service';
import { EntitlementsService } from '../identity/entitlements.service';
import { IdentityService } from '../identity/identity.service';
import { KeycloakAdminService } from '../identity/keycloak-admin.service';
import { VarLensProvisioningService } from '../identity/varlens-provisioning.service';
import { timingSafeEqual } from 'node:crypto';

@Controller('api/identity')
export class IdentityController {
  constructor(
    private readonly config: OpsConfigService,
    private readonly entitlements: EntitlementsService,
    private readonly identity: IdentityService,
    private readonly keycloak: KeycloakAdminService,
    private readonly varlensProvisioning: VarLensProvisioningService,
  ) {}

  @Get('entitlements/:app/:environment/:subject')
  async entitlementDecision(
    @Param('app') app: TargetApp,
    @Param('environment') environment: TargetEnvironment,
    @Param('subject') subject: string,
    @Req() request: Request,
  ): Promise<AppEntitlementDecisionResponse> {
    this.requireIntrospectionToken(request);
    return {
      entitlement: await this.entitlements.decision({ subject, app, environment }),
    };
  }

  @Get('admin/entitlements')
  async list(@Req() request: Request): Promise<AppEntitlementsResponse> {
    const principal = await this.identity.principalFromRequest(request);
    this.identity.requireRole(principal, 'admin');
    return { entitlements: await this.entitlements.list() };
  }

  @Post('admin/entitlements/grant')
  async grant(
    @Req() request: Request,
    @Body()
    body: {
      subject?: string;
      username?: string;
      app?: TargetApp;
      environment?: TargetEnvironment;
      role?: string;
      resourceStatus?: AppResourceStatus;
    },
  ) {
    const principal = await this.identity.principalFromRequest(request);
    this.identity.requireRole(principal, 'admin');
    if (!body.subject || !body.app || !body.environment || !body.role) {
      throw new BadRequestException('subject, app, environment and role are required');
    }
    return {
      entitlement: await this.entitlements.grant({
        subject: body.subject,
        username: body.username,
        app: body.app,
        environment: body.environment,
        role: body.role,
        resourceStatus: body.resourceStatus,
        actor: principal.user,
      }),
    };
  }

  @Post('admin/entitlements/resource-status')
  async setResourceStatus(
    @Req() request: Request,
    @Body()
    body: {
      subject?: string;
      app?: TargetApp;
      environment?: TargetEnvironment;
      resourceStatus?: AppResourceStatus;
    },
  ) {
    const principal = await this.identity.principalFromRequest(request);
    this.identity.requireRole(principal, 'admin');
    if (!body.subject || !body.app || !body.environment || !body.resourceStatus) {
      throw new BadRequestException('subject, app, environment and resourceStatus are required');
    }
    return {
      entitlement: await this.entitlements.setResourceStatus({
        subject: body.subject,
        app: body.app,
        environment: body.environment,
        resourceStatus: body.resourceStatus,
        actor: principal.user,
      }),
    };
  }

  @Post('admin/entitlements/revoke')
  async revoke(
    @Req() request: Request,
    @Body() body: { subject?: string; app?: TargetApp; environment?: TargetEnvironment },
  ) {
    const principal = await this.identity.principalFromRequest(request);
    this.identity.requireRole(principal, 'admin');
    if (!body.subject || !body.app || !body.environment) {
      throw new BadRequestException('subject, app and environment are required');
    }
    return {
      entitlement: await this.entitlements.revoke({
        subject: body.subject,
        app: body.app,
        environment: body.environment,
        actor: principal.user,
      }),
    };
  }

  @Post('admin/users/provision')
  async provisionUser(
    @Req() request: Request,
    @Body()
    body: {
      username?: string;
      email?: string;
      displayName?: string;
      temporaryPassword?: string;
      app?: TargetApp;
      environment?: TargetEnvironment;
      role?: string;
      resourceStatus?: AppResourceStatus;
      privateDbSecretRef?: string;
      publicAnnotationSnapshotId?: string;
    },
  ) {
    const principal = await this.identity.principalFromRequest(request);
    this.identity.requireRole(principal, 'admin');
    if (
      !body.username ||
      !body.temporaryPassword ||
      !body.app ||
      !body.environment ||
      !body.role
    ) {
      throw new BadRequestException(
        'username, temporaryPassword, app, environment and role are required',
      );
    }
    if (body.app !== 'varlens') {
      throw new BadRequestException('only VarLens provisioning is supported');
    }
    const username = body.username.toLowerCase();

    const platformUser = await this.keycloak.createOrResetUser({
      username,
      email: body.email,
      displayName: body.displayName,
      temporaryPassword: body.temporaryPassword,
      actor: principal.user,
    });
    await this.varlensProvisioning.upsertPlatformUser({
      subject: platformUser.subject,
      displayName: body.displayName || username,
      role: body.role,
      environment: body.environment,
      resourceStatus: body.resourceStatus || 'pending',
      privateDbSecretRef: body.privateDbSecretRef,
      publicAnnotationSnapshotId: body.publicAnnotationSnapshotId,
    });

    return {
      user: platformUser,
      entitlement: await this.entitlements.grant({
        subject: platformUser.subject,
        username,
        app: body.app,
        environment: body.environment,
        role: body.role,
        resourceStatus: body.resourceStatus,
        actor: principal.user,
      }),
    };
  }

  @Post('admin/users/reset-totp')
  async resetTotp(@Req() request: Request, @Body() body: { username?: string }) {
    const principal = await this.identity.principalFromRequest(request);
    this.identity.requireRole(principal, 'admin');
    if (!body.username) {
      throw new BadRequestException('username is required');
    }
    return { user: await this.keycloak.resetTotp(body.username, principal.user) };
  }

  @Post('admin/users/revoke-sessions')
  async revokeSessions(@Req() request: Request, @Body() body: { username?: string }) {
    const principal = await this.identity.principalFromRequest(request);
    this.identity.requireRole(principal, 'admin');
    if (!body.username) {
      throw new BadRequestException('username is required');
    }
    return { user: await this.keycloak.revokeSessions(body.username, principal.user) };
  }

  private requireIntrospectionToken(request: Request): void {
    if (!this.config.entitlementIntrospectionToken) {
      throw new ForbiddenException('entitlement introspection token is not configured');
    }
    const authorization = request.headers.authorization || '';
    const token = Array.isArray(authorization) ? authorization[0] : authorization;
    if (!tokenMatches(token, `Bearer ${this.config.entitlementIntrospectionToken}`)) {
      throw new ForbiddenException('invalid entitlement introspection token');
    }
  }
}

function tokenMatches(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
