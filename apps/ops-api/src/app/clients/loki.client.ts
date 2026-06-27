import { Injectable } from '@nestjs/common';
import { AppOperationsContract } from '@lb-map-operations/ops-contract';

export interface LokiFieldCount {
  readonly value: string;
  readonly count: number;
}

export interface LokiLogObservation {
  readonly query: string;
  readonly entries: number;
  readonly errorEntries: number;
  readonly warningEntries: number;
  readonly failureClasses: readonly LokiFieldCount[];
  readonly errorCodes: readonly LokiFieldCount[];
}

interface LokiQueryRangeResponse {
  readonly status?: string;
  readonly error?: string;
  readonly data?: {
    readonly result?: readonly {
      readonly values?: readonly (readonly [string, string])[];
    }[];
  };
}

@Injectable()
export class LokiClient {
  async logSummary(
    contract: AppOperationsContract,
    timeoutMs: number,
  ): Promise<LokiLogObservation | undefined> {
    const baseUrl = contract.observability.lokiBaseUrl;
    if (!baseUrl) {
      return undefined;
    }

    const lines = await this.queryRange(
      baseUrl,
      contract.observability.loki.sampleQuery,
      timeoutMs,
    );
    return summarize(contract.observability.loki.sampleQuery, lines);
  }

  private async queryRange(
    baseUrl: string,
    query: string,
    timeoutMs: number,
  ): Promise<readonly string[]> {
    const nowNs = BigInt(Date.now()) * 1_000_000n;
    const startNs = nowNs - 30n * 60n * 1_000_000_000n;
    const url = new URL('/loki/api/v1/query_range', normalizeBaseUrl(baseUrl));
    url.searchParams.set('query', query);
    url.searchParams.set('direction', 'BACKWARD');
    url.searchParams.set('limit', '50');
    url.searchParams.set('start', startNs.toString());
    url.searchParams.set('end', nowNs.toString());

    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`Loki API ${response.status}: ${await response.text()}`);
    }

    const payload = (await response.json()) as LokiQueryRangeResponse;
    if (payload.status && payload.status !== 'success') {
      throw new Error(payload.error || `Loki query failed: ${payload.status}`);
    }

    return (payload.data?.result || []).flatMap((stream) =>
      (stream.values || []).map((entry) => entry[1]),
    );
  }
}

function summarize(query: string, lines: readonly string[]): LokiLogObservation {
  let errorEntries = 0;
  let warningEntries = 0;
  const failureClasses = new Map<string, number>();
  const errorCodes = new Map<string, number>();

  for (const line of lines) {
    const parsed = parseLogLine(line);
    const level = String(parsed.level || parsed.severity || '').toLowerCase();
    const status = Number(parsed.status || 0);
    const result = String(parsed.result || '').toLowerCase();
    if (
      level === 'error' ||
      result === 'failed' ||
      result === 'error' ||
      status >= 500
    ) {
      errorEntries += 1;
    } else if (level === 'warn' || level === 'warning' || status >= 400) {
      warningEntries += 1;
    }

    countField(failureClasses, parsed.failure_class);
    countField(errorCodes, parsed.error_code);
  }

  return {
    query,
    entries: lines.length,
    errorEntries,
    warningEntries,
    failureClasses: topCounts(failureClasses),
    errorCodes: topCounts(errorCodes),
  };
}

function parseLogLine(line: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(line) as unknown;
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function countField(counts: Map<string, number>, value: unknown): void {
  if (!value) {
    return;
  }
  const key = String(value);
  counts.set(key, (counts.get(key) || 0) + 1);
}

function topCounts(counts: Map<string, number>): readonly LokiFieldCount[] {
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 5)
    .map(([value, count]) => ({ value, count }));
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
}
