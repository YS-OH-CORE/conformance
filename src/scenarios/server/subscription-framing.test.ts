import { spawn, type ChildProcess } from 'child_process';
import { createServer, type AddressInfo } from 'net';
import path from 'path';
import { createParser } from 'eventsource-parser';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildStandardHeaders,
  withRequestMeta
} from '../../connection/stateless';
import type {
  JSONRPCNotification,
  SubscriptionFilter
} from '../../spec-types/draft';
import { DRAFT_PROTOCOL_VERSION } from '../../types';

/**
 * Issue #531: exercise the real everything-server with an SSE parser that
 * rejects raw NDJSON, which the conformance scenario's stream reader accepts.
 */
const ACKNOWLEDGED = 'notifications/subscriptions/acknowledged';
const SUBSCRIPTION_ID = 'io.modelcontextprotocol/subscriptionId';
const TOOLS_CHANGED = 'notifications/tools/list_changed';
const PROMPTS_CHANGED = 'notifications/prompts/list_changed';

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, () => {
      const port = (server.address() as AddressInfo).port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

describe('everything-server subscription SSE framing', () => {
  let serverProcess: ChildProcess | undefined;
  let serverUrl: string;
  let controller: AbortController | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  beforeEach(async () => {
    const port = await getFreePort();
    serverUrl = `http://localhost:${port}/mcp`;
    const serverPath = path.join(
      process.cwd(),
      'examples/servers/typescript/everything-server.ts'
    );
    // Spawn the server directly so terminating this child also closes its
    // listening socket; an npx shell would introduce another process to kill.
    const proc = spawn(process.execPath, ['--import', 'tsx', serverPath], {
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    serverProcess = proc;

    await new Promise<void>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let ready = false;
      const timeout = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error(`Server failed to start within 30s: ${stderr}`));
      }, 30000);
      proc.stdout?.on('data', (data) => {
        stdout += data.toString();
        if (!ready && stdout.includes('running on')) {
          ready = true;
          clearTimeout(timeout);
          resolve();
        }
      });
      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });
      proc.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      proc.once('exit', (code, signal) => {
        clearTimeout(timeout);
        if (!ready) {
          reject(
            new Error(
              `Server exited before startup (${code ?? signal}): ${stderr}`
            )
          );
        }
      });
    });
  }, 35000);

  afterEach(async () => {
    controller?.abort();
    if (reader) {
      await reader.cancel().catch(() => {
        // Aborting fetch may already have errored the stream.
      });
      reader.releaseLock();
      reader = undefined;
    }
    controller = undefined;
    const proc = serverProcess;
    serverProcess = undefined;
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => proc.kill('SIGKILL'), 5000);
      proc.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
      proc.kill('SIGTERM');
    });
  });

  async function subscribe(id: string, notifications: SubscriptionFilter) {
    controller = new AbortController();
    const params = withRequestMeta({ notifications }, DRAFT_PROTOCOL_VERSION);
    const response = await fetch(serverUrl, {
      method: 'POST',
      headers: buildStandardHeaders('subscriptions/listen', params, {
        specVersion: DRAFT_PROTOCOL_VERSION
      }),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'subscriptions/listen',
        params
      }),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)])
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')?.split(';')[0]).toBe(
      'text/event-stream'
    );
    expect(response.body).not.toBeNull();
    const streamReader = response.body!.getReader();
    reader = streamReader;
    const pending: JSONRPCNotification[] = [];
    const decoder = new TextDecoder();
    const parser = createParser({
      onEvent(event) {
        expect(event.event ?? 'message').toBe('message');
        pending.push(JSON.parse(event.data) as JSONRPCNotification);
      },
      onError(error) {
        throw new Error(`Invalid subscription SSE framing: ${error.message}`);
      }
    });

    return async function nextFrame(): Promise<JSONRPCNotification> {
      while (pending.length === 0) {
        const { done, value } = await streamReader.read();
        if (done)
          throw new Error('Subscription ended before the next SSE event');
        parser.feed(decoder.decode(value, { stream: true }));
      }
      return pending.shift()!;
    };
  }

  async function trigger(kind: 'tools' | 'prompts') {
    const name =
      kind === 'tools'
        ? 'test_trigger_tool_change'
        : 'test_trigger_prompt_change';
    const id = `trigger-${kind}`;
    const params = withRequestMeta(
      { name, arguments: {} },
      DRAFT_PROTOCOL_VERSION
    );
    const response = await fetch(serverUrl, {
      method: 'POST',
      headers: buildStandardHeaders('tools/call', params, {
        specVersion: DRAFT_PROTOCOL_VERSION
      }),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params
      }),
      signal: AbortSignal.timeout(10000)
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.error).toBeUndefined();
    expect(body).toMatchObject({
      jsonrpc: '2.0',
      id,
      result: { resultType: 'complete', content: [{ type: 'text' }] }
    });
    expect(body.result.isError).not.toBe(true);
  }

  it('acknowledges first, then frames both list changes with the string subscription ID', async () => {
    const id = 'subscription-both';
    const filter = { toolsListChanged: true, promptsListChanged: true };
    const nextFrame = await subscribe(id, filter);
    const frames = [await nextFrame()];
    expect(frames[0].method).toBe(ACKNOWLEDGED);
    expect(frames[0].params?.notifications).toEqual(filter);

    await trigger('tools');
    frames.push(await nextFrame());
    await trigger('prompts');
    frames.push(await nextFrame());

    expect(frames.map((frame) => frame.method)).toEqual([
      ACKNOWLEDGED,
      TOOLS_CHANGED,
      PROMPTS_CHANGED
    ]);
    for (const frame of frames) {
      expect(frame.jsonrpc).toBe('2.0');
      expect(frame.params?._meta?.[SUBSCRIPTION_ID]).toBe(id);
    }
  });

  it.each([
    {
      requested: 'tools' as const,
      unrequested: 'prompts' as const,
      filter: { toolsListChanged: true },
      expectedMethod: TOOLS_CHANGED
    },
    {
      requested: 'prompts' as const,
      unrequested: 'tools' as const,
      filter: { promptsListChanged: true },
      expectedMethod: PROMPTS_CHANGED
    }
  ])('only delivers the requested $requested list change', async (testCase) => {
    const { requested, unrequested, filter, expectedMethod } = testCase;
    const id = `subscription-${requested}-only`;
    const nextFrame = await subscribe(id, filter);
    const frames = [await nextFrame()];
    expect(frames[0].method).toBe(ACKNOWLEDGED);
    expect(frames[0].params?.notifications).toEqual(filter);

    // Both mutation requests complete in order. The requested event is a
    // stream-order barrier, so an earlier out-of-filter event cannot hide
    // behind a time-window-based assertion that nothing arrived.
    await trigger(unrequested);
    await trigger(requested);
    do {
      frames.push(await nextFrame());
    } while (frames[frames.length - 1].method !== expectedMethod);

    expect(frames.map((frame) => frame.method)).toEqual([
      ACKNOWLEDGED,
      expectedMethod
    ]);
    for (const frame of frames) {
      expect(frame.jsonrpc).toBe('2.0');
      expect(frame.params?._meta?.[SUBSCRIPTION_ID]).toBe(id);
    }
  });
});
