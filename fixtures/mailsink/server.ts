import { randomUUID } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type RequestListener,
  type ServerResponse,
} from 'node:http';
import { pathToFileURL } from 'node:url';

/**
 * A fake Twilio Email API, and an inbox the suite
 * can read.
 *
 * Two surfaces in one server. `/v1/*` is the
 * provider's: the worker's mailer posts sends to
 * it and its delivery-status reader polls it, both
 * under the Basic auth the real API wants, and
 * both shaped exactly as the shipped code expects.
 * Everything else is the harness talking to its
 * own fixture — read the captured mail, empty it,
 * slow it down — and needs no credentials.
 *
 * No dependencies and no build step: `node
 * server.ts` runs this file as it stands, so the
 * bytes the container serves are the bytes the
 * unit tests import.
 */

export type MailsinkConfig = {
  apiKey: string;
  apiSecret: string;
  /**
   * The origin the provider names in
   * `operationLocation` — the container's address
   * on the compose network, not the host's.
   */
  publicBaseUrl: string;
  /**
   * A recipient whose local part starts with this
   * bounces. It is how a spec asks for a bounce
   * without waiting on anything real.
   */
  bouncePrefix: string;
};

export type DeliveryStatus = 'DELIVERED' | 'UNDELIVERED';

export type CapturedMessage = {
  id: string;
  operationId: string;
  to: string;
  from: string;
  subject: string;
  html: string;
  headers: Record<string, string>;
  receivedAt: string;
  status: DeliveryStatus;
};

export function createMailsink(config: MailsinkConfig): RequestListener {
  const expectedAuth = `Basic ${Buffer.from(
    `${config.apiKey}:${config.apiSecret}`,
  ).toString('base64')}`;

  /**
   * Insertion order is the answer to "oldest
   * first", and it stays right where two sends
   * land in the same millisecond — which a
   * 40-recipient fan-out over loopback does.
   */
  const messages: CapturedMessage[] = [];
  let sendDelayMs = 0;

  async function acceptSend(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = await readJson(request);
    if (body === undefined)
      return json(response, 400, { message: 'body is not JSON' });

    const send = body as {
      from?: { address?: unknown };
      to?: { address?: unknown }[];
      content?: { subject?: unknown; html?: unknown; headers?: unknown };
    };

    const to = send.to?.[0]?.address;
    const subject = send.content?.subject;
    // A mailer that stopped addressing its mail,
    // or stopped titling it, has to go red at the
    // send. Capturing it silently would leave the
    // suite green over a wire regression.
    if (typeof to !== 'string' || to === '')
      return json(response, 400, { message: 'to[0].address is required' });
    if (typeof subject !== 'string' || subject === '')
      return json(response, 400, { message: 'content.subject is required' });

    if (sendDelayMs > 0) await sleep(sendDelayMs);

    const operationId = randomUUID();
    messages.push({
      id: randomUUID(),
      operationId,
      to,
      from:
        typeof send.from?.address === 'string' ? send.from.address : 'unknown',
      subject,
      html: typeof send.content?.html === 'string' ? send.content.html : '',
      headers: headersOf(send.content?.headers),
      receivedAt: new Date().toISOString(),
      status: to.startsWith(config.bouncePrefix) ? 'UNDELIVERED' : 'DELIVERED',
    });

    json(response, 202, {
      operationId,
      operationLocation:
        `${config.publicBaseUrl}/v1/Emails` +
        `?operationId=${encodeURIComponent(operationId)}`,
    });
  }

  /**
   * The status reader asks for the emails an
   * operation sent, not the operation's aggregate
   * counts. Every mBoss send is single-recipient,
   * so one page is the whole answer — and an
   * operation nobody has heard of yet answers with
   * an empty list, which the reader treats as
   * pending.
   */
  function operationStatus(url: URL, response: ServerResponse): void {
    const operationId = url.searchParams.get('operationId') ?? '';
    const matches = messages.filter(
      (message) => message.operationId === operationId,
    );

    json(response, 200, {
      emails: matches.slice(0, pageSize(url)).map((message) => ({
        status: message.status,
        to: message.to,
        operationId: message.operationId,
      })),
    });
  }

  function listMessages(url: URL, response: ServerResponse): void {
    const to = url.searchParams.get('to');
    const subject = url.searchParams.get('subject');
    const since = url.searchParams.get('since');
    const sinceMs = since === null ? undefined : Date.parse(since);
    if (sinceMs !== undefined && Number.isNaN(sinceMs))
      return json(response, 400, { message: `since is not a date: ${since}` });

    json(response, 200, {
      messages: messages.filter(
        (message) =>
          (to === null || message.to === to) &&
          (subject === null || message.subject === subject) &&
          (sinceMs === undefined || Date.parse(message.receivedAt) >= sinceMs),
      ),
    });
  }

  async function setDelay(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = (await readJson(request)) as { ms?: unknown } | undefined;
    const ms = body?.ms;
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0)
      return json(response, 400, { message: 'ms must be a number ≥ 0' });

    sendDelayMs = ms;
    noContent(response);
  }

  async function route(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://mailsink');
    const path = url.pathname;
    const method = request.method ?? 'GET';

    if (
      path.startsWith('/v1/') &&
      request.headers.authorization !== expectedAuth
    )
      return json(response, 401, { message: 'unauthorized' });

    if (method === 'POST' && path === '/v1/Emails')
      return await acceptSend(request, response);
    if (method === 'GET' && path === '/v1/Emails')
      return operationStatus(url, response);
    if (method === 'GET' && path === '/messages')
      return listMessages(url, response);
    if (method === 'DELETE' && path === '/messages') {
      messages.length = 0;
      sendDelayMs = 0;
      return noContent(response);
    }
    if (method === 'POST' && path === '/_test/delay')
      return await setDelay(request, response);
    if (method === 'GET' && path === '/health')
      return json(response, 200, { ok: true });

    json(response, 404, { message: `no route for ${method} ${path}` });
  }

  return (request, response) => {
    route(request, response).catch((error: unknown) => {
      json(response, 500, { message: String(error) });
    });
  };
}

function pageSize(url: URL): number {
  const raw = Number(url.searchParams.get('pageSize'));
  return Number.isInteger(raw) && raw > 0 ? raw : Number.MAX_SAFE_INTEGER;
}

function headersOf(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null) return {};

  const headers: Record<string, string> = {};
  for (const [name, header] of Object.entries(value))
    if (typeof header === 'string') headers[name] = header;

  return headers;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function noContent(response: ServerResponse): void {
  response.writeHead(204);
  response.end();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function main(): void {
  const port = Number(process.env.PORT ?? 8025);
  const server = createServer(
    createMailsink({
      apiKey: process.env.MAILSINK_API_KEY ?? 'SKe2e0000',
      apiSecret: process.env.MAILSINK_API_SECRET ?? 'e2e-twilio-secret',
      publicBaseUrl: process.env.PUBLIC_BASE_URL ?? `http://mailsink:${port}`,
      bouncePrefix: process.env.BOUNCE_PREFIX ?? 'bounce-',
    }),
  );

  server.listen(port, () => {
    console.log(`mailsink listening on ${port}`);
  });
}

const entryPoint = process.argv[1];
if (
  entryPoint !== undefined &&
  import.meta.url === pathToFileURL(entryPoint).href
)
  main();
