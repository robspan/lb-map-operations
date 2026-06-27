import { Controller, Get, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { AuditEventSummary, AuditService } from '../audit/audit.service';
import { IdentityService } from '../identity/identity.service';

@Controller('api/audit')
export class AuditController {
  constructor(
    private readonly audit: AuditService,
    private readonly identity: IdentityService,
  ) {}

  @Get('events')
  async events(
    @Req() request: Request,
    @Query('limit') limit?: string,
  ): Promise<{ events: AuditEventSummary[] }> {
    const principal = await this.identity.principalFromRequest(request);
    this.identity.requireRole(principal, 'admin');
    const parsedLimit = Number(limit || 100);
    return {
      events: await this.audit.listRecent(Number.isFinite(parsedLimit) ? parsedLimit : 100),
    };
  }
}
