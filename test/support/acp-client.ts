import {
  PROTOCOL_VERSION,
  client,
  type AgentApp,
  type ClientConnection,
  type InitializeResponse,
  type NewSessionRequest,
  type ReadTextFileRequest,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionUpdate,
  type StopReason,
} from '@agentclientprotocol/sdk';

/**
 * The editor half of the wire, for tests that
 * drive the fake agent without a process.
 *
 * The SDK can join a client app straight to an
 * agent app, so the conformance suite talks real
 * ACP — parsed params, real request/response
 * pairing, real notifications — with no pipe
 * between them. That is what keeps this half
 * honest: nothing here reaches into the agent's
 * state, so a test can only see what an editor
 * would see.
 *
 * It answers the way the extension answers, and
 * says so where that matters: `fs` capabilities
 * offered, no terminal, and a permission answer
 * shaped as the protocol requires.
 */

/** What the agent asked for, and what came back. */
export type Peer = {
  /** Every `session/update`, in arrival order. */
  updates: SessionUpdate[];

  /** Every permission question the agent asked. */
  questions: RequestPermissionRequest[];

  /** Every file the agent asked the editor to read. */
  reads: ReadTextFileRequest[];

  initialize(): Promise<InitializeResponse>;

  /** Opens a session and answers with its id. */
  open(request: NewSessionRequest): Promise<string>;

  prompt(sessionId: string, text: string): Promise<StopReason>;

  cancel(sessionId: string): Promise<void>;

  close(): void;
};

/**
 * How this peer answers the two requests an agent
 * can make of it. Both take the peer itself, so a
 * test can cancel the turn from inside the answer
 * — which is the only way to interleave a cancel
 * with a replay without a timer.
 */
export type PeerBehaviour = {
  answerPermission?: (
    request: RequestPermissionRequest,
    peer: Peer,
  ) => Promise<RequestPermissionResponse>;

  answerRead?: (
    request: ReadTextFileRequest,
    peer: Peer,
  ) => Promise<{ content: string }>;
};

/** What an unconfigured read answers with. */
export const STUB_FILE_CONTENT = 'export type Sermon = { title: string };\n';

export function drive(app: AgentApp, behaviour: PeerBehaviour = {}): Peer {
  const updates: SessionUpdate[] = [];
  const questions: RequestPermissionRequest[] = [];
  const reads: ReadTextFileRequest[] = [];

  const clientApp = client({ name: 'the conformance suite' })
    .onNotification('session/update', ({ params }) => {
      updates.push(params.update);
    })
    .onRequest('session/request_permission', async ({ params }) => {
      questions.push(params);

      if (behaviour.answerPermission !== undefined) {
        return await behaviour.answerPermission(params, peer);
      }

      const [first] = params.options;
      if (first === undefined) {
        throw new Error('the agent asked a question with no answers');
      }

      return { outcome: { outcome: 'selected', optionId: first.optionId } };
    })
    .onRequest('fs/read_text_file', async ({ params }) => {
      reads.push(params);

      return behaviour.answerRead === undefined
        ? { content: STUB_FILE_CONTENT }
        : await behaviour.answerRead(params, peer);
    });

  const connection: ClientConnection = clientApp.connect(app);

  const peer: Peer = {
    updates,
    questions,
    reads,

    initialize: () =>
      connection.agent.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: false,
        },
        clientInfo: { name: 'mBoss', version: '1' },
      }),

    open: async (request) => {
      const opened = await connection.agent.request('session/new', request);

      return opened.sessionId;
    },

    prompt: async (sessionId, text) => {
      const stopped = await connection.agent.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text }],
      });

      return stopped.stopReason;
    },

    cancel: (sessionId) =>
      connection.agent.notify('session/cancel', { sessionId }),

    close: () => connection.close(),
  };

  return peer;
}
