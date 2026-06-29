import { BadRequestException, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { OpsConfigService } from '../config/ops-config.service';

export interface PlatformUserInput {
  readonly username: string;
  readonly email?: string;
  readonly displayName?: string;
  readonly temporaryPassword: string;
  readonly resetExisting?: boolean;
  readonly actor: string;
}

export interface PlatformUserResult {
  readonly subject: string;
  readonly username: string;
}

interface KeycloakTokenResponse {
  readonly access_token?: string;
}

interface KeycloakUser {
  readonly id?: string;
  readonly username?: string;
  readonly enabled?: boolean;
  readonly email?: string;
  readonly firstName?: string;
  readonly lastName?: string;
  readonly requiredActions?: readonly string[];
}

interface KeycloakCredential {
  readonly id?: string;
  readonly type?: string;
}

@Injectable()
export class KeycloakAdminService {
  constructor(
    private readonly audit: AuditService,
    private readonly config: OpsConfigService,
  ) {}

  async createOrResetUser(input: PlatformUserInput): Promise<PlatformUserResult> {
    this.assertConfigured();
    this.validateUsername(input.username);
    if (input.temporaryPassword.length < 12) {
      throw new BadRequestException('temporaryPassword must be at least 12 characters');
    }

    const token = await this.adminToken();
    const existing = await this.findUser(input.username, token);
    if (existing?.id) {
      if (input.resetExisting !== true) {
        throw new BadRequestException('Keycloak user already exists');
      }
      await this.updateUser(existing.id, input, token);
      await this.resetPassword(existing.id, input.temporaryPassword, token);
      await this.deleteTotpCredentials(existing.id, token);
      await this.logoutUser(existing.id, token);
      await this.audit.record({
        actor: input.actor,
        action: 'identity_user_reset',
        result: 'success',
        metadata: { subject: existing.id, username: input.username },
      });
      return { subject: existing.id, username: input.username };
    }

    await this.createUser(input, token);
    const created = await this.findUser(input.username, token);
    if (!created?.id) {
      throw new Error('created Keycloak user could not be read back');
    }
    await this.audit.record({
      actor: input.actor,
      action: 'identity_user_create',
      result: 'success',
      metadata: { subject: created.id, username: input.username },
    });
    return { subject: created.id, username: input.username };
  }

  async resetTotp(username: string, actor: string): Promise<PlatformUserResult> {
    this.assertConfigured();
    const token = await this.adminToken();
    const user = await this.findUser(username, token);
    if (!user?.id) {
      throw new BadRequestException('Keycloak user not found');
    }
    await this.deleteTotpCredentials(user.id, token);
    await this.setRequiredActions(user, ['CONFIGURE_TOTP'], token);
    await this.logoutUser(user.id, token);
    await this.audit.record({
      actor,
      action: 'identity_totp_reset',
      result: 'success',
      metadata: { subject: user.id, username },
    });
    return { subject: user.id, username };
  }

  async subjectForUsername(username: string): Promise<PlatformUserResult> {
    this.assertConfigured();
    const token = await this.adminToken();
    const user = await this.findUser(username, token);
    if (!user?.id) {
      throw new BadRequestException('Keycloak user not found');
    }
    return { subject: user.id, username };
  }

  async ensureUserDoesNotExist(username: string): Promise<void> {
    this.assertConfigured();
    this.validateUsername(username);
    const token = await this.adminToken();
    const user = await this.findUser(username, token);
    if (user?.id) {
      throw new BadRequestException('Keycloak user already exists');
    }
  }

  async setUserEnabled(
    username: string,
    enabled: boolean,
    actor: string,
  ): Promise<PlatformUserResult> {
    this.assertConfigured();
    const token = await this.adminToken();
    const user = await this.findUser(username, token);
    if (!user?.id) {
      throw new BadRequestException('Keycloak user not found');
    }
    await this.setEnabled(user, enabled, token);
    if (!enabled) {
      await this.logoutUser(user.id, token);
    }
    await this.audit.record({
      actor,
      action: enabled ? 'identity_user_enable' : 'identity_user_disable',
      result: 'success',
      metadata: { subject: user.id, username },
    });
    return { subject: user.id, username };
  }

  async revokeSessions(username: string, actor: string): Promise<PlatformUserResult> {
    this.assertConfigured();
    const token = await this.adminToken();
    const user = await this.findUser(username, token);
    if (!user?.id) {
      throw new BadRequestException('Keycloak user not found');
    }
    await this.logoutUser(user.id, token);
    await this.audit.record({
      actor,
      action: 'identity_session_revoke',
      result: 'success',
      metadata: { subject: user.id, username },
    });
    return { subject: user.id, username };
  }

  async deleteUser(username: string, actor: string): Promise<PlatformUserResult> {
    this.assertConfigured();
    const token = await this.adminToken();
    const user = await this.findUser(username, token);
    if (!user?.id) {
      throw new BadRequestException('Keycloak user not found');
    }
    await this.deleteUserById(user.id, token);
    await this.audit.record({
      actor,
      action: 'identity_user_delete',
      result: 'success',
      metadata: { subject: user.id, username },
    });
    return { subject: user.id, username };
  }

  private assertConfigured(): void {
    if (
      !this.config.identityEnabled ||
      !this.config.identityAdminBaseUrl ||
      !this.config.identityRealm ||
      !this.config.identityAdminUsername ||
      !this.config.identityAdminPassword
    ) {
      throw new Error('Keycloak admin integration is not configured');
    }
  }

  private validateUsername(username: string): void {
    if (!/^[A-Za-z0-9._@+-]{1,160}$/.test(username)) {
      throw new BadRequestException('invalid username');
    }
  }

  private async adminToken(): Promise<string> {
    const body = new URLSearchParams();
    body.set('grant_type', 'password');
    body.set('client_id', 'admin-cli');
    body.set('username', this.config.identityAdminUsername);
    body.set('password', this.config.identityAdminPassword);

    const baseUrl = this.config.identityAdminBaseUrl.replace(/\/+$/, '');
    const realm = encodeURIComponent(this.config.identityRealm);
    const response = await fetch(`${baseUrl}/realms/${realm}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    if (!response.ok) {
      throw new Error(`Keycloak admin token request failed with HTTP ${response.status}`);
    }
    const json = (await response.json()) as KeycloakTokenResponse;
    if (!json.access_token) {
      throw new Error('Keycloak admin token response did not include access_token');
    }
    return json.access_token;
  }

  private adminUrl(path: string): string {
    return `${this.config.identityAdminBaseUrl.replace(/\/+$/, '')}/admin/realms/${encodeURIComponent(this.config.identityRealm)}${path}`;
  }

  private async findUser(username: string, token: string): Promise<KeycloakUser | undefined> {
    const url = new URL(this.adminUrl('/users'));
    url.searchParams.set('username', username);
    url.searchParams.set('exact', 'true');
    const response = await fetch(url, {
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new Error(`Keycloak user lookup failed with HTTP ${response.status}`);
    }
    const users = (await response.json()) as KeycloakUser[];
    const normalized = username.toLowerCase();
    return users.find((user) => user.username?.toLowerCase() === normalized);
  }

  private async createUser(input: PlatformUserInput, token: string): Promise<void> {
    const response = await fetch(this.adminUrl('/users'), {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        username: input.username,
        email: input.email || undefined,
        firstName: input.displayName || input.username,
        enabled: true,
        requiredActions: ['UPDATE_PASSWORD', 'CONFIGURE_TOTP'],
        credentials: [
          {
            type: 'password',
            value: input.temporaryPassword,
            temporary: true,
          },
        ],
      }),
    });
    if (!response.ok && response.status !== 409) {
      throw new Error(`Keycloak user create failed with HTTP ${response.status}`);
    }
  }

  private async updateUser(userId: string, input: PlatformUserInput, token: string): Promise<void> {
    const response = await fetch(this.adminUrl(`/users/${encodeURIComponent(userId)}`), {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        username: input.username,
        email: input.email || undefined,
        firstName: input.displayName || input.username,
        enabled: true,
        requiredActions: ['UPDATE_PASSWORD', 'CONFIGURE_TOTP'],
      }),
    });
    if (!response.ok) {
      throw new Error(`Keycloak user update failed with HTTP ${response.status}`);
    }
  }

  private async setEnabled(user: KeycloakUser, enabled: boolean, token: string): Promise<void> {
    if (!user.id) {
      throw new Error('Keycloak user id is required');
    }
    const response = await fetch(this.adminUrl(`/users/${encodeURIComponent(user.id)}`), {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ...user, enabled }),
    });
    if (!response.ok) {
      throw new Error(`Keycloak user enablement update failed with HTTP ${response.status}`);
    }
  }

  private async setRequiredActions(
    user: KeycloakUser,
    requiredActions: readonly string[],
    token: string,
  ): Promise<void> {
    if (!user.id) {
      throw new Error('Keycloak user id is required');
    }
    const response = await fetch(this.adminUrl(`/users/${encodeURIComponent(user.id)}`), {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ...user, requiredActions }),
    });
    if (!response.ok) {
      throw new Error(`Keycloak user required actions update failed with HTTP ${response.status}`);
    }
  }

  private async resetPassword(userId: string, temporaryPassword: string, token: string): Promise<void> {
    const response = await fetch(
      this.adminUrl(`/users/${encodeURIComponent(userId)}/reset-password`),
      {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ type: 'password', value: temporaryPassword, temporary: true }),
      },
    );
    if (!response.ok) {
      throw new Error(`Keycloak password reset failed with HTTP ${response.status}`);
    }
  }

  private async deleteTotpCredentials(userId: string, token: string): Promise<void> {
    const credentialsResponse = await fetch(
      this.adminUrl(`/users/${encodeURIComponent(userId)}/credentials`),
      { headers: { accept: 'application/json', authorization: `Bearer ${token}` } },
    );
    if (!credentialsResponse.ok) {
      throw new Error(`Keycloak credential lookup failed with HTTP ${credentialsResponse.status}`);
    }
    const credentials = (await credentialsResponse.json()) as KeycloakCredential[];
    for (const credential of credentials) {
      if (credential.type === 'otp' && credential.id) {
        const deleteResponse = await fetch(
          this.adminUrl(
            `/users/${encodeURIComponent(userId)}/credentials/${encodeURIComponent(credential.id)}`,
          ),
          { method: 'DELETE', headers: { authorization: `Bearer ${token}` } },
        );
        if (!deleteResponse.ok) {
          throw new Error(`Keycloak OTP credential delete failed with HTTP ${deleteResponse.status}`);
        }
      }
    }
  }

  private async logoutUser(userId: string, token: string): Promise<void> {
    const response = await fetch(this.adminUrl(`/users/${encodeURIComponent(userId)}/logout`), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok && response.status !== 204) {
      throw new Error(`Keycloak session revoke failed with HTTP ${response.status}`);
    }
  }

  private async deleteUserById(userId: string, token: string): Promise<void> {
    const response = await fetch(this.adminUrl(`/users/${encodeURIComponent(userId)}`), {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok && response.status !== 204) {
      throw new Error(`Keycloak user delete failed with HTTP ${response.status}`);
    }
  }
}
