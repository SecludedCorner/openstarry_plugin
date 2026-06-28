/**
 * agent-comm — expose cross-daemon agent↔agent messaging as the `agent.send`
 * and `agent.inbox` tools (Fractal Society, Tenet #10, C/T1).
 *
 * Five Aggregates Mapping: ITool (行蘊) whose actions are "message a peer agent"
 * and "read my inbox".
 *
 * Closes the Tenet #10 gap that the daemon comm layer (MessageRouter / channels /
 * EventBridge) validated messages but had NO transport — nothing delivered a
 * CommMessage to another agent's process. These tools consume the daemon's
 * SERVICE_KEYS.DAEMON_COMM service (registered by the daemon, backed by a real
 * line-delimited JSON-RPC transport that signs each message with the cluster
 * HMAC key and is fail-closed validated — capability + replay + freshness — on
 * receipt). Outside daemon mode the service is absent and the tools return a
 * clear daemon-only message rather than throwing.
 *
 * Honest scope (inherited from the transport): same-host, same-state-dir cluster
 * (1 daemon = 1 agent → agent↔agent is always cross-process). Cross-host /
 * N>2 gossip are future.
 *
 * Purity: imports @openstarry/sdk (+zod) only.
 */

import { z } from "zod";
import type { IPlugin, IPluginContext, PluginHooks, ITool } from "@openstarry/sdk";
import { SERVICE_KEYS } from "@openstarry/sdk";

const DAEMON_ONLY_SEND =
  "agent.send is unavailable: no daemon-comm service is registered. Cross-agent " +
  "messaging requires the agent to run under daemon mode (`daemon start`); in " +
  "foreground/CLI mode there is no peer daemon to deliver to.";

const DAEMON_ONLY_INBOX =
  "agent.inbox is unavailable: no daemon-comm service is registered. A cross-agent " +
  "inbox exists only under daemon mode (`daemon start`).";

const DAEMON_ONLY_SUBSCRIBE =
  "agent.subscribe is unavailable: no daemon-comm service is registered. Cluster " +
  "pub/sub requires daemon mode (`daemon start`).";

const DAEMON_ONLY_EVENTS =
  "agent.events is unavailable: no daemon-comm service is registered. Coordination " +
  "events exist only under daemon mode (`daemon start`).";

const DAEMON_ONLY_REGISTER =
  "agent.register is unavailable: no daemon-comm service is registered. Service " +
  "registration requires daemon mode (`daemon start`).";

const DAEMON_ONLY_FINDPEER =
  "agent.findPeer is unavailable: no daemon-comm service is registered. Service " +
  "discovery requires daemon mode (`daemon start`).";

const DAEMON_ONLY_REQUEST =
  "agent.request is unavailable: no daemon-comm service is registered. Request/reply " +
  "requires daemon mode (`daemon start`).";

const DAEMON_ONLY_REPLY =
  "agent.reply is unavailable: no daemon-comm service is registered. Request/reply " +
  "requires daemon mode (`daemon start`).";

const DAEMON_ONLY_BROADCAST =
  "agent.broadcast is unavailable: no daemon-comm service is registered. Broadcast " +
  "requires daemon mode (`daemon start`).";

const DAEMON_ONLY_PIPELINE =
  "agent.pipeline is unavailable: no daemon-comm service is registered. Pipeline " +
  "routing requires daemon mode (`daemon start`).";

/** The 8 FIPA-ACL speech acts carried by CommMessage.performative. */
const PERFORMATIVES = [
  "inform",
  "request",
  "agree",
  "refuse",
  "propose",
  "query-ref",
  "cfp",
  "failure",
] as const;

const sendSchema = z.object({
  target: z.string().min(1).describe("Peer agent id to deliver the message to"),
  payload: z.unknown().describe("JSON-serializable message body"),
  performative: z
    .enum(PERFORMATIVES)
    .optional()
    .describe("FIPA-ACL speech act (default 'inform')"),
});
type SendInput = z.infer<typeof sendSchema>;

const inboxSchema = z.object({
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Optional cap on the most recent messages to return"),
});
type InboxInput = z.infer<typeof inboxSchema>;

function createSendTool(ctx: IPluginContext): ITool<SendInput> {
  return {
    skandha: "samskara" as const,
    id: "agent.send",
    description:
      "Send a message to a PEER agent's daemon over the cross-daemon comm " +
      "transport (fractal society, Tenet #10). Requires daemon mode. The send is " +
      "subject to this agent's capability lattice (canSendTo) and the receiver's " +
      "(canReceiveFrom); the message is HMAC-signed so the sender cannot be " +
      "forged, and rejected on replay/staleness. `target` is the peer agent id, " +
      "`payload` is any JSON-serializable body, `performative` is the FIPA-ACL " +
      "speech act (default 'inform'). Returns the delivered message id on success.",
    parameters: sendSchema,
    async execute(input: SendInput): Promise<string> {
      const svc = ctx.services?.get(SERVICE_KEYS.DAEMON_COMM);
      if (!svc) return DAEMON_ONLY_SEND;
      try {
        const res = await svc.send({
          target: input.target,
          payload: input.payload,
          ...(input.performative !== undefined ? { performative: input.performative } : {}),
        });
        return `Delivered message ${res.messageId} to "${input.target}".`;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return `Send to "${input.target}" denied: ${reason}`;
      }
    },
  };
}

function createInboxTool(ctx: IPluginContext): ITool<InboxInput> {
  return {
    skandha: "samskara" as const,
    id: "agent.inbox",
    description:
      "Read messages this agent has received from peer agents over the " +
      "cross-daemon comm transport (fractal society, Tenet #10). Requires daemon " +
      "mode. `limit` optionally caps the result to the most recent N messages. " +
      "Returns each message's sender, speech act, time, and payload.",
    parameters: inboxSchema,
    async execute(input: InboxInput): Promise<string> {
      const svc = ctx.services?.get(SERVICE_KEYS.DAEMON_COMM);
      if (!svc) return DAEMON_ONLY_INBOX;
      const messages = await svc.readInbox(input.limit);
      if (messages.length === 0) return "Inbox is empty.";
      const lines = messages.map((m) => {
        const body = typeof m.payload === "string" ? m.payload : JSON.stringify(m.payload);
        const when = new Date(m.timestamp).toISOString();
        return `- [${m.performative ?? "inform"}] from ${m.source} at ${when}: ${body}`;
      });
      return `${messages.length} message(s):\n${lines.join("\n")}`;
    },
  };
}

const subscribeSchema = z.object({
  peerId: z.string().min(1).describe("Peer agent id whose lifecycle events to subscribe to"),
  eventTypes: z
    .array(z.string().min(1))
    .min(1)
    .describe("Coordination event types, e.g. ['agent:leaving','agent:status_changed']"),
});
type SubscribeInput = z.infer<typeof subscribeSchema>;

const eventsSchema = z.object({
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Optional cap on the most recent coordination events to return"),
});
type EventsInput = z.infer<typeof eventsSchema>;

function createSubscribeTool(ctx: IPluginContext): ITool<SubscribeInput> {
  return {
    skandha: "samskara" as const,
    id: "agent.subscribe",
    description:
      "Subscribe to a PEER agent's cluster lifecycle events (fractal society " +
      "pub/sub, Tenet #10 C/T2). Requires daemon mode. Registers THIS agent on " +
      "the peer's daemon; when the peer publishes one of `eventTypes` (e.g. " +
      "'agent:leaving', 'agent:status_changed') it is delivered back here and " +
      "readable via agent.events. The subscription is HMAC-signed.",
    parameters: subscribeSchema,
    async execute(input: SubscribeInput): Promise<string> {
      const svc = ctx.services?.get(SERVICE_KEYS.DAEMON_COMM);
      if (!svc) return DAEMON_ONLY_SUBSCRIBE;
      try {
        await svc.subscribe(input.peerId, input.eventTypes);
        return `Subscribed to ${input.eventTypes.join(", ")} from "${input.peerId}".`;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return `Subscribe to "${input.peerId}" failed: ${reason}`;
      }
    },
  };
}

function createEventsTool(ctx: IPluginContext): ITool<EventsInput> {
  return {
    skandha: "samskara" as const,
    id: "agent.events",
    description:
      "Read cluster coordination events this agent has received from peers it " +
      "subscribed to (fractal society pub/sub, Tenet #10 C/T2). Requires daemon " +
      "mode. `limit` optionally caps the result to the most recent N events.",
    parameters: eventsSchema,
    async execute(input: EventsInput): Promise<string> {
      const svc = ctx.services?.get(SERVICE_KEYS.DAEMON_COMM);
      if (!svc) return DAEMON_ONLY_EVENTS;
      const events = await svc.readEvents(input.limit);
      if (events.length === 0) return "No coordination events.";
      const lines = events.map((e) => {
        const when = new Date(e.timestamp).toISOString();
        const extra = e.payload !== undefined ? ` ${JSON.stringify(e.payload)}` : "";
        return `- ${e.type} from ${e.agentId} at ${when}${extra}`;
      });
      return `${events.length} event(s):\n${lines.join("\n")}`;
    },
  };
}

const registerSchema = z.object({
  registry: z.string().min(1).describe("Registry-hub agent id to register the service on"),
  serviceName: z.string().min(1).describe("Service name to advertise (e.g. 'echo', 'summarizer')"),
});
type RegisterInput = z.infer<typeof registerSchema>;

const findPeerSchema = z.object({
  registry: z.string().min(1).describe("Registry-hub agent id to resolve the service against"),
  serviceName: z.string().min(1).describe("Service name to discover providers for"),
});
type FindPeerInput = z.infer<typeof findPeerSchema>;

function createRegisterTool(ctx: IPluginContext): ITool<RegisterInput> {
  return {
    skandha: "samskara" as const,
    id: "agent.register",
    description:
      "Advertise THIS agent as a provider of a named service on a registry hub " +
      "(fractal society discovery, Tenet #10 C/T3). Requires daemon mode. Peers " +
      "can then discover and message this agent via agent.findPeer on the same " +
      "registry. The registration is HMAC-signed.",
    parameters: registerSchema,
    async execute(input: RegisterInput): Promise<string> {
      const svc = ctx.services?.get(SERVICE_KEYS.DAEMON_COMM);
      if (!svc) return DAEMON_ONLY_REGISTER;
      try {
        await svc.registerService(input.registry, input.serviceName);
        return `Registered service "${input.serviceName}" on registry "${input.registry}".`;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return `Register "${input.serviceName}" on "${input.registry}" failed: ${reason}`;
      }
    },
  };
}

function createFindPeerTool(ctx: IPluginContext): ITool<FindPeerInput> {
  return {
    skandha: "samskara" as const,
    id: "agent.findPeer",
    description:
      "Discover which agent(s) provide a named service, via a registry hub " +
      "(fractal society discovery, Tenet #10 C/T3). Requires daemon mode. Returns " +
      "the provider agent id(s); message one with agent.send. Closes the " +
      "discovery loop without static peer config.",
    parameters: findPeerSchema,
    async execute(input: FindPeerInput): Promise<string> {
      const svc = ctx.services?.get(SERVICE_KEYS.DAEMON_COMM);
      if (!svc) return DAEMON_ONLY_FINDPEER;
      try {
        const providers = await svc.findPeer(input.registry, input.serviceName);
        if (providers.length === 0) return `No provider found for "${input.serviceName}".`;
        const lines = providers.map((p) => `- ${p.agentId}`);
        return `${providers.length} provider(s) of "${input.serviceName}":\n${lines.join("\n")}`;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return `findPeer "${input.serviceName}" via "${input.registry}" failed: ${reason}`;
      }
    },
  };
}

const requestSchema = z.object({
  target: z.string().min(1).describe("Peer agent id to send the request to"),
  payload: z.unknown().describe("JSON-serializable request body"),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("How long to await the reply before failing (default 30000)"),
});
type RequestInput = z.infer<typeof requestSchema>;

const replySchema = z.object({
  target: z.string().min(1).describe("The original requester's agent id"),
  correlationId: z.string().min(1).describe("The request message id being replied to"),
  payload: z.unknown().describe("JSON-serializable reply body"),
});
type ReplyInput = z.infer<typeof replySchema>;

const broadcastSchema = z.object({
  targets: z.array(z.string().min(1)).min(1).describe("Peer agent ids to fan out to"),
  payload: z.unknown().describe("JSON-serializable message body"),
  performative: z.enum(PERFORMATIVES).optional().describe("FIPA-ACL speech act (default 'inform')"),
});
type BroadcastInput = z.infer<typeof broadcastSchema>;

function createRequestTool(ctx: IPluginContext): ITool<RequestInput> {
  return {
    skandha: "samskara" as const,
    id: "agent.request",
    description:
      "Send a REQUEST to a peer agent and wait for its correlated reply (fractal " +
      "society, Tenet #10 C/T4 request-response). Requires daemon mode. Blocks " +
      "until the peer calls agent.reply with the matching correlation id, or until " +
      "`timeoutMs` elapses. Returns the reply payload.",
    parameters: requestSchema,
    async execute(input: RequestInput): Promise<string> {
      const svc = ctx.services?.get(SERVICE_KEYS.DAEMON_COMM);
      if (!svc) return DAEMON_ONLY_REQUEST;
      try {
        const reply = await svc.request(input.target, input.payload, input.timeoutMs);
        const body = typeof reply.payload === "string" ? reply.payload : JSON.stringify(reply.payload);
        return `Reply from "${input.target}": ${body}`;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return `Request to "${input.target}" failed: ${reason}`;
      }
    },
  };
}

function createReplyTool(ctx: IPluginContext): ITool<ReplyInput> {
  return {
    skandha: "samskara" as const,
    id: "agent.reply",
    description:
      "Reply to a REQUEST received from a peer agent (fractal society, Tenet #10 " +
      "C/T4 request-response). Requires daemon mode. Use the `correlationId` = the " +
      "id of the request message (from agent.inbox) and `target` = its sender, so " +
      "the requester's awaiting agent.request resolves.",
    parameters: replySchema,
    async execute(input: ReplyInput): Promise<string> {
      const svc = ctx.services?.get(SERVICE_KEYS.DAEMON_COMM);
      if (!svc) return DAEMON_ONLY_REPLY;
      try {
        await svc.reply(input.target, input.correlationId, input.payload);
        return `Replied to "${input.target}" (correlation ${input.correlationId}).`;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return `Reply to "${input.target}" failed: ${reason}`;
      }
    },
  };
}

function createBroadcastTool(ctx: IPluginContext): ITool<BroadcastInput> {
  return {
    skandha: "samskara" as const,
    id: "agent.broadcast",
    description:
      "Fan out a message to multiple peer agents at once (fractal society, Tenet " +
      "#10 C/T4 broadcast topology). Requires daemon mode. Each delivery is " +
      "independently capability-checked; one target failing does not abort the " +
      "rest. Returns a per-target delivered/failed summary.",
    parameters: broadcastSchema,
    async execute(input: BroadcastInput): Promise<string> {
      const svc = ctx.services?.get(SERVICE_KEYS.DAEMON_COMM);
      if (!svc) return DAEMON_ONLY_BROADCAST;
      const results = await svc.broadcast(input.targets, input.payload, input.performative);
      const ok = results.filter((r) => r.delivered).length;
      const lines = results.map((r) =>
        r.delivered ? `- ${r.target}: delivered` : `- ${r.target}: FAILED (${r.error ?? "unknown"})`,
      );
      return `Broadcast to ${results.length} target(s), ${ok} delivered:\n${lines.join("\n")}`;
    },
  };
}

const pipelineSchema = z.object({
  route: z
    .array(z.string().min(1))
    .min(1)
    .describe("Ordered hop list, e.g. ['agent-b','agent-c'] — the message is relayed through each in turn"),
  payload: z.unknown().describe("JSON-serializable message body carried along the pipeline"),
  performative: z.enum(PERFORMATIVES).optional().describe("FIPA-ACL speech act (default 'request')"),
});
type PipelineInput = z.infer<typeof pipelineSchema>;

function createPipelineTool(ctx: IPluginContext): ITool<PipelineInput> {
  return {
    skandha: "samskara" as const,
    id: "agent.pipeline",
    description:
      "Send a message along an ordered PIPELINE of peer agents (fractal society, " +
      "Tenet #10 pipeline topology). Requires daemon mode. The message is relayed " +
      "hop-by-hop through `route` (each hop capability-checked + HMAC-signed; max " +
      "depth bounded). Returns once the first hop accepts; downstream relay is " +
      "asynchronous.",
    parameters: pipelineSchema,
    async execute(input: PipelineInput): Promise<string> {
      const svc = ctx.services?.get(SERVICE_KEYS.DAEMON_COMM);
      if (!svc) return DAEMON_ONLY_PIPELINE;
      try {
        const res = await svc.pipeline(input.route, input.payload, input.performative);
        return `Pipeline ${res.pipelineId} started: ${input.route.join(" → ")} (first hop "${res.firstHop}" accepted).`;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return `Pipeline [${input.route.join(", ")}] failed: ${reason}`;
      }
    },
  };
}

export function createAgentCommPlugin(): IPlugin {
  return {
    manifest: {
      name: "@openstarry-plugin/agent-comm",
      version: "0.1.0-alpha",
      description:
        "Exposes cross-daemon agent↔agent messaging (`agent.send` / `agent.inbox`), request-response (`agent.request` / `agent.reply`), broadcast (`agent.broadcast`), pipeline routing (`agent.pipeline`), cluster pub/sub (`agent.subscribe` / `agent.events`), and service discovery (`agent.register` / `agent.findPeer`) so an agent's own loop can talk to peer agents, follow their lifecycle events, and discover peers by service name (Tenet #10 / Fractal Society C/T1–T4 + pipeline topology; daemon mode only)",
      skandha: "samskara" as const,
    },

    async factory(ctx: IPluginContext): Promise<PluginHooks> {
      return {
        tools: [
          createSendTool(ctx),
          createInboxTool(ctx),
          createSubscribeTool(ctx),
          createEventsTool(ctx),
          createRegisterTool(ctx),
          createFindPeerTool(ctx),
          createRequestTool(ctx),
          createReplyTool(ctx),
          createBroadcastTool(ctx),
          createPipelineTool(ctx),
        ],
      };
    },
  };
}

export default createAgentCommPlugin;
