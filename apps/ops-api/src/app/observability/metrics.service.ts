import { Injectable } from '@nestjs/common';

interface CounterKey {
  readonly actionId: string;
  readonly role: string;
  readonly status: string;
}

@Injectable()
export class MetricsService {
  private readonly counters = new Map<string, number>();
  private readonly durationSums = new Map<string, number>();
  private readonly durationCounts = new Map<string, number>();

  record(actionId: string, role: string, status: string, durationMs: number): void {
    const counterKey = key({ actionId, role, status });
    this.counters.set(counterKey, (this.counters.get(counterKey) || 0) + 1);

    const durationKey = key({ actionId, role, status: 'all' });
    this.durationSums.set(durationKey, (this.durationSums.get(durationKey) || 0) + durationMs / 1000);
    this.durationCounts.set(durationKey, (this.durationCounts.get(durationKey) || 0) + 1);
  }

  render(): string {
    const lines = [
      '# HELP lb_map_operations_action_runs_total Operations action runs by result.',
      '# TYPE lb_map_operations_action_runs_total counter',
    ];
    for (const [serialized, value] of this.counters.entries()) {
      const parsed = JSON.parse(serialized) as CounterKey;
      lines.push(
        `lb_map_operations_action_runs_total{action_id="${escapeLabel(parsed.actionId)}",role="${escapeLabel(parsed.role)}",status="${escapeLabel(parsed.status)}"} ${value}`
      );
    }

    lines.push(
      '# HELP lb_map_operations_action_duration_seconds Operations action duration.',
      '# TYPE lb_map_operations_action_duration_seconds summary'
    );
    for (const [serialized, value] of this.durationSums.entries()) {
      const parsed = JSON.parse(serialized) as CounterKey;
      const labels = `action_id="${escapeLabel(parsed.actionId)}",role="${escapeLabel(parsed.role)}"`;
      lines.push(`lb_map_operations_action_duration_seconds_sum{${labels}} ${value}`);
      lines.push(
        `lb_map_operations_action_duration_seconds_count{${labels}} ${this.durationCounts.get(serialized) || 0}`
      );
    }

    return `${lines.join('\n')}\n`;
  }
}

function key(input: CounterKey): string {
  return JSON.stringify(input);
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}
