import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { describe, expect, it } from 'vitest';
import { testContext } from '../../connection/testing';
import type {
  CallToolResult,
  JSONRPCErrorResponse,
  JSONRPCRequest
} from '../../spec-types/draft';
import { DRAFT_PROTOCOL_VERSION, type ConformanceCheck } from '../../types';
import { ToolsCallSimpleTextScenario } from './tools';

/**
 * Issue #515: nonempty text can describe a failed tool invocation. Exercise
 * the scenario's real HTTP connection so that such results cannot pass as
 * successful text responses, independently of the request's arguments.
 */
type ToolResponse =
  | { result: CallToolResult }
  | Pick<JSONRPCErrorResponse, 'error'>;

async function runAgainstResponse(response: ToolResponse) {
  const requests: JSONRPCRequest[] = [];
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const request = JSON.parse(raw) as JSONRPCRequest;
      requests.push(request);
      res.writeHead('error' in response ? 400 : 200, {
        'Content-Type': 'application/json'
      });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...response }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;

  try {
    const checks = await new ToolsCallSimpleTextScenario().run(
      testContext(`http://127.0.0.1:${port}/mcp`, DRAFT_PROTOCOL_VERSION)
    );
    return { checks, requests };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

const textResult: CallToolResult = {
  resultType: 'complete',
  content: [
    { type: 'text', text: 'This is a simple text response for testing.' }
  ]
};

describe('tools-call-simple-text response and request regressions', () => {
  it.each<{
    name: string;
    response: ToolResponse;
    expectedStatus: ConformanceCheck['status'];
  }>([
    {
      name: 'accepts successful text with isError absent',
      response: { result: textResult },
      expectedStatus: 'SUCCESS'
    },
    {
      name: 'accepts successful text with isError false',
      response: { result: { ...textResult, isError: false } },
      expectedStatus: 'SUCCESS'
    },
    {
      name: 'rejects the same nonempty text with isError true',
      response: { result: { ...textResult, isError: true } },
      expectedStatus: 'FAILURE'
    },
    {
      name: 'rejects an unknown-tool error returned as nonempty text',
      response: {
        result: {
          ...textResult,
          isError: true,
          content: [{ type: 'text', text: 'Unknown tool: test_simple_text' }]
        }
      },
      expectedStatus: 'FAILURE'
    },
    {
      name: 'rejects a JSON-RPC unknown-tool error',
      response: {
        error: { code: -32602, message: 'Unknown tool: test_simple_text' }
      },
      expectedStatus: 'FAILURE'
    }
  ])('$name', async ({ response, expectedStatus }) => {
    const { checks, requests } = await runAgainstResponse(response);
    expect(checks).toHaveLength(1);
    const check = checks[0];
    expect(check.id).toBe('tools-call-simple-text');
    expect(check.status).toBe(expectedStatus);
    if ('result' in response) {
      expect(check.details?.result).toEqual(response.result);
      if (expectedStatus === 'FAILURE') {
        expect(check.errorMessage).toContain('Tool returned an error');
      }
    } else {
      expect(check.errorMessage).toContain(response.error.message);
    }
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('tools/call');
    expect(requests[0].params?.name).toBe('test_simple_text');
  });

  it('sends explicit empty arguments for the no-argument tool', async () => {
    const { checks, requests } = await runAgainstResponse({
      result: textResult
    });
    expect(checks[0]?.status).toBe('SUCCESS');
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('tools/call');
    expect(requests[0].params?.name).toBe('test_simple_text');
    expect(requests[0].params?.arguments).toEqual({});
  });
});
