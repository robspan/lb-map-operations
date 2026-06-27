import { Injectable } from '@nestjs/common';
import { AppOperationsContract } from '@lb-map-operations/ops-contract';

export interface PrometheusSeries {
  readonly labels: Record<string, string>;
  readonly value: number;
}

export interface PrometheusMetricObservation {
  readonly name: string;
  readonly description: string;
  readonly query: string;
  readonly status: 'ok' | 'empty' | 'error';
  readonly series: readonly PrometheusSeries[];
  readonly error?: string;
}

interface PrometheusQueryResponse {
  readonly status?: string;
  readonly error?: string;
  readonly data?: {
    readonly result?: readonly {
      readonly metric?: Record<string, string>;
      readonly value?: readonly [number, string];
    }[];
  };
}

@Injectable()
export class PrometheusClient {
  async contractMetrics(
    contract: AppOperationsContract,
    timeoutMs: number,
  ): Promise<readonly PrometheusMetricObservation[]> {
    const baseUrl = contract.observability.prometheusBaseUrl;
    if (!baseUrl) {
      return [];
    }

    const observations = await Promise.all(
      contract.observability.prometheusMetrics.map(async (metric) => {
        try {
          const result = await this.query(baseUrl, metric.sampleQuery, timeoutMs);
          return {
            name: metric.name,
            description: metric.description,
            query: metric.sampleQuery,
            status: result.length ? 'ok' : 'empty',
            series: result,
          } satisfies PrometheusMetricObservation;
        } catch (error) {
          return {
            name: metric.name,
            description: metric.description,
            query: metric.sampleQuery,
            status: 'error',
            series: [],
            error: message(error),
          } satisfies PrometheusMetricObservation;
        }
      }),
    );
    if (
      observations.length > 0 &&
      observations.every((observation) => observation.status === 'error')
    ) {
      throw new Error(
        observations[0].error || 'all Prometheus metric queries failed',
      );
    }
    return observations;
  }

  private async query(
    baseUrl: string,
    query: string,
    timeoutMs: number,
  ): Promise<readonly PrometheusSeries[]> {
    const url = new URL('/api/v1/query', normalizeBaseUrl(baseUrl));
    url.searchParams.set('query', query);
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`Prometheus API ${response.status}: ${await response.text()}`);
    }

    const payload = (await response.json()) as PrometheusQueryResponse;
    if (payload.status && payload.status !== 'success') {
      throw new Error(payload.error || `Prometheus query failed: ${payload.status}`);
    }

    return (payload.data?.result || []).map((item) => ({
      labels: item.metric || {},
      value: Number(item.value?.[1] || 0),
    }));
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
