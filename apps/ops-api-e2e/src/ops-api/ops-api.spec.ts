import axios from 'axios';

const firstLevelHeaders = {
  'x-forwarded-user': 'support@example.org',
  'x-forwarded-email': 'support@example.org',
  'x-forwarded-groups': 'lb-map-first-level',
};

describe('operations API', () => {
  it('returns health without identity headers', async () => {
    const res = await axios.get('/healthz');

    expect(res.status).toBe(200);
    expect(res.data).toEqual({ status: 'ok', service: 'lb-map-operations' });
  });

  it('filters actions for first-level support', async () => {
    const res = await axios.get('/api/actions', { headers: firstLevelHeaders });

    expect(res.status).toBe(200);
    const actionIds = res.data.actions.map(
      (action: { id: string }) => action.id,
    );
    expect(actionIds).toContain('diagnose-target');
    expect(actionIds).toContain('app-health');
    expect(actionIds).not.toContain('argo-sync');
    expect(actionIds).not.toContain('rollout-restart');
  });

  it('exposes the standardized app operations contracts to authenticated users', async () => {
    const res = await axios.get('/api/contracts', {
      headers: firstLevelHeaders,
    });

    expect(res.status).toBe(200);
    const contract = res.data.contracts.find(
      (item: { app: string; environment: string }) =>
        item.app === 'varlens' && item.environment === 'test',
    );
    expect(contract.endpoints.readinessPath).toBe('/readyz');
    expect(contract.firstLevel.evidenceSources).toContain('prometheus');
    expect(contract.observability.loki.requiredFields).toContain('request_id');
  });

  it('streams diagnosis progress and the final result', async () => {
    const res = await axios.post(
      '/api/actions/diagnose-target/runs/stream',
      {
        targetApp: 'varlens',
        targetEnvironment: 'test',
        inputs: { timeoutSeconds: '3' },
      },
      {
        headers: firstLevelHeaders,
        responseType: 'stream',
        timeout: 10_000,
      },
    );

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const body = await streamToString(res.data);
    expect(body).toContain('event: started');
    expect(body).toContain('event: step');
    expect(body).toContain('event: result');
    expect(body).toContain('"diagnosis"');
  });

  it('rejects unauthenticated action reads', async () => {
    await expect(axios.get('/api/actions')).rejects.toMatchObject({
      response: { status: 401 },
    });
  });

  it('rejects unsupported action inputs before execution', async () => {
    await expect(
      axios.post(
        '/api/actions/endpoint-check/runs',
        {
          targetApp: 'varlens',
          targetEnvironment: 'test',
          inputs: { command: 'kubectl get pods' },
        },
        { headers: firstLevelHeaders },
      ),
    ).rejects.toMatchObject({
      response: { status: 400 },
    });
  });
});

function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}
