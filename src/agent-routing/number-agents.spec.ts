import { AgentRoutingService } from './agent-routing.service';

/** Channels → WhatsApp → "Agents for this number": chats of that number go only to those agents. */
describe('agents per WhatsApp number', () => {
  function service(opts: { online: number[]; numberAgents: number[] | null; sticky?: number | null }) {
    const assigned: number[] = [];
    let queued = false;
    const s = Object.create(AgentRoutingService.prototype) as AgentRoutingService & Record<string, unknown>;
    Object.assign(s, {
      logger: { log: () => undefined, warn: () => undefined },
      pusherService: { trigger: () => undefined },
      conversationRepository: {
        findOne: async () => ({ id: 5, status: 'open', assigned_agent_id: null }),
        query: async (sql: string) => (sql.includes('agent_ids') ? [{ agent_ids: opts.numberAgents }] : []),
      },
      resolveStickyAgent: async () => (opts.sticky ? { id: opts.sticky } : null),
      getActiveAgents: async () => opts.online.map((id) => ({ id })),
      getLastAssignedAgentId: async () => null,
      pickLeastBusyAgent: async (_c: number, agents: Array<{ id: number }>) => agents[0],
      assignConversationToAgent: async (_c: number, _conv: number, agent: number) => { assigned.push(agent); },
      returnConversationToQueue: async () => { queued = true; },
    });
    return { s, assigned, queued: () => queued };
  }

  it('no agents set on the number: every online agent can get it (as before)', async () => {
    const { s, assigned } = service({ online: [1, 2], numberAgents: null });
    expect((await s.routeInboundConversation(7, 5, '9477')).agentId).toBe(1);
    expect(assigned).toEqual([1]);
  });

  it('agents set: only they get the chat', async () => {
    const { s, assigned } = service({ online: [1, 2, 3], numberAgents: [3] });
    expect((await s.routeInboundConversation(7, 5, '9477')).agentId).toBe(3);
    expect(assigned).toEqual([3]);
  });

  it('the earlier (sticky) agent is skipped when he is not an agent of this number', async () => {
    const { s, assigned } = service({ online: [1, 2], numberAgents: [2], sticky: 1 });
    expect((await s.routeInboundConversation(7, 5, '9477')).agentId).toBe(2);
    expect(assigned).toEqual([2]);
  });

  it('no agent of the number online: the chat waits in the queue, nobody else gets it', async () => {
    const { s, assigned, queued } = service({ online: [1, 2], numberAgents: [9] });
    expect((await s.routeInboundConversation(7, 5, '9477')).agentId).toBeNull();
    expect(assigned).toEqual([]);
    expect(queued()).toBe(true);
  });
});
