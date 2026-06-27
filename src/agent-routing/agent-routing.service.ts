import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { PusherService } from '../common/pusher.service';
import { BotChannelUser } from '../bot-admin/entities/bot-channel-user.entity';
import { BotConversation } from '../bot-admin/entities/bot-conversation.entity';
import { BotMessage } from '../bot-admin/entities/bot-message.entity';
import { Company } from '../company/entities/company.entity';
import { SupabaseCustomer } from '../supabase/entities/supabase-customer.entity';
import { User } from '../users/entities/user.entity';

export type AssignmentMode = 'sticky' | 'round_robin' | 'manual' | 'unassigned';

export type InboundWhatsAppMessage = {
  content: string;
  message_type?: 'text' | 'image' | 'voice';
  source?: string;
};

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
    @InjectRepository(BotMessage)
    private readonly messageRepository: Repository<BotMessage>,
    @InjectRepository(SupabaseCustomer)
    private readonly customerRepository: Repository<SupabaseCustomer>,
    private readonly pusherService: PusherService,
  ) {}

  private pendingTimeoutMinutes(): number {
    const hours = Number(process.env.AGENT_PENDING_TIMEOUT_HOURS ?? 24);
    if (Number.isFinite(hours) && hours > 0) {
      return Math.round(hours * 60);
    }
    const raw = Number(process.env.AGENT_PENDING_TIMEOUT_MINUTES ?? 1440);
    return Number.isFinite(raw) && raw > 0 ? raw : 1440;
  }

  private pendingTimeoutAt(): Date {
    return new Date(Date.now() + this.pendingTimeoutMinutes() * 60_000);
  }

  private acceptStickyHours(): number {
    const raw = Number(process.env.AGENT_ACCEPT_STICKY_HOURS ?? 24);
    if (Number.isFinite(raw) && raw > 0) {
      return raw;
    }
    const hours = Number(process.env.AGENT_PENDING_TIMEOUT_HOURS ?? 24);
    return Number.isFinite(hours) && hours > 0 ? hours : 24;
  }

  private async shouldRestoreActiveAssignment(
    companyId: number,
    phone: string,
    agentId: number,
  ): Promise<boolean> {
    const normalizedPhone = this.normalizePhone(phone);
    if (!normalizedPhone) {
      return false;
    }

    const customer = await this.customerRepository
      .createQueryBuilder('c')
      .where('c.company_id = :companyId', { companyId })
      .andWhere(
        "regexp_replace(c.customer_phone, '[^0-9]', '', 'g') = :phone",
        { phone: normalizedPhone },
      )
      .getOne();

    if (!customer?.last_agent_accepted_at || !customer.last_agent_id) {
      return false;
    }
    if (Number(customer.last_agent_id) !== Number(agentId)) {
      return false;
    }

    const acceptedMs = new Date(customer.last_agent_accepted_at).getTime();
    if (!Number.isFinite(acceptedMs)) {
      return false;
    }

    return (
      Date.now() - acceptedMs < this.acceptStickyHours() * 60 * 60 * 1000
    );
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

    const agents = await this.userRepository
      .createQueryBuilder('u')
      .where('u.company_id = :companyId', { companyId })
      .andWhere('COALESCE(u.is_active, TRUE) = TRUE')
      .andWhere('COALESCE(u.is_agent_active, FALSE) = TRUE')
      .orderBy('u.id', 'ASC')
      .getMany();

    let filtered = agents.filter(
      (agent) => adminUserId === null || Number(agent.id) !== adminUserId,
    );

    if (excludeAgentId !== undefined) {
      filtered = filtered.filter(
        (agent) => Number(agent.id) !== Number(excludeAgentId),
      );
    }

    return filtered;
  }

  private async getCompanyAdminUserId(companyId: number): Promise<number | null> {
    const company = await this.companyRepository.findOne({
      where: { id: companyId },
    });
    return company?.admin_user_id ? Number(company.admin_user_id) : null;
  }

  /** True when assignee is a support agent (not company admin) and currently online. */
  private async isHeldByOnlineSupportAgent(
    companyId: number,
    assignedAgentId: number | string | null | undefined,
  ): Promise<boolean> {
    if (assignedAgentId == null) {
      return false;
    }
    const assigneeId = Number(assignedAgentId);
    if (!Number.isFinite(assigneeId) || assigneeId <= 0) {
      return false;
    }

    const adminUserId = await this.getCompanyAdminUserId(companyId);
    if (adminUserId != null && assigneeId === adminUserId) {
      return false;
    }

    const onlineSupportIds = new Set(
      (await this.getActiveAgents(companyId)).map((agent) => Number(agent.id)),
    );
    return onlineSupportIds.has(assigneeId);
  }

  private shouldRouteInboundConversation(
    conversation: Pick<BotConversation, 'status' | 'assigned_agent_id'>,
  ): boolean {
    if (conversation.status === 'active' || conversation.status === 'closed') {
      return false;
    }
    if (
      (conversation.status === 'pending' || conversation.status === 'manual') &&
      conversation.assigned_agent_id != null
    ) {
      return false;
    }
    return (
      conversation.status === 'open' ||
      conversation.status === 'pending' ||
      conversation.status === 'manual'
    );
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

    const stickyAgentId = Number(customer.last_agent_id);
    if (
      excludeAgentId !== undefined &&
      stickyAgentId === Number(excludeAgentId)
    ) {
      return null;
    }

    const stickyAgent = await this.userRepository.findOne({
      where: {
        id: stickyAgentId,
        company_id: companyId,
        is_active: true,
      },
    });
    if (!stickyAgent) {
      return null;
    }

    const agents = await this.getActiveAgents(companyId, excludeAgentId);
    return (
      agents.find((agent) => Number(agent.id) === stickyAgentId) ?? null
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
    customerPhone?: string,
    options?: { forcePending?: boolean },
  ): Promise<void> {
    const existing = await this.conversationRepository.findOne({
      where: { id: conversationId },
      relations: ['channelUser'],
    });

    if (
      existing?.status === 'active' &&
      Number(existing.assigned_agent_id) === Number(agentId)
    ) {
      return;
    }

    const phone =
      customerPhone ??
      existing?.channelUser?.external_user_id ??
      (await this.resolvePhoneForConversation(conversationId));

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
   * Never reassign pending/active chats unless excludeAgentId is the current assignee.
   */
  async routeInboundConversation(
    companyId: number,
    conversationId: number,
    phone: string,
    excludeAgentId?: number,
    options?: { forcePending?: boolean },
  ): Promise<{ agentId: number | null; assignmentMode: AssignmentMode }> {
    const existing = await this.conversationRepository.findOne({
      where: { id: conversationId },
    });
    if (
      existing &&
      (existing.status === 'pending' || existing.status === 'active') &&
      existing.assigned_agent_id != null
    ) {
      const assignedId = Number(existing.assigned_agent_id);
      const isExplicitReroute =
        excludeAgentId !== undefined &&
        Number(excludeAgentId) === assignedId;
      if (!isExplicitReroute || existing.status === 'active') {
        return {
          agentId: assignedId,
          assignmentMode:
            (existing.assignment_mode as AssignmentMode) ?? 'round_robin',
        };
      }
    }

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
        phone,
        { forcePending: options?.forcePending },
      );
      return { agentId: stickyAgent.id, assignmentMode: 'sticky' };
    }

    const agents = await this.getActiveAgents(companyId, excludeAgentId);
    if (agents.length === 0) {
      this.logger.warn(
        `No online agents for company ${companyId}; conversation ${conversationId} left unassigned`,
      );
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
      phone,
      { forcePending: options?.forcePending },
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
    if (
      conv.channelUser &&
      Number(conv.channelUser.company_id) !== Number(companyId)
    ) {
      throw new NotFoundException('Conversation not found.');
    }
    if (conv.status === 'active' || conv.status === 'closed') {
      throw new NotFoundException(
        'Active or closed conversations cannot be manually reassigned.',
      );
    }
    if (conv.assigned_agent_id != null) {
      const heldOnline = await this.isHeldByOnlineSupportAgent(
        companyId,
        conv.assigned_agent_id,
      );
      if (heldOnline) {
        throw new NotFoundException(
          'Conversation is already assigned to an online agent.',
        );
      }
    }

    const adminUserId = await this.getCompanyAdminUserId(companyId);
    if (adminUserId != null && Number(agentId) === adminUserId) {
      throw new NotFoundException('Company admin cannot receive agent chats.');
    }

    const agent = await this.userRepository.findOne({
      where: {
        id: agentId,
        company_id: companyId,
        is_active: true,
      },
    });
    if (!agent) {
      throw new NotFoundException('Agent not found.');
    }

    await this.assignConversationToAgent(
      companyId,
      conversationId,
      agent.id,
      'manual',
      conv.channelUser?.external_user_id ?? undefined,
      { forcePending: true },
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
        last_agent_accepted_at: new Date(),
      });
      return;
    }

    await this.customerRepository.save(
      this.customerRepository.create({
        company_id: companyId,
        customer_phone: phone,
        last_agent_id: agentId,
        last_agent_accepted_at: new Date(),
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
      .where('c.status = :status', { status: 'pending' })
      .andWhere('c.timeout_at IS NOT NULL AND c.timeout_at <= :now', { now })
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
      this.pusherService.trigger(
        `company-${companyId}`,
        'conversation_updated',
        {
          conversation_id: conv.id,
          status: result.agentId ? 'pending' : 'open',
          agent_id: result.agentId,
          previous_agent_id: previousAgentId,
          assignment_mode: result.assignmentMode,
        },
      );
      this.logger.log(
        `Timeout reroute conversation ${conv.id}: ${previousAgentId} -> ${result.agentId ?? 'open'}`,
      );
    }

    return rerouted;
  }

  async getUnassignedConversations(companyId: number) {
    const companyIdNum = Number(companyId);
    await this.releasePendingChatsWhenNoOnlineAgents(companyIdNum);
    const queueRows = await this.findQueueConversationsForCompany(companyIdNum);

    const assignedIds = [
      ...new Set(
        queueRows
          .map((conv) => Number(conv.assigned_agent_id))
          .filter((id) => Number.isFinite(id) && id > 0),
      ),
    ];
    const assignedAgents =
      assignedIds.length > 0
        ? await this.userRepository.findBy({ id: In(assignedIds) })
        : [];
    const agentNameById = new Map(
      assignedAgents.map((agent) => [Number(agent.id), agent.name]),
    );
    const agentOnlineById = new Map(
      assignedAgents.map((agent) => [
        Number(agent.id),
        Boolean(agent.is_agent_active),
      ]),
    );

    return queueRows.map((conv) => {
      const assignedId = conv.assigned_agent_id
        ? Number(conv.assigned_agent_id)
        : null;
      const queueReason =
        assignedId != null && agentOnlineById.get(assignedId) === false
          ? ('agent_offline' as const)
          : ('no_agent' as const);

      return {
        id: conv.id,
        status: conv.status,
        assignment_mode: conv.assignment_mode,
        last_message_at: conv.last_message_at,
        queue_reason: queueReason,
        assigned_agent_id: assignedId,
        assigned_agent_name:
          assignedId != null ? agentNameById.get(assignedId) ?? null : null,
        channelUser: conv.channelUser
          ? {
              id: conv.channelUser.id,
              display_name: conv.channelUser.display_name,
              external_user_id: conv.channelUser.external_user_id,
              platform: conv.channelUser.platform,
            }
          : null,
      };
    });
  }

  /**
   * Chats waiting for an online agent: not active/closed and not held by an online assignee.
   */
  private async findQueueConversationsForCompany(
    companyId: number,
  ): Promise<BotConversation[]> {
    return this.conversationRepository
      .createQueryBuilder('c')
      .innerJoinAndSelect('c.channelUser', 'channelUser')
      .where('CAST(channelUser.company_id AS BIGINT) = CAST(:companyId AS BIGINT)', {
        companyId: Number(companyId),
      })
      .andWhere('LOWER(c.status) NOT IN (:...closedStatuses)', {
        closedStatuses: ['active', 'closed'],
      })
      .andWhere(this.waitingForOnlineAgentSql(), {
        companyId: Number(companyId),
      })
      .orderBy('c.last_message_at', 'DESC', 'NULLS LAST')
      .addOrderBy('c.id', 'DESC')
      .getMany();
  }

  /** SQL: unassigned OR assignee missing/offline (not held by an online agent). */
  private waitingForOnlineAgentSql(): string {
    return `(
      c.assigned_agent_id IS NULL
      OR NOT EXISTS (
        SELECT 1
        FROM app_user a
        INNER JOIN companies co ON CAST(co.id AS BIGINT) = CAST(:companyId AS BIGINT)
        WHERE CAST(a.id AS BIGINT) = CAST(c.assigned_agent_id AS BIGINT)
          AND CAST(a.company_id AS BIGINT) = CAST(:companyId AS BIGINT)
          AND COALESCE(a.is_agent_active, FALSE) = TRUE
          AND (co.admin_user_id IS NULL OR CAST(a.id AS BIGINT) <> CAST(co.admin_user_id AS BIGINT))
      )
    )`;
  }

  /**
   * When no agents are online, move unaccepted pending chats back to the open queue
   * so the admin unassigned list stays accurate. Does not touch active chats or sticky data.
   */
  async releasePendingChatsWhenNoOnlineAgents(companyId: number): Promise<number> {
    const onlineSupportAgents = await this.getActiveAgents(companyId);
    if (onlineSupportAgents.length > 0) {
      return 0;
    }

    const pending = await this.conversationRepository
      .createQueryBuilder('c')
      .innerJoin('c.channelUser', 'channelUser')
      .where('CAST(channelUser.company_id AS BIGINT) = CAST(:companyId AS BIGINT)', {
        companyId: Number(companyId),
      })
      .andWhere('LOWER(c.status) = :status', { status: 'pending' })
      .getMany();

    let released = 0;
    for (const conv of pending) {
      await this.returnConversationToQueue(companyId, conv.id);
      released += 1;
    }

    if (released > 0) {
      this.logger.log(
        `Released ${released} pending chat(s) to open queue — no online support agents for company ${companyId}`,
      );
    }

    return released;
  }

  private async findOpenUnassignedForCompany(
    companyId: number,
  ): Promise<BotConversation[]> {
    return this.findQueueConversationsForCompany(companyId);
  }

  private async findPendingOfflineForCompany(
    companyId: number,
  ): Promise<BotConversation[]> {
    return this.conversationRepository
      .createQueryBuilder('c')
      .innerJoinAndSelect('c.channelUser', 'channelUser')
      .innerJoin(
        User,
        'agent',
        'CAST(agent.id AS BIGINT) = CAST(c.assigned_agent_id AS BIGINT)',
      )
      .where('CAST(channelUser.company_id AS BIGINT) = CAST(:companyId AS BIGINT)', {
        companyId: Number(companyId),
      })
      .andWhere('LOWER(c.status) = :status', { status: 'pending' })
      .andWhere('c.assigned_agent_id IS NOT NULL')
      .andWhere('COALESCE(agent.is_agent_active, FALSE) = FALSE')
      .orderBy('c.last_message_at', 'DESC', 'NULLS LAST')
      .addOrderBy('c.id', 'DESC')
      .getMany();
  }

  /**
   * Assign queue chats and reroute pending chats stuck on offline agents
   * when at least one agent is online. Called when an agent goes online and by the scheduler.
   */
  async assignOpenQueueForCompany(companyId: number): Promise<number> {
    const agents = await this.getActiveAgents(companyId);
    if (agents.length === 0) {
      return 0;
    }

    const waiting = await this.findQueueConversationsForCompany(companyId);
    let assigned = 0;

    for (const conv of waiting) {
      const phone = conv.channelUser?.external_user_id ?? '';
      if (!phone) {
        continue;
      }

      const previousAgentId = conv.assigned_agent_id
        ? Number(conv.assigned_agent_id)
        : undefined;
      const excludeAgentId =
        previousAgentId &&
        conv.status === 'pending' &&
        !(await this.isHeldByOnlineSupportAgent(companyId, previousAgentId))
          ? previousAgentId
          : undefined;

      const result = await this.routeInboundConversation(
        companyId,
        conv.id,
        phone,
        excludeAgentId,
        { forcePending: true },
      );

      if (result.agentId) {
        assigned += 1;
        this.logger.log(
          `Auto-assigned queue conversation ${conv.id} to agent ${result.agentId}`,
        );
        this.pusherService.trigger(
          `company-${companyId}`,
          'conversation_updated',
          {
            conversation_id: conv.id,
            status: 'pending',
            agent_id: result.agentId,
            previous_agent_id: previousAgentId ?? null,
            assignment_mode: result.assignmentMode,
          },
        );
      }
    }

    return assigned;
  }

  private async isAgentOnline(agentId: number): Promise<boolean> {
    const agent = await this.userRepository.findOne({
      where: { id: agentId },
      select: ['id', 'is_agent_active'],
    });
    return Boolean(agent?.is_agent_active);
  }

  async processOpenUnassignedQueues(): Promise<number> {
    const companyRows = await this.conversationRepository
      .createQueryBuilder('c')
      .innerJoin('c.channelUser', 'channelUser')
      .select('DISTINCT channelUser.company_id', 'companyId')
      .where('LOWER(c.status) NOT IN (:...closedStatuses)', {
        closedStatuses: ['active', 'closed'],
      })
      .andWhere(
        `(
          c.assigned_agent_id IS NULL
          OR NOT EXISTS (
            SELECT 1
            FROM app_user a
            INNER JOIN companies co ON CAST(co.id AS BIGINT) = CAST(channelUser.company_id AS BIGINT)
            WHERE CAST(a.id AS BIGINT) = CAST(c.assigned_agent_id AS BIGINT)
              AND CAST(a.company_id AS BIGINT) = CAST(channelUser.company_id AS BIGINT)
              AND COALESCE(a.is_agent_active, FALSE) = TRUE
              AND (co.admin_user_id IS NULL OR CAST(a.id AS BIGINT) <> CAST(co.admin_user_id AS BIGINT))
          )
        )`,
      )
      .getRawMany<{ companyId: string | number }>();

    let total = 0;

    for (const row of companyRows) {
      const companyId = Number(row.companyId);
      if (!Number.isFinite(companyId) || companyId <= 0) {
        continue;
      }
      total += await this.assignOpenQueueForCompany(companyId);
    }

    if (total > 0) {
      this.logger.log(`Open queue auto-assigned ${total} conversation(s)`);
    }

    return total;
  }

  /**
   * Ensure WhatsApp inbound creates/updates bot_conversation and assigns an online agent.
   */
  async handleWhatsAppInboundForRouting(
    companyId: number,
    phone: string,
    displayName?: string,
    inbound?: InboundWhatsAppMessage,
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

    await this.persistInboundMessage(companyId, conversation.id, inbound);

    if (!this.shouldRouteInboundConversation(conversation)) {
      const assignedId = conversation.assigned_agent_id
        ? Number(conversation.assigned_agent_id)
        : null;
      if (
        conversation.status === 'pending' &&
        assignedId &&
        !(await this.isAgentOnline(assignedId))
      ) {
        const result = await this.routeInboundConversation(
          companyId,
          conversation.id,
          normalizedPhone,
          assignedId,
        );
        const refreshed = await this.conversationRepository.findOne({
          where: { id: conversation.id },
        });
        return {
          conversationId: conversation.id,
          assignedAgentId: result.agentId,
          status: refreshed?.status ?? (result.agentId ? 'pending' : 'open'),
        };
      }

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

    const refreshed = await this.conversationRepository.findOne({
      where: { id: conversation.id },
    });

    return {
      conversationId: conversation.id,
      assignedAgentId: result.agentId,
      status: refreshed?.status ?? (result.agentId ? 'pending' : 'open'),
    };
  }

  private async persistInboundMessage(
    companyId: number,
    conversationId: number,
    inbound?: InboundWhatsAppMessage,
  ) {
    const content = inbound?.content?.trim();
    if (!content) {
      return;
    }

    const messageType =
      inbound?.message_type === 'voice'
        ? 'voice'
        : inbound?.message_type === 'image'
          ? 'image'
          : 'text';

    await this.messageRepository.save(
      this.messageRepository.create({
        conversation_id: conversationId,
        direction: 'inbound',
        message_type: messageType,
        platform: 'whatsapp',
        content,
        source: inbound?.source?.trim() || 'customer',
      }),
    );

    this.pusherService.trigger(`company-${companyId}`, 'conversation_updated', {
      conversation_id: conversationId,
      inbound: true,
    });
  }
}
