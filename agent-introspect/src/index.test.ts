/**
 * agent-introspect (Doc 11): agent.listChildren / agent.processTree tools.
 *
 * Verifies the tools consume SERVICE_KEYS.DAEMON_INTROSPECT and behave in three
 * cases: daemon present (returns data), default-to-self parentId, and no daemon
 * (clear daemon-only message, no throw).
 */

import { describe, it, expect, vi } from "vitest";
import type { IPluginContext, IPluginService, IDaemonIntrospectService, ITool } from "@openstarry/sdk";
import { SERVICE_KEYS } from "@openstarry/sdk";
import { createAgentIntrospectPlugin } from "./index.js";

function makeCtx(svc: IDaemonIntrospectService | null, agentId = "self-agent"): IPluginContext {
  const services = {
    get<T extends IPluginService>(key: { name: string }): T | undefined {
      if (svc && key.name === SERVICE_KEYS.DAEMON_INTROSPECT.name) return svc as unknown as T;
      return undefined;
    },
    has: (key: { name: string }) => svc !== null && key.name === SERVICE_KEYS.DAEMON_INTROSPECT.name,
    register: () => {},
    list: () => (svc ? [svc] : []),
    unregister: () => false,
  };
  return { services, agentId } as unknown as IPluginContext;
}

async function tools(ctx: IPluginContext): Promise<Record<string, ITool>> {
  const hooks = await createAgentIntrospectPlugin().factory(ctx);
  const map: Record<string, ITool> = {};
  for (const t of hooks.tools ?? []) map[t.id] = t as ITool;
  return map;
}

const TOOLCTX = {} as never;

describe("agent-introspect tools (Doc 11 introspection)", () => {
  it("agent.listChildren: returns the daemon's children for the given parentId", async () => {
    const svc: IDaemonIntrospectService = {
      name: "daemon-introspect",
      version: "1.0.0",
      listChildren: vi.fn(async (parentId) => [
        { agentId: "child-1", pid: 11, status: "running", configPath: "./c1.json", uptime: 5, parentAgentId: parentId, childAgentIds: [] },
      ]),
      processTree: vi.fn(async () => []),
    };
    const t = await tools(makeCtx(svc));
    expect(t["agent.listChildren"]).toBeDefined();
    expect(t["agent.listChildren"].skandha).toBe("samskara");
    const out = JSON.parse(await t["agent.listChildren"].execute({ parentId: "p1" }, TOOLCTX));
    expect(out.parentId).toBe("p1");
    expect(out.count).toBe(1);
    expect(out.children[0].agentId).toBe("child-1");
    expect(svc.listChildren).toHaveBeenCalledWith("p1");
  });

  it("agent.listChildren: defaults parentId to this agent (ctx.agentId)", async () => {
    const svc: IDaemonIntrospectService = {
      name: "daemon-introspect",
      version: "1.0.0",
      listChildren: vi.fn(async () => []),
      processTree: vi.fn(async () => []),
    };
    const t = await tools(makeCtx(svc, "me-agent"));
    await t["agent.listChildren"].execute({}, TOOLCTX);
    expect(svc.listChildren).toHaveBeenCalledWith("me-agent");
  });

  it("agent.processTree: returns the tree", async () => {
    const svc: IDaemonIntrospectService = {
      name: "daemon-introspect",
      version: "1.0.0",
      listChildren: vi.fn(async () => []),
      processTree: vi.fn(async () => [
        { agentId: "root", pid: 1, status: "running", depth: 0, children: [
          { agentId: "child", pid: 2, status: "running", depth: 1, children: [] },
        ] },
      ]),
    };
    const t = await tools(makeCtx(svc));
    const out = JSON.parse(await t["agent.processTree"].execute({}, TOOLCTX));
    expect(out.roots).toBe(1);
    expect(out.tree[0].agentId).toBe("root");
    expect(out.tree[0].children[0].agentId).toBe("child");
  });

  it("no daemon (service absent): both tools return a daemon-only message, no throw", async () => {
    const t = await tools(makeCtx(null));
    const a = await t["agent.listChildren"].execute({}, TOOLCTX);
    const b = await t["agent.processTree"].execute({}, TOOLCTX);
    expect(a).toMatch(/daemon mode|unavailable/i);
    expect(b).toMatch(/daemon mode|unavailable/i);
  });
});
