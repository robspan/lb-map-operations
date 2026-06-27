import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import {
  ActionRunRequest,
  ActionRunResponse,
  ActionsResponse,
  ContractsResponse,
  DiagnosisStreamEvent,
  MeResponse,
} from '@lb-map-operations/ops-contract';
import { Observable } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class OpsApiService {
  private readonly http = inject(HttpClient);

  me() {
    return this.http.get<MeResponse>('/api/me');
  }

  actions() {
    return this.http.get<ActionsResponse>('/api/actions');
  }

  contracts() {
    return this.http.get<ContractsResponse>('/api/contracts');
  }

  run(actionId: string, request: ActionRunRequest) {
    return this.http.post<ActionRunResponse>(`/api/actions/${actionId}/runs`, request);
  }

  /**
   * Streams the live diagnosis via Server-Sent Events. HttpClient does not handle SSE,
   * so we use fetch + a ReadableStream reader and parse the `data:` lines.
   */
  streamDiagnose(request: ActionRunRequest): Observable<DiagnosisStreamEvent> {
    return new Observable<DiagnosisStreamEvent>((subscriber) => {
      const controller = new AbortController();

      (async () => {
        try {
          const response = await fetch('/api/actions/diagnose-target/runs/stream', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(request),
            signal: controller.signal,
          });
          if (!response.ok || !response.body) {
            throw new Error(`HTTP ${response.status}`);
          }

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          for (;;) {
            const { value, done } = await reader.read();
            if (done) {
              break;
            }
            buffer += decoder.decode(value, { stream: true });
            let boundary = buffer.indexOf('\n\n');
            while (boundary !== -1) {
              const block = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              const dataLine = block.split('\n').find((line) => line.startsWith('data:'));
              if (dataLine) {
                try {
                  subscriber.next(JSON.parse(dataLine.slice(5).trim()));
                } catch {
                  // ignore malformed event
                }
              }
              boundary = buffer.indexOf('\n\n');
            }
          }
          subscriber.complete();
        } catch (error) {
          if (controller.signal.aborted) {
            subscriber.complete();
          } else {
            subscriber.error(error);
          }
        }
      })();

      return () => controller.abort();
    });
  }
}
