import { Controller, Get, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { AuditEventPage, AuditService } from '../audit/audit.service';
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
    @Query('offset') offset?: string,
  ): Promise<AuditEventPage> {
    const principal = await this.identity.principalFromRequest(request);
    this.identity.requireRole(principal, 'admin');
    const parsedLimit = Number(limit || 25);
    const parsedOffset = Number(offset || 0);
    return this.audit.listRecent(
      Number.isFinite(parsedLimit) ? parsedLimit : 25,
      Number.isFinite(parsedOffset) ? parsedOffset : 0,
    );
  }
}
