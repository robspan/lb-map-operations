import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { Request, Response } from 'express';
import {
  ActionRunRequest,
  ActionRunResponse,
  ActionsResponse,
  ContractsResponse,
  MeResponse,
} from '@lb-map-operations/ops-contract';
import { IdentityService } from '../identity/identity.service';
import { visibleActions } from '../actions/action-registry';
import { ActionRunnerService } from '../actions/action-runner.service';
import { AppContractsService } from '../contracts/app-contracts.service';

@Controller('api')
export class OperationsController {
  constructor(
    private readonly identity: IdentityService,
    private readonly runner: ActionRunnerService,
    private readonly contracts: AppContractsService,
  ) {}

  @Get('me')
  me(@Req() request: Request): MeResponse {
    return {
      principal: this.identity.principalFromRequest(request),
    };
  }

  @Get('actions')
  actions(@Req() request: Request): ActionsResponse {
    const principal = this.identity.principalFromRequest(request);
    return {
      actions: visibleActions(principal.roles),
    };
  }

  @Get('contracts')
  contractsList(@Req() request: Request): ContractsResponse {
    this.identity.principalFromRequest(request);
    return {
      contracts: this.contracts.all(),
    };
  }

  @Post('actions/diagnose-target/runs/stream')
  @HttpCode(200)
  async streamDiagnosis(
    @Body() body: ActionRunRequest,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const principal = this.identity.principalFromRequest(request);
    response.setHeader('content-type', 'text/event-stream; charset=utf-8');
    response.setHeader('cache-control', 'no-cache, no-transform');
    response.setHeader('connection', 'keep-alive');
    response.flushHeaders?.();

    await this.runner.streamDiagnosis(body, principal, (event) => {
      response.write(`event: ${event.type}\n`);
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    response.end();
  }

  @Post('actions/:actionId/runs')
  async run(
    @Param('actionId') actionId: string,
    @Body() body: ActionRunRequest,
    @Req() request: Request,
  ): Promise<ActionRunResponse> {
    const principal = this.identity.principalFromRequest(request);
    return {
      run: await this.runner.run(actionId, body, principal),
    };
  }

  @Get('runs/:runId')
  runStatus(@Param('runId') runId: string): ActionRunResponse {
    return {
      run: this.runner.runStatus(runId),
    };
  }
}
