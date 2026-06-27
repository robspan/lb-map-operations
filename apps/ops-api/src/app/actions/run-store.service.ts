import { Injectable } from '@nestjs/common';
import { ActionRunResult } from '@lb-map-operations/ops-contract';

@Injectable()
export class RunStoreService {
  private readonly runs = new Map<string, ActionRunResult>();
  private readonly order: string[] = [];
  private readonly limit = 100;

  save(run: ActionRunResult): ActionRunResult {
    if (!this.runs.has(run.runId)) {
      this.order.push(run.runId);
    }
    this.runs.set(run.runId, run);
    this.prune();
    return run;
  }

  get(runId: string): ActionRunResult | undefined {
    return this.runs.get(runId);
  }

  private prune(): void {
    while (this.order.length > this.limit) {
      const runId = this.order.shift();
      if (runId) {
        this.runs.delete(runId);
      }
    }
  }
}
