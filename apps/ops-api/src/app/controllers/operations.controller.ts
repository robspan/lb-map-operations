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
  DiagnosisRepairResponse,
  MeResponse,
  TargetApp,
  TargetEnvironment,
  VarLensUsersResponse,
} from '@lb-map-operations/ops-contract';
import { IdentityService } from '../identity/identity.service';
import { visibleActions } from '../actions/action-registry';
import { ActionRunnerService } from '../actions/action-runner.service';
import { AppContractsService } from '../contracts/app-contracts.service';
import { OpsConfigService } from '../config/ops-config.service';

@Controller('api')
export class OperationsController {
  constructor(
    private readonly identity: IdentityService,
    private readonly runner: ActionRunnerService,
    private readonly contracts: AppContractsService,
    private readonly config: OpsConfigService,
  ) {}

  @Get('me')
  async me(@Req() request: Request): Promise<MeResponse> {
    return {
      principal: await this.identity.principalFromRequest(request),
      targetApp: this.config.targetApp,
      targetEnvironment: this.config.targetEnvironment,
    };
  }

  @Get('actions')
  async actions(@Req() request: Request): Promise<ActionsResponse> {
    const principal = await this.identity.principalFromRequest(request);
    return {
      actions: visibleActions(principal.roles),
    };
  }

  @Get('contracts')
  async contractsList(@Req() request: Request): Promise<ContractsResponse> {
    await this.identity.principalFromRequest(request);
    return {
      contracts: this.contracts.all(),
    };
  }

  @Get('apps/:targetApp/environments/:targetEnvironment/varlens-users')
  async varlensUsers(
    @Param('targetApp') targetApp: TargetApp,
    @Param('targetEnvironment') targetEnvironment: TargetEnvironment,
    @Req() request: Request,
  ): Promise<VarLensUsersResponse> {
    const principal = await this.identity.principalFromRequest(request);
    return {
      users: await this.runner.varlensUsers(
        targetApp,
        targetEnvironment,
        principal,
      ),
    };
  }

  @Post('actions/diagnose-target/runs/stream')
  @HttpCode(200)
  async streamDiagnosis(
    @Body() body: ActionRunRequest,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const principal = await this.identity.principalFromRequest(request);
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
    const principal = await this.identity.principalFromRequest(request);
    return {
      run: await this.runner.run(actionId, body, principal),
    };
  }

  @Post('diagnosis/repair')
  async repairDiagnosis(
    @Body() body: ActionRunRequest,
    @Req() request: Request,
  ): Promise<DiagnosisRepairResponse> {
    const principal = await this.identity.principalFromRequest(request);
    return this.runner.repairDiagnosis(body, principal);
  }

  @Post('diagnosis/repair/stream')
  @HttpCode(200)
  async streamDiagnosisRepair(
    @Body() body: ActionRunRequest,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const principal = await this.identity.principalFromRequest(request);
    response.setHeader('content-type', 'text/event-stream; charset=utf-8');
    response.setHeader('cache-control', 'no-cache, no-transform');
    response.setHeader('connection', 'keep-alive');
    response.flushHeaders?.();

    await this.runner.streamDiagnosisRepair(body, principal, (event) => {
      response.write(`event: ${event.type}\n`);
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    response.end();
  }

  @Get('runs/:runId')
  async runStatus(
    @Param('runId') runId: string,
    @Req() request: Request,
  ): Promise<ActionRunResponse> {
    await this.identity.principalFromRequest(request);
    return {
      run: this.runner.runStatus(runId),
    };
  }
}
