import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { OpsRole } from '@lb-map-operations/ops-contract';
import { AuditService } from '../audit/audit.service';
import { AuthService, UserSummary } from '../auth/auth.service';
import { OpsConfigService } from '../config/ops-config.service';
import { cookieValue, IdentityService } from '../identity/identity.service';

@Controller('api/auth')
export class AuthController {
  constructor(
    private readonly audit: AuditService,
    private readonly auth: AuthService,
    private readonly config: OpsConfigService,
    private readonly identity: IdentityService,
  ) {}

  @Post('login')
  async login(
    @Body() body: { username?: string; password?: string },
    @Res({ passthrough: true }) response: Response,
  ) {
    if (!body?.username || !body.password) {
      throw new BadRequestException('username and password are required');
    }
    const principal = await this.auth.authenticate(body.username, body.password);
    if (!principal) {
      throw new UnauthorizedException('invalid username or password');
    }
    const token = await this.auth.createSession(principal);
    response.setHeader('set-cookie', this.sessionCookie(token));
    return { principal };
  }

  @Post('logout')
  async logout(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await this.auth.deleteSession(cookieValue(request, this.config.sessionCookieName));
    response.setHeader('set-cookie', this.clearSessionCookie());
    return { ok: true };
  }

  @Get('users')
  async users(@Req() request: Request): Promise<{ users: UserSummary[] }> {
    const principal = await this.identity.principalFromRequest(request);
    this.identity.requireRole(principal, 'admin');
    return { users: await this.auth.listUsers() };
  }

  @Post('users')
  async createUser(
    @Req() request: Request,
    @Body()
    body: {
      username?: string;
      displayName?: string;
      email?: string;
      password?: string;
      role?: OpsRole;
    },
  ): Promise<{ user: UserSummary }> {
    const principal = await this.identity.principalFromRequest(request);
    this.identity.requireRole(principal, 'admin');
    const role = parseRole(body.role);
    if (!body.username || !body.password) {
      throw new BadRequestException('username and password are required');
    }
    const user = await this.auth.createUser({
      username: body.username,
      displayName: body.displayName || body.username,
      email: body.email,
      password: body.password,
      role,
    });
    await this.audit.record({
      actor: principal.user,
      role: this.identity.primaryRole(principal),
      action: 'auth-user-create',
      result: 'success',
      metadata: { username: user.username, assignedRole: user.role },
    });
    return { user };
  }

  @Post('users/reset-password')
  async resetPasswordBody(
    @Req() request: Request,
    @Body() body: { username?: string; password?: string },
  ): Promise<{ user: UserSummary }> {
    const principal = await this.identity.principalFromRequest(request);
    this.identity.requireRole(principal, 'admin');
    if (!body.username || !body.password) {
      throw new BadRequestException('username and password are required');
    }
    const user = await this.auth.resetPassword(body.username, body.password);
    await this.audit.record({
      actor: principal.user,
      role: this.identity.primaryRole(principal),
      action: 'auth-password-reset',
      result: 'success',
      metadata: { username: user.username },
    });
    return { user };
  }

  @Post('users/:username/reset-password')
  async resetPassword(
    @Req() request: Request,
    @Param('username') username: string,
    @Body() body: { password?: string },
  ): Promise<{ user: UserSummary }> {
    return this.resetPasswordBody(request, { username, password: body.password });
  }

  @Post('users/set-active')
  async setActive(
    @Req() request: Request,
    @Body() body: { username?: string; active?: boolean },
  ): Promise<{ user: UserSummary }> {
    const principal = await this.identity.principalFromRequest(request);
    this.identity.requireRole(principal, 'admin');
    if (!body.username || typeof body.active !== 'boolean') {
      throw new BadRequestException('username and active are required');
    }
    if (body.username === principal.user && !body.active) {
      throw new BadRequestException('cannot deactivate own user');
    }
    const user = await this.auth.setUserActive(body.username, body.active);
    await this.audit.record({
      actor: principal.user,
      role: this.identity.primaryRole(principal),
      action: body.active ? 'auth-user-activate' : 'auth-user-deactivate',
      result: 'success',
      metadata: { username: user.username },
    });
    return { user };
  }

  private sessionCookie(token: string): string {
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    return `${this.config.sessionCookieName}=${encodeURIComponent(
      token,
    )}; Path=/; HttpOnly; SameSite=Strict${secure}; Max-Age=${this.config.sessionMaxAgeSeconds}`;
  }

  private clearSessionCookie(): string {
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    return `${this.config.sessionCookieName}=; Path=/; HttpOnly; SameSite=Strict${secure}; Max-Age=0`;
  }
}

function parseRole(role: unknown): OpsRole {
  if (role === 'first-level' || role === 'operator' || role === 'admin') {
    return role;
  }
  throw new BadRequestException('invalid role');
}
