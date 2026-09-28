import { createWriteStream } from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';

export const FIXTURE_MARKER = '[mcp533 capacity fixture]';

function header(headers, name) {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value ?? null;
}

// Hop-by-hop framing belongs to each connection. In particular, keep Host and
// Origin unchanged: the CLI's DNS-rebinding probe must reach SDK validation.
function endToEndHeaders(headers) {
  const result = { ...headers };
  const connectionNames = String(headers.connection ?? '').split(',').map(s => s.trim().toLowerCase());
  for (const name of ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade', ...connectionNames]) delete result[name];
  return result;
}

/**
 * A single-client, loopback-only fixture in front of an unchanged SDK server.
 * Finite application/json request bodies are buffered to inspect method/id,
 * then forwarded byte-for-byte. No size limit, rewriting, or batch emulation is
 * added. Other request bodies and ALL response bodies are streamed, including
 * SSE. The only synthetic responses are cap denials and requested prompt errors.
 */
export async function startCapacityProxy({ target, eventsPath, rejectPrompts, cap = 4, scenario = () => null }) {
  const upstream = new URL(target);
  if (upstream.protocol !== 'http:' || upstream.hostname !== '127.0.0.1') {
    throw new Error('The capacity fixture requires an HTTP upstream on 127.0.0.1');
  }
  const journal = createWriteStream(eventsPath, { flags: 'wx' });
  const journalErrors = [];
  journal.on('error', error => journalErrors.push(String(error)));
  await once(journal, 'open');
  const started = process.hrtime.bigint();
  let sequence = 0;
  let requestSequence = 0;
  let stopping = false;
  let firstPromptRequest = null;
  const sessions = new Map();
  const live = new Set();
  const pendingInitializes = new Set();
  const openGets = new Map();
  const promptSessions = new Set();
  const sockets = new Set();
  const agent = new http.Agent({ keepAlive: true });
  const counts = {
    requests: 0, initializeRequests: 0, issuedSessionIds: 0,
    successfulDeleteResponses: 0, successfulDeleteReleases: 0,
    deleteRequests: 0, duplicateDeleteRequests: 0, unknownSessionDeletes: 0,
    fixtureCapDenials: 0, fixturePromptRejections: 0,
    maxLiveSessions: 0, maxLivePlusPendingInitializes: 0,
    getRequests: 0, getStreamsOpened: 0, getStreamsClosed: 0, maxOpenGetStreams: 0,
    sessionIdReissues: 0, upstreamFailures: 0, initializeWithoutSessionId: 0
  };
  function record(type, fields = {}) {
    const event = { sequence: ++sequence, time: new Date().toISOString(),
      elapsedMs: Number(process.hrtime.bigint() - started) / 1e6, type,
      teardown: stopping, ...fields };
    journal.write(JSON.stringify(event) + '\n');
    return event;
  }
  function occupancy() {
    counts.maxLiveSessions = Math.max(counts.maxLiveSessions, live.size);
    counts.maxLivePlusPendingInitializes = Math.max(counts.maxLivePlusPendingInitializes,
      live.size + pendingInitializes.size);
  }
  function snapshot(label) {
    const result = { label, ...counts, liveSessionIds: [...live],
      liveSessions: [...live].map(id => sessions.get(id)),
      pendingInitializeRequestIds: [...pendingInitializes], openGetStreams: [...openGets.values()],
      injectedPromptSessionIds: [...promptSessions], sessions: [...sessions.values()],
      firstPromptRequest,
      journalErrors: [...journalErrors] };
    record('snapshot', result);
    return structuredClone(result);
  }

  const server = http.createServer(async (req, res) => {
    const context = { requestId: ++requestSequence, scenario: scenario(),
      method: req.method, path: req.url, rpcMethod: null, rpcId: null,
      sessionId: header(req.headers, 'mcp-session-id'),
      host: header(req.headers, 'host'), origin: header(req.headers, 'origin') };
    counts.requests++;
    if (req.method === 'GET') counts.getRequests++;
    record('request-received', context);
    let requestBody;
    let rpc;
    let outgoing;
    let incoming;
    let admissionHeld = false;
    let getOpened = false;
    let getClosed = false;
    let responseStatus = null;
    let responseBytes = 0;
    let downstreamCancelled = false;
    let upstreamFailureCounted = false;
    const countUpstreamFailure = () => {
      if (!upstreamFailureCounted && !downstreamCancelled && !stopping) {
        upstreamFailureCounted = true;
        counts.upstreamFailures++;
      }
    };
    const releaseAdmission = reason => {
      if (!admissionHeld) return;
      admissionHeld = false;
      pendingInitializes.delete(context.requestId);
      record('initialize-admission-finished', { ...context, reason,
        liveSessions: live.size, pendingInitializes: pendingInitializes.size });
    };
    const closeGet = reason => {
      if (!getOpened || getClosed) return;
      getClosed = true;
      openGets.delete(context.requestId);
      counts.getStreamsClosed++;
      record('get-stream-close', { ...context, reason, status: responseStatus,
        responseBytes, openGetStreams: openGets.size });
    };
    res.once('finish', () => {
      closeGet('downstream-response-finished');
      record('response-finished', { ...context, status: responseStatus, responseBytes });
    });
    res.once('close', () => {
      closeGet(res.writableFinished ? 'downstream-finished-close' : 'downstream-disconnected');
      if (!res.writableFinished) {
        downstreamCancelled = true;
        record('downstream-disconnected', { ...context, status: responseStatus, responseBytes });
        incoming?.destroy();
        outgoing?.destroy();
        releaseAdmission('downstream-disconnected');
      }
    });
    req.once('aborted', () => {
      downstreamCancelled = true;
      outgoing?.destroy();
      releaseAdmission('request-aborted');
      record('request-aborted', context);
    });
    const fixtureResponse = (status, code, message, type) => {
      const body = JSON.stringify({ jsonrpc: '2.0', id: rpc?.id ?? null, error: { code, message } });
      responseStatus = status;
      responseBytes = Buffer.byteLength(body);
      record(type, { ...context, status, errorCode: code, message,
        liveSessions: live.size, pendingInitializes: pendingInitializes.size });
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': responseBytes });
      res.end(body);
    };
    try {
      if (req.method === 'POST' && /\bapplication\/(?:[\w.+-]+\+)?json\b/i.test(String(req.headers['content-type'] ?? ''))) {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        requestBody = Buffer.concat(chunks);
        try {
          const parsed = JSON.parse(requestBody.toString('utf8'));
          if (parsed && !Array.isArray(parsed) && typeof parsed === 'object') rpc = parsed;
          else record('json-request-not-single-object', { ...context, bytes: requestBody.length });
        } catch (error) {
          // Preserve malformed probes for SDK validation; do not synthesize an error.
          record('json-request-parse-error', { ...context, error: String(error), bytes: requestBody.length });
        }
        context.rpcMethod = typeof rpc?.method === 'string' ? rpc.method : null;
        context.rpcId = rpc?.id ?? null;
      }
      record('request-classified', { ...context, bufferedJsonBytes: requestBody?.length ?? null });
      if (res.destroyed || req.aborted) return;
      const requestSession = sessions.get(context.sessionId);
      if (requestSession && context.rpcMethod && !requestSession.observedRpcMethods.includes(context.rpcMethod)) {
        requestSession.observedRpcMethods.push(context.rpcMethod);
      }
      if (context.rpcMethod?.startsWith('prompts/') && !firstPromptRequest) {
        // HTTP is authoritative here. A stdout scenario marker can arrive on
        // another pipe after its initialize, so it is attribution only.
        firstPromptRequest = { ...context,
          otherLiveSessionIds: [...live].filter(id => id !== context.sessionId),
          pendingInitializeRequestIds: [...pendingInitializes] };
        record('first-prompt-request-observation', firstPromptRequest);
      }
      const isInitialize = req.method === 'POST' && context.rpcMethod === 'initialize' && !context.sessionId;
      if (isInitialize) {
        counts.initializeRequests++;
        if (live.size + pendingInitializes.size >= cap) {
          counts.fixtureCapDenials++;
          fixtureResponse(503, -32000, `${FIXTURE_MARKER} live issued-session cap ${cap} reached`, 'fixture-cap-denial');
          return;
        }
        pendingInitializes.add(context.requestId);
        admissionHeld = true;
        occupancy();
        record('initialize-admitted', { ...context, liveSessions: live.size,
          pendingInitializes: pendingInitializes.size });
      }
      if (rejectPrompts && req.method === 'POST' && context.rpcMethod?.startsWith('prompts/')) {
        counts.fixturePromptRejections++;
        if (context.sessionId) promptSessions.add(context.sessionId);
        fixtureResponse(200, -32601, `${FIXTURE_MARKER} disabled method ${context.rpcMethod}`, 'fixture-prompt-rejection');
        return;
      }
      if (req.method === 'DELETE') {
        counts.deleteRequests++;
        const session = sessions.get(context.sessionId);
        if (session) {
          session.deleteAttempts++;
          if (session.deleteAttempts > 1) {
            counts.duplicateDeleteRequests++;
            record('duplicate-delete', { ...context, attempt: session.deleteAttempts });
          }
        } else {
          counts.unknownSessionDeletes++;
          record('unknown-session-delete', context);
        }
      }
      outgoing = http.request({ hostname: upstream.hostname, port: upstream.port,
        method: req.method, path: req.url, headers: endToEndHeaders(req.headers), agent }, response => {
        incoming = response;
        responseStatus = response.statusCode ?? 502;
        const issuedId = header(response.headers, 'mcp-session-id');
        const successful = responseStatus >= 200 && responseStatus < 300;
        record('upstream-response-headers', { ...context, status: responseStatus,
          responseSessionId: issuedId, contentType: header(response.headers, 'content-type') });
        if (isInitialize) {
          // Count the authoritative SDK-issued header, even if the caller then
          // abandons the body. Do not infer releases from GET closure or exit.
          pendingInitializes.delete(context.requestId);
          admissionHeld = false;
          if (successful && issuedId) {
            if (sessions.has(issuedId)) {
              counts.sessionIdReissues++;
              record('session-id-reissued', { ...context, issuedSessionId: issuedId });
            } else {
              counts.issuedSessionIds++;
              sessions.set(issuedId, { sessionId: issuedId, initializeRequestId: context.requestId,
                issuedInScenario: context.scenario, clientName: rpc?.params?.clientInfo?.name ?? null,
                protocolVersionRequested: rpc?.params?.protocolVersion ?? null,
                observedRpcMethods: ['initialize'],
                deleteAttempts: 0, releasedByDelete: false, releaseRequestId: null });
            }
            live.add(issuedId);
            occupancy();
            record('session-issued', { ...context, issuedSessionId: issuedId,
              liveSessions: live.size, pendingInitializes: pendingInitializes.size });
          } else if (successful) {
            counts.initializeWithoutSessionId++;
            record('initialize-without-session-id', { ...context, status: responseStatus });
          }
          record('initialize-admission-finished', { ...context, reason: 'response-headers',
            liveSessions: live.size, pendingInitializes: pendingInitializes.size });
        }
        if (req.method === 'DELETE' && successful) {
          counts.successfulDeleteResponses++;
          const released = live.delete(context.sessionId);
          if (released) {
            counts.successfulDeleteReleases++;
            const session = sessions.get(context.sessionId);
            Object.assign(session, { releasedByDelete: true, releaseRequestId: context.requestId,
              releaseStatus: responseStatus, releasedInScenario: context.scenario });
          }
          record('successful-delete', { ...context, status: responseStatus,
            released, liveSessions: live.size });
        }
        if (req.method === 'GET' && successful &&
            String(response.headers['content-type'] ?? '').includes('text/event-stream')) {
          getOpened = true;
          counts.getStreamsOpened++;
          openGets.set(context.requestId, { ...context, status: responseStatus });
          counts.maxOpenGetStreams = Math.max(counts.maxOpenGetStreams, openGets.size);
          record('get-stream-open', { ...context, status: responseStatus, openGetStreams: openGets.size });
        }
        response.on('data', chunk => { responseBytes += chunk.length; });
        response.once('end', () => closeGet('upstream-response-ended'));
        response.once('aborted', () => {
          countUpstreamFailure();
          closeGet('upstream-response-aborted');
          record('upstream-response-aborted', { ...context, status: responseStatus, responseBytes });
          if (!res.destroyed) res.destroy();
        });
        response.once('error', error => {
          closeGet('upstream-response-error');
          countUpstreamFailure();
          record('upstream-response-error', { ...context, error: String(error), downstreamCancelled });
          if (!res.destroyed) res.destroy(error);
        });
        if (res.destroyed) {
          response.destroy();
          closeGet('downstream-already-disconnected');
          return;
        }
        res.writeHead(responseStatus, endToEndHeaders(response.headers));
        res.flushHeaders();
        response.pipe(res); // Preserve streaming and backpressure; never parse SSE.
      });
      outgoing.once('error', error => {
        releaseAdmission('upstream-request-error');
        countUpstreamFailure();
        record('upstream-request-error', { ...context, error: String(error), downstreamCancelled });
        if (!res.headersSent && !res.destroyed) {
          responseStatus = 502;
          res.writeHead(502, { 'content-type': 'text/plain' });
          res.end(`${FIXTURE_MARKER} upstream request failed`);
        } else if (!res.destroyed) res.destroy(error);
      });
      if (requestBody !== undefined) outgoing.end(requestBody);
      else req.pipe(outgoing);
    } catch (error) {
      releaseAdmission('request-handler-error');
      record('request-handler-error', { ...context, error: String(error), downstreamCancelled });
      if (!downstreamCancelled && !stopping) counts.upstreamFailures++;
      outgoing?.destroy();
      if (!res.headersSent && !res.destroyed) {
        responseStatus = 502;
        res.writeHead(502, { 'content-type': 'text/plain' });
        res.end(`${FIXTURE_MARKER} request handling failed`);
      } else if (!res.destroyed) res.destroy(error);
    }
  });
  server.requestTimeout = 0; // The CLI owns scenario timeouts; the runner owns its watchdog.
  server.timeout = 0;
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}${upstream.pathname}${upstream.search}`;
  record('fixture-started', { url, target, cap, rejectPrompts,
    ownership: 'Fixture admission cap and prompt errors; SDK server code is unchanged.' });
  return { url, snapshot, mark: (type, fields) => record(type, fields),
    async close() {
      stopping = true;
      record('fixture-teardown-started');
      const closed = new Promise(resolve => server.close(resolve));
      for (const socket of sockets) socket.destroy();
      agent.destroy();
      await closed;
      await new Promise(resolve => setImmediate(resolve));
      const final = snapshot('after-fixture-teardown');
      await new Promise(resolve => journal.end(resolve));
      return final;
    }
  };
}
