import { Injectable, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { OpsPrincipal, OpsRole, roleAllows } from '@lb-map-operations/ops-contract';
import { OpsConfigService } from '../config/ops-config.service';

@Injectable()
export class IdentityService {
  constructor(private readonly config: OpsConfigService) {}

  principalFromRequest(request: Request): OpsPrincipal {
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

    if (process.env.NODE_ENV !== 'production' && this.config.devAuthUser) {
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
