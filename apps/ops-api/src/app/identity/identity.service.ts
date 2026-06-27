import { Injectable, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { OpsPrincipal, OpsRole, roleAllows } from '@lb-map-operations/ops-contract';
import { AuthService } from '../auth/auth.service';
import { OpsConfigService } from '../config/ops-config.service';

@Injectable()
export class IdentityService {
  constructor(
    private readonly auth: AuthService,
    private readonly config: OpsConfigService,
  ) {}

  async principalFromRequest(request: Request): Promise<OpsPrincipal> {
    const sessionPrincipal = await this.auth.principalForSessionToken(
      cookieValue(request, this.config.sessionCookieName),
    );
    if (sessionPrincipal) {
      return sessionPrincipal;
    }

    if (process.env.NODE_ENV === 'production') {
      throw new UnauthorizedException('authentication required');
    }

    const user = headerValue(request, 'x-forwarded-user');
    const email = headerValue(request, 'x-forwarded-email');
    const groups = splitGroups(headerValue(request, 'x-forwarded-groups'));

    if (user) {
      return {
        user,
        email: email || undefined,
        groups,
        roles: this.rolesForGroups(groups),
      };
    }

    if (this.config.devAuthUser) {
      return {
        user: this.config.devAuthUser,
        email: this.config.devAuthEmail || undefined,
        groups: this.config.devAuthGroups,
        roles: this.rolesForGroups(this.config.devAuthGroups),
      };
    }

    throw new UnauthorizedException('missing trusted identity headers');
  }

  requireRole(principal: OpsPrincipal, role: OpsRole): void {
    if (!roleAllows(principal.roles, role)) {
      throw new UnauthorizedException(`role ${role} is required`);
    }
  }

  primaryRole(principal: OpsPrincipal): OpsRole {
    if (roleAllows(principal.roles, 'admin')) {
      return 'admin';
    }
    if (roleAllows(principal.roles, 'operator')) {
      return 'operator';
    }
    return 'first-level';
  }

  private rolesForGroups(groups: readonly string[]): OpsRole[] {
    const roles: OpsRole[] = [];
    if (intersects(groups, this.config.firstLevelGroups)) {
      roles.push('first-level');
    }
    if (intersects(groups, this.config.operatorGroups)) {
      roles.push('operator');
    }
    if (intersects(groups, this.config.adminGroups)) {
      roles.push('admin');
    }
    return roles;
  }
}

export function cookieValue(request: Request, name: string): string {
  const raw = headerValue(request, 'cookie');
  if (!raw) {
    return '';
  }
  const prefix = `${name}=`;
  for (const item of raw.split(';')) {
    const trimmed = item.trim();
    if (trimmed.startsWith(prefix)) {
      return decodeURIComponent(trimmed.slice(prefix.length));
    }
  }
  return '';
}

function headerValue(request: Request, name: string): string {
  const value = request.headers[name];
  if (Array.isArray(value)) {
    return value[0] || '';
  }
  return value || '';
}

function splitGroups(value: string): string[] {
  return value
    .split(/[,\s;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function intersects(left: readonly string[], right: readonly string[]): boolean {
  return left.some((item) => right.includes(item));
}
