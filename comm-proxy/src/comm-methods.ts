/**
 * Concrete comm proxy method implementations.
 * Plan39 W2 — Method Registrations (~10 LOC).
 *
 * Four methods routing through the Template Method base class:
 * - SendMethod    (fire-and-forget) → channel.send()
 * - PublishMethod (fire-and-forget) → channel.publish()
 * - ReplyMethod   (rpc)             → channel.reply()
 * - CallMethod    (rpc)             → channel.call()
 *
 * AC-W2-1: All four comm methods routed through proxy.
 * AC-W2-3: Error types normalized via CommProxyMethod.onError().
 */

import type { ICommChannel } from '@openstarry/sdk';
import type { BulkheadType } from '@openstarry/sdk';
import { CommProxyMethod } from './comm-proxy-method.js';

// ---------------------------------------------------------------------------
// SendMethod — fire-and-forget bulkhead lane
// ---------------------------------------------------------------------------

export interface SendArgs {
  target: string;
  message: import('@openstarry/sdk').CommMessage;
}

export class SendMethod extends CommProxyMethod<SendArgs, void> {
  readonly bulkheadType: BulkheadType = 'fire-and-forget';

  constructor(private readonly channel: ICommChannel) {
    super();
  }

  protected async execute(args: SendArgs): Promise<void> {
    if (!this.channel.send) throw new Error('Inner channel does not support send');
    await this.channel.send(args.target, args.message);
  }
}

// ---------------------------------------------------------------------------
// PublishMethod — fire-and-forget bulkhead lane
// ---------------------------------------------------------------------------

export interface PublishArgs {
  topic: string;
  message: import('@openstarry/sdk').CommMessage;
}

export class PublishMethod extends CommProxyMethod<PublishArgs, void> {
  readonly bulkheadType: BulkheadType = 'fire-and-forget';

  constructor(private readonly channel: ICommChannel) {
    super();
  }

  protected async execute(args: PublishArgs): Promise<void> {
    if (!this.channel.publish) throw new Error('Inner channel does not support publish');
    await this.channel.publish(args.topic, args.message);
  }
}

// ---------------------------------------------------------------------------
// ReplyMethod — rpc bulkhead lane
// ---------------------------------------------------------------------------

export interface ReplyArgs {
  msgId: string;
  response: import('@openstarry/sdk').CommMessage;
}

export class ReplyMethod extends CommProxyMethod<ReplyArgs, void> {
  readonly bulkheadType: BulkheadType = 'rpc';

  constructor(private readonly channel: ICommChannel) {
    super();
  }

  protected async execute(args: ReplyArgs): Promise<void> {
    if (!this.channel.reply) throw new Error('Inner channel does not support reply');
    await this.channel.reply(args.msgId, args.response);
  }
}

// ---------------------------------------------------------------------------
// CallMethod — rpc bulkhead lane
// ---------------------------------------------------------------------------

export interface CallArgs {
  method: string;
  params: unknown;
}

export class CallMethod extends CommProxyMethod<CallArgs, unknown> {
  readonly bulkheadType: BulkheadType = 'rpc';

  constructor(private readonly channel: ICommChannel) {
    super();
  }

  protected async execute(args: CallArgs): Promise<unknown> {
    if (!this.channel.call) throw new Error('Inner channel does not support call');
    return this.channel.call(args.method, args.params);
  }
}
