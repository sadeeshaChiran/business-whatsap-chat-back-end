import { AgentRoutingService } from './agent-routing.service';

/** 10 chats went to the first agent who came online; more agents come online -> the untouched chats are shared. */
describe('rebalanceUntouchedChats', () => {
  function service(agents: number[], load: Record<number, number>, movable: Array<{ id: number; agent_id: number }>) {
    const moves: Array<[number, number]> = [];
    const s = Object.create(AgentRoutingService.prototype) as AgentRoutingService & Record<string, unknown>;
    Object.assign(s, {
      logger: { log: () => undefined, warn: () => undefined },
      pusherService: { trigger: () => undefined },
      getActiveAgents: async () => agents.map((id) => ({ id })),
      assignConversationToAgent: async (_c: number, conv: number, agent: number) => { moves.push([conv, agent]); },
      conversationRepository: {
        query: async (sql: string) => (sql.includes('COUNT(*)')
          ? Object.entries(load).map(([agent_id, n]) => ({ agent_id: Number(agent_id), n }))
          : movable),
      },
    });
    return { s, moves };
  }
  const tenFor = (agent: number) => Array.from({ length: 10 }, (_, i) => ({ id: 100 + i, agent_id: agent }));

  it('second agent online: 10 / 0 -> 5 / 5', async () => {
    const { s, moves } = service([1, 2], { 1: 10 }, tenFor(1));
    expect(await s.rebalanceUntouchedChats(7)).toBe(5);
    expect(moves.every(([, agent]) => agent === 2)).toBe(true);
  });

  it('three agents: 10 / 0 / 0 -> 4 / 3 / 3', async () => {
    const { s, moves } = service([1, 2, 3], { 1: 10 }, tenFor(1));
    expect(await s.rebalanceUntouchedChats(7)).toBe(6);
    expect(moves.filter(([, a]) => a === 2).length).toBe(3);
    expect(moves.filter(([, a]) => a === 3).length).toBe(3);
  });

  it('only untouched chats move: agent 1 already answered 8 of 10', async () => {
    const { s, moves } = service([1, 2], { 1: 10 }, tenFor(1).slice(0, 2));
    expect(await s.rebalanceUntouchedChats(7)).toBe(2);
    expect(moves.length).toBe(2);
  });

  it('one agent online or already fair: nothing moves', async () => {
    expect(await service([1], { 1: 10 }, tenFor(1)).s.rebalanceUntouchedChats(7)).toBe(0);
    expect(await service([1, 2], { 1: 5, 2: 4 }, tenFor(1).slice(0, 5)).s.rebalanceUntouchedChats(7)).toBe(0);
  });
});
