import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PusherService } from '../common/pusher.service';
import { BotChannelUser } from '../bot-admin/entities/bot-channel-user.entity';
import { BotConversation } from '../bot-admin/entities/bot-conversation.entity';
import { Company } from '../company/entities/company.entity';
import { SupabaseCustomer } from '../supabase/entities/supabase-customer.entity';
import { User } from '../users/entities/user.entity';

export type AssignmentMode = 'sticky' | 'round_robin' | 'manual' | 'unassigned';

@Injectable()
export class AgentRoutingService {
  private readonly logger = new Logger(AgentRoutingService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Company)
    private readonly companyRepository: Repository<Company>,
    @InjectRepository(BotConversation)
    private readonly conversationRepository: Repository<BotConversation>,
    @InjectRepository(BotChannelUser)
    private readonly channelUserRepository: Repository<BotChannelUser>,
    @InjectRepository(SupabaseCustomer)
    private readonly customerRepository: Repository<SupabaseCustomer>,
    private readonly pusherService: PusherService,
  ) {}

  private pendingTimeoutMinutes(): number {
    const raw = Number(process.env.AGENT_PENDING_TIMEOUT_MINUTES ?? 5);
    return Number.isFinite(raw) && raw > 0 ? raw : 5;
  }

  private pendingTimeoutAt(): Date {
    return new Date(Date.now() + this.pendingTimeoutMinutes() * 60_000);
  }

  normalizePhone(value: string | null | undefined): string {
    return String(value ?? '').replace(/\D/g, '');
  }

  async getActiveAgents(
    companyId: number,
    excludeAgentId?: number,
  ): Promise<User[]> {
    const company = await this.companyRepository.findOne({
      where: { id: companyId },
    });
    const adminUserId = company?.admin_user_id
      ? Number(company.admin_user_id)
      : null;

    const agents = await this.userRepository.find({
      where: { company_id: companyId, is_agent_active: true, is_active: true },
      order: { id: 'ASC' },
    });

    let filtered = agents.filter(
      (agent) => adminUserId === null || Number(agent.id) !== adminUserId,
    );

    if (excludeAgentId !== undefined) {
      filtered = filtered.filter(
        (agent) => Number(agent.id) !== Number(excludeAgentId),
      );
    }

    if (filtered.length > 0) {
      return filtered;
    }

    if (excludeAgentId !== undefined) {
      return agents.filter(
        (agent) => Number(agent.id) !== Number(excludeAgentId),
      );
    }

    return agents;
  }

  async getLastAssignedAgentId(companyId: number): Promise<number | null> {
    const row = await this.conversationRepository
      .createQueryBuilder('c')
      .innerJoin('c.channelUser', 'u')
      .select('c.assigned_agent_id', 'assigned_agent_id')
      .where('u.company_id = :companyId', { companyId })
      .andWhere('c.assigned_agent_id IS NOT NULL')
      .orderBy('c.assigned_at', 'DESC')
      .addOrderBy('c.id', 'DESC')
      .limit(1)
      .getRawOne<{ assigned_agent_id: string | number | null }>();

    if (!row?.assigned_agent_id) {
      return null;
    }
    return Number(row.assigned_agent_id);
  }

  private async resolveStickyAgent(
    companyId: number,
    phone: string,
    excludeAgentId?: number,
  ): Promise<User | null> {
    const normalizedPhone = this.normalizePhone(phone);
    if (!normalizedPhone) {
      return null;
    }

    const customer = await this.customerRepository
      .createQueryBuilder('c')
      .where('c.company_id = :companyId', { companyId })
      .andWhere(
        "regexp_replace(c.customer_phone, '[^0-9]', '', 'g') = :phone",
        { phone: normalizedPhone },
      )
      .getOne();

    if (!customer?.last_agent_id) {
      return null;
    }

    const agents = await this.getActiveAgents(companyId, excludeAgentId);
    return (
      agents.find(
        (agent) => Number(agent.id) === Number(customer.last_agent_id),
      ) ?? null
    );
  }

  private pickRoundRobinAgent(
    agents: User[],
    lastAgentId: number | null,
  ): User {
    if (agents.length === 0) {
      throw new Error('No agents available for round-robin');
    }

    if (lastAgentId === null) {
      return agents[0];
    }

    const currentIndex = agents.findIndex(
      (agent) => Number(agent.id) === lastAgentId,
    );
    if (currentIndex >= 0) {
      return agents[(currentIndex + 1) % agents.length];
    }

    return agents[0];
  }

  async assignConversationToAgent(
    companyId: number,
    conversationId: number,
    agentId: number,
    assignmentMode: AssignmentMode,
  ): Promise<void> {
    await this.conversationRepository.update(conversationId, {
      status: 'pending',
      assigned_agent_id: agentId,
      assigned_at: new Date(),
      timeout_at: this.pendingTimeoutAt(),
      assignment_mode: assignmentMode,
    });

    this.pusherService.trigger(`company-${companyId}`, 'conversation_updated', {
      conversation_id: conversationId,
      status: 'pending',
      agent_id: agentId,
      assignment_mode: assignmentMode,
    });
  }

  async returnConversationToQueue(
    companyId: number,
    conversationId: number,
  ): Promise<void> {
    await this.conversationRepository.update(conversationId, {
      status: 'open',
      assigned_agent_id: null,
      assigned_at: null,
      timeout_at: null,
      assignment_mode: 'unassigned',
    });

    this.pusherService.trigger(`company-${companyId}`, 'conversation_updated', {
      conversation_id: conversationId,
      status: 'open',
      agent_id: null,
      assignment_mode: 'unassigned',
    });
  }

  /**
   * Unified inbound routing: sticky agent first, then round-robin.
   */
  async routeInboundConversation(
    companyId: number,
    conversationId: number,
    phone: string,
    excludeAgentId?: number,
  ): Promise<{ agentId: number | null; assignmentMode: AssignmentMode }> {
    const stickyAgent = await this.resolveStickyAgent(
      companyId,
      phone,
      excludeAgentId,
    );
    if (stickyAgent) {
      await this.assignConversationToAgent(
        companyId,
        conversationId,
        stickyAgent.id,
        'sticky',
      );
      return { agentId: stickyAgent.id, assignmentMode: 'sticky' };
    }

    const agents = await this.getActiveAgents(companyId, excludeAgentId);
    if (agents.length === 0) {
      await this.returnConversationToQueue(companyId, conversationId);
      return { agentId: null, assignmentMode: 'unassigned' };
    }

    const lastAgentId = await this.getLastAssignedAgentId(companyId);
    const targetAgent = this.pickRoundRobinAgent(agents, lastAgentId);
    await this.assignConversationToAgent(
      companyId,
      conversationId,
      targetAgent.id,
      'round_robin',
    );
    return { agentId: targetAgent.id, assignmentMode: 'round_robin' };
  }

  async assignConversationRoundRobin(
    companyId: number,
    conversationId: number,
    excludeAgentId?: number,
  ): Promise<number | null> {
    const conv = await this.conversationRepository.findOne({
      where: { id: conversationId },
      relations: ['channelUser'],
    });
    const phone =
      conv?.channelUser?.external_user_id ??
      (await this.resolvePhoneForConversation(conversationId));

    const result = await this.routeInboundConversation(
      companyId,
      conversationId,
      phone,
      excludeAgentId,
    );
    return result.agentId;
  }

  async manualAssignConversation(
    companyId: number,
    conversationId: number,
    agentId: number,
  ): Promise<void> {
    const conv = await this.conversationRepository.findOne({
      where: { id: conversationId },
      relations: ['channelUser'],
    });
    if (!conv) {
      throw new NotFoundException('Conversation not found.');
    }
    if (conv.status !== 'open') {
      throw new NotFoundException(
        'Only unassigned (open) conversations can be manually assigned.',
      );
    }

    const agent = await this.userRepository.findOne({
      where: {
        id: agentId,
        company_id: companyId,
        is_active: true,
        is_agent_active: true,
      },
    });
    if (!agent) {
      throw new NotFoundException('Agent not found or not online.');
    }

    await this.assignConversationToAgent(
      companyId,
      conversationId,
      agent.id,
      'manual',
    );
  }

  async recordStickyAgent(
    companyId: number,
    phone: string,
    agentId: number,
  ): Promise<void> {
    const normalizedPhone = this.normalizePhone(phone);
    if (!normalizedPhone) {
      return;
    }

    const customer = await this.customerRepository
      .createQueryBuilder('c')
      .where('c.company_id = :companyId', { companyId })
      .andWhere(
        "regexp_replace(c.customer_phone, '[^0-9]', '', 'g') = :phone",
        { phone: normalizedPhone },
      )
      .getOne();

    if (customer) {
      await this.customerRepository.update(customer.id, {
        last_agent_id: agentId,
      });
      return;
    }

    await this.customerRepository.save(
      this.customerRepository.create({
        company_id: companyId,
        customer_phone: phone,
        last_agent_id: agentId,
        last_seen_at: new Date(),
      }),
    );
  }

  private async resolvePhoneForConversation(
    conversationId: number,
  ): Promise<string> {
    const conv = await this.conversationRepository.findOne({
      where: { id: conversationId },
      relations: ['channelUser'],
    });
    return conv?.channelUser?.external_user_id ?? '';
  }

  async reroutePendingConversationsForAgent(
    companyId: number,
    agentId: number,
  ): Promise<number[]> {
    const pending = await this.conversationRepository.find({
      where: {
        assigned_agent_id: agentId,
        status: 'pending' as BotConversation['status'],
      },
      relations: ['channelUser'],
    });

    const reroutedIds: number[] = [];

    for (const conv of pending) {
      const phone = conv.channelUser?.external_user_id ?? '';
      const result = await this.routeInboundConversation(
        companyId,
        conv.id,
        phone,
        agentId,
      );
      reroutedIds.push(conv.id);
      this.pusherService.trigger(
        `company-${companyId}`,
        'conversation_updated',
        {
          conversation_id: conv.id,
          status: result.agentId ? 'pending' : 'open',
          agent_id: result.agentId,
          previous_agent_id: agentId,
        },
      );
    }

    return reroutedIds;
  }

  async processPendingTimeouts(): Promise<number> {
    const now = new Date();
    const due = await this.conversationRepository
      .createQueryBuilder('c')
      .leftJoinAndSelect('c.channelUser', 'channelUser')
      .leftJoin(User, 'agent', 'agent.id = c.assigned_agent_id')
      .where('c.status = :status', { status: 'pending' })
      .andWhere(
        `(c.timeout_at IS NOT NULL AND c.timeout_at <= :now)
         OR COALESCE(agent.is_agent_active, FALSE) = FALSE
         OR COALESCE(agent.is_active, TRUE) = FALSE`,
        { now },
      )
      .getMany();

    let rerouted = 0;

    for (const conv of due) {
      const companyId = conv.channelUser?.company_id;
      if (!companyId) {
        continue;
      }

      const previousAgentId = conv.assigned_agent_id;
      const phone = conv.channelUser?.external_user_id ?? '';
      const result = await this.routeInboundConversation(
        companyId,
        conv.id,
        phone,
        previousAgentId ?? undefined,
      );

      rerouted += 1;
      this.logger.log(
        `Timeout reroute conversation ${conv.id}: ${previousAgentId} -> ${result.agentId ?? 'open'}`,
      );
    }

    return rerouted;
  }

  async getUnassignedConversations(companyId: number) {
    const rows = await this.conversationRepository
      .createQueryBuilder('c')
      .innerJoinAndSelect('c.channelUser', 'channelUser')
      .where('channelUser.company_id = :companyId', { companyId })
      .andWhere('c.status = :status', { status: 'open' })
      .orderBy('c.last_message_at', 'DESC', 'NULLS LAST')
      .addOrderBy('c.id', 'DESC')
      .getMany();

    return rows.map((conv) => ({
      id: conv.id,
      status: conv.status,
      assignment_mode: conv.assignment_mode,
      last_message_at: conv.last_message_at,
      channelUser: conv.channelUser
        ? {
            id: conv.channelUser.id,
            display_name: conv.channelUser.display_name,
            external_user_id: conv.channelUser.external_user_id,
            platform: conv.channelUser.platform,
          }
        : null,
    }));
  }

  /**
   * Ensure WhatsApp inbound creates/updates bot_conversation and assigns an online agent.
   */
  async handleWhatsAppInboundForRouting(
    companyId: number,
    phone: string,
    displayName?: string,
  ): Promise<{
    conversationId: number | null;
    assignedAgentId: number | null;
    status: string;
  }> {
    const normalizedPhone = this.normalizePhone(phone);
    if (!normalizedPhone) {
      return {
        conversationId: null,
        assignedAgentId: null,
        status: 'open',
      };
    }

    let channelUser = await this.channelUserRepository.findOne({
      where: { platform: 'whatsapp', external_user_id: normalizedPhone },
    });

    if (!channelUser) {
      channelUser = await this.channelUserRepository.save(
        this.channelUserRepository.create({
          company_id: companyId,
          platform: 'whatsapp',
          external_user_id: normalizedPhone,
          display_name: displayName?.trim() || normalizedPhone,
          bot_enabled: true,
          manual_mode: false,
          last_seen_at: new Date(),
        }),
      );
    } else {
      if (Number(channelUser.company_id) !== Number(companyId)) {
        channelUser.company_id = companyId;
      }
      channelUser.last_seen_at = new Date();
      if (displayName?.trim() && !channelUser.display_name?.trim()) {
        channelUser.display_name = displayName.trim();
      }
      await this.channelUserRepository.save(channelUser);
    }

    let conversation = await this.conversationRepository
      .createQueryBuilder('c')
      .where('c.bot_channel_user_id = :channelUserId', {
        channelUserId: channelUser.id,
      })
      .andWhere('c.status IN (:...statuses)', {
        statuses: ['open', 'manual', 'pending', 'active'],
      })
      .orderBy('c.id', 'DESC')
      .getOne();

    if (!conversation) {
      conversation = await this.conversationRepository.save(
        this.conversationRepository.create({
          bot_channel_user_id: channelUser.id,
          status: 'open',
          last_message_at: new Date(),
        }),
      );
    } else {
      conversation.last_message_at = new Date();
      await this.conversationRepository.save(conversation);
    }

    if (conversation.status !== 'open') {
      return {
        conversationId: conversation.id,
        assignedAgentId: conversation.assigned_agent_id,
        status: conversation.status,
      };
    }

    const result = await this.routeInboundConversation(
      companyId,
      conversation.id,
      normalizedPhone,
    );

    return {
      conversationId: conversation.id,
      assignedAgentId: result.agentId,
      status: result.agentId ? 'pending' : 'open',
    };
  }
}
