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

  login(username: string, password: string) {
    return this.http.post<MeResponse>('/api/auth/login', { username, password });
  }

  logout() {
    return this.http.post<{ ok: boolean }>('/api/auth/logout', {});
  }

  users() {
    return this.http.get<{ users: OpsUserSummary[] }>('/api/auth/users');
  }

  auditEvents(limit = 100) {
    return this.http.get<{ events: OpsAuditEvent[] }>(`/api/audit/events?limit=${limit}`);
  }

  createUser(input: {
    username: string;
    displayName: string;
    email?: string;
    password: string;
    role: string;
  }) {
    return this.http.post<{ user: OpsUserSummary }>('/api/auth/users', input);
  }

  resetPassword(username: string, password: string) {
    return this.http.post<{ user: OpsUserSummary }>(
      `/api/auth/users/${encodeURIComponent(username)}/reset-password`,
      { password }
    );
  }

  setUserActive(username: string, active: boolean) {
    return this.http.post<{ user: OpsUserSummary }>('/api/auth/users/set-active', {
      username,
      active,
    });
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

export interface OpsUserSummary {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly email?: string;
  readonly role: string;
  readonly active: boolean;
  readonly mustChangePassword: boolean;
}

export interface OpsAuditEvent {
  readonly id: string;
  readonly occurredAt: string;
  readonly actor?: string;
  readonly role?: string;
  readonly action: string;
  readonly targetApp?: string;
  readonly targetEnvironment?: string;
  readonly result: 'success' | 'failure' | 'rejected' | 'started';
  readonly runId?: string;
  readonly metadata: Record<string, string | number | boolean | null>;
}
