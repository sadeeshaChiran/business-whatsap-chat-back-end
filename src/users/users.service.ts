import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AgentRoutingService } from '../agent-routing/agent-routing.service';
import { AuthService } from '../auth/auth.service';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { BotConversation } from '../bot-admin/entities/bot-conversation.entity';
import { PusherService } from '../common/pusher.service';
import { Company } from '../company/entities/company.entity';
import { PlanService } from '../platform/plan.service';
import { CreateAgentDto, UpdateAgentDto } from './dto/agent.dto';
import { User } from './entities/user.entity';

/** Public shape of a team member – never includes the password hash or security counters. */
export type TeamMember = {
  id: number;
  name: string;
  email: string;
  company_id: number | null;
  is_admin: boolean;
  is_active: boolean;
  is_agent_active: boolean;
  access_disabled: boolean;
  work_status: 'online' | 'offline' | 'no_need' | 'removed';
  last_login_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Company)
    private readonly companyRepository: Repository<Company>,
    @InjectRepository(BotConversation)
    private readonly conversationRepository: Repository<BotConversation>,
    private readonly agentRoutingService: AgentRoutingService,
    private readonly pusherService: PusherService,
    private readonly planService: PlanService,
    private readonly authService: AuthService,
  ) {}

  static toMember(user: User, adminUserId: number | null): TeamMember {
    const workStatus: TeamMember['work_status'] = user.access_disabled
      ? 'removed'
      : !user.is_active
        ? 'no_need'
        : user.is_agent_active
          ? 'online'
          : 'offline';
    return {
      id: Number(user.id),
      name: user.name,
      email: user.email,
      company_id: user.company_id != null ? Number(user.company_id) : null,
      is_admin: adminUserId !== null && Number(user.id) === adminUserId,
      is_active: user.is_active,
      is_agent_active: Boolean(user.is_agent_active),
      access_disabled: Boolean(user.access_disabled),
      work_status: workStatus,
      last_login_at: user.last_login_at ?? null,
      created_at: user.created_at,
      updated_at: user.updated_at,
    };
  }

  private async adminUserId(companyId: number): Promise<number | null> {
    const company = await this.companyRepository.findOne({ where: { id: companyId }, select: { id: true, admin_user_id: true } });
    return company?.admin_user_id ? Number(company.admin_user_id) : null;
  }

  /** All members of the company (admin + agents) for the admin's Team page. */
  async getAgents(companyId: number): Promise<TeamMember[]> {
    const [users, adminId] = await Promise.all([
      this.userRepository.find({ where: { company_id: companyId }, order: { id: 'ASC' } }),
      this.adminUserId(companyId),
    ]);
    return users.map((user) => UsersService.toMember(user, adminId));
  }

  /**
   * Agents (not the owner) with per-agent conversation counts.
   * Readable by any company member for the team board.
   */
  async getAgentsWithStats(companyId: number) {
    const adminUserId = await this.adminUserId(companyId);
    const allUsers = await this.userRepository.find({ where: { company_id: companyId }, order: { id: 'ASC' } });
    const agents = allUsers.filter((u) => (adminUserId === null || Number(u.id) !== adminUserId) && !u.access_disabled);

    const countRows = await this.conversationRepository
      .createQueryBuilder('c')
      .innerJoin(User, 'agent', 'agent.id = c.assigned_agent_id')
      .select('c.assigned_agent_id', 'agentId')
      .addSelect('LOWER(c.status)', 'status')
      .addSelect('COUNT(*)', 'count')
      .where('agent.company_id = :companyId', { companyId })
      .andWhere('LOWER(c.status) IN (:...statuses)', { statuses: ['pending', 'active'] })
      .groupBy('c.assigned_agent_id')
      .addGroupBy('LOWER(c.status)')
      .getRawMany<{ agentId: string | number; status: string; count: string }>();

    const countByAgent = new Map<number, { pending: number; active: number }>();
    for (const row of countRows) {
      const agentId = Number(row.agentId);
      if (!Number.isFinite(agentId)) continue;
      const bucket = countByAgent.get(agentId) ?? { pending: 0, active: 0 };
      if (row.status === 'pending') bucket.pending += Number(row.count) || 0;
      else if (row.status === 'active') bucket.active += Number(row.count) || 0;
      countByAgent.set(agentId, bucket);
    }

    return agents.map((agent) => {
      const counts = countByAgent.get(Number(agent.id)) ?? { pending: 0, active: 0 };
      return {
        ...UsersService.toMember(agent, adminUserId),
        stats: { total_assigned: counts.pending + counts.active, pending: counts.pending, active: counts.active },
      };
    });
  }

  async createAgent(companyId: number, dto: CreateAgentDto): Promise<TeamMember> {
    const normalizedEmail = dto.email.trim().toLowerCase();
    const existing = await this.userRepository
      .createQueryBuilder('u')
      .where('LOWER(u.email) = :email', { email: normalizedEmail })
      .getOne();
    if (existing) throw new ConflictException('Another account already uses this email.');

    const company = await this.companyRepository.findOne({ where: { id: companyId } });
    if (!company || !String(company.plan ?? '').trim()) {
      throw new BadRequestException('Select a package before adding agents.');
    }
    const maxAgents = await this.planService.maxAgents(company.plan);
    const adminUserId = company.admin_user_id ? Number(company.admin_user_id) : null;
    if (maxAgents !== null) {
      const seatsUsed = await this.userRepository
        .createQueryBuilder('user')
        .where('user.company_id = :companyId', { companyId })
        .andWhere('COALESCE(user.access_disabled, FALSE) = FALSE')
        .andWhere(adminUserId ? 'user.id <> :adminUserId' : '1=1', { adminUserId })
        .getCount();
      if (seatsUsed >= maxAgents) {
        throw new BadRequestException(`Your package allows ${maxAgents} agents. Remove an agent or upgrade to add more.`);
      }
    }

    const saved = await this.userRepository.save(
      this.userRepository.create({
        name: dto.name.trim(),
        email: normalizedEmail,
        password_hash: this.authService.hashPassword(dto.password),
        company_id: companyId,
        is_active: true,
        is_agent_active: false,
        password_changed_at: new Date(),
      }),
    );
    return UsersService.toMember(saved, adminUserId);
  }

  /** An agent of the admin's own company (never the admin, never another company). */
  private async findCompanyAgent(admin: AuthenticatedUser, agentId: number): Promise<User> {
    if (Number(agentId) === Number(admin.id)) {
      throw new BadRequestException('You cannot change your own account here. Use Settings → Account.');
    }
    const user = await this.userRepository.findOne({ where: { id: agentId, company_id: admin.company_id } });
    if (!user) throw new NotFoundException('Agent not found.');
    return user;
  }

  async updateAgent(admin: AuthenticatedUser, agentId: number, dto: UpdateAgentDto): Promise<TeamMember> {
    const user = await this.findCompanyAgent(admin, agentId);
    if (dto.name !== undefined) user.name = dto.name.trim();
    const saved = await this.userRepository.save(user);
    this.authService.invalidateAccount(saved.id);
    return UsersService.toMember(saved, Number(admin.id));
  }

  async resetAgentPassword(admin: AuthenticatedUser, agentId: number, password: string) {
    const user = await this.findCompanyAgent(admin, agentId);
    await this.authService.setPassword(user.id, password);
    return { id: Number(user.id), password_reset: true };
  }

  /** Remove / restore an agent's access. Removing signs the agent out and sends their chats back to the queue. */
  async setAgentAccess(admin: AuthenticatedUser, agentId: number, enabled: boolean): Promise<TeamMember> {
    const user = await this.findCompanyAgent(admin, agentId);
    const companyId = Number(admin.company_id);

    if (enabled) {
      if (!user.access_disabled) return UsersService.toMember(user, Number(admin.id));
      const company = await this.companyRepository.findOne({ where: { id: companyId } });
      const maxAgents = company ? await this.planService.maxAgents(company.plan) : null;
      if (maxAgents !== null) {
        const seatsUsed = await this.userRepository
          .createQueryBuilder('user')
          .where('user.company_id = :companyId', { companyId })
          .andWhere('COALESCE(user.access_disabled, FALSE) = FALSE')
          .andWhere('user.id <> :adminId', { adminId: admin.id })
          .getCount();
        if (seatsUsed >= maxAgents) {
          throw new BadRequestException(`Your package allows ${maxAgents} agents. Remove another agent or upgrade first.`);
        }
      }
      user.access_disabled = false;
      user.is_active = true;
      const saved = await this.userRepository.save(user);
      this.authService.invalidateAccount(saved.id);
      return UsersService.toMember(saved, Number(admin.id));
    }

    user.access_disabled = true;
    user.is_agent_active = false;
    user.is_active = false;
    const saved = await this.userRepository.save(user);
    await this.authService.revokeSessions(saved.id);

    // the agent's open chats go back to the queue so customers are not left waiting
    await this.conversationRepository
      .createQueryBuilder()
      .update(BotConversation)
      .set({ assigned_agent_id: null, status: 'open', assignment_mode: 'unassigned', timeout_at: null })
      .where('assigned_agent_id = :agentId', { agentId: saved.id })
      .andWhere('LOWER(status) IN (:...statuses)', { statuses: ['pending', 'active'] })
      .execute();
    const autoAssigned = await this.agentRoutingService.assignOpenQueueForCompany(companyId);

    this.pusherService.trigger(`company-${companyId}`, 'agent_status_changed', {
      agent_id: saved.id,
      is_active: false,
      is_agent_active: false,
      status: 'removed',
    });
    this.pusherService.trigger(`company-${companyId}`, 'conversation_updated', { auto_assigned: autoAssigned });
    return UsersService.toMember(saved, Number(admin.id));
  }

  async updateAgentWorkStatus(companyId: number, agentId: number, status: 'online' | 'offline' | 'no_need') {
    const user = await this.userRepository.findOne({ where: { id: agentId, company_id: companyId } });
    if (!user) throw new NotFoundException('Agent not found.');
    if (user.access_disabled) throw new BadRequestException('This agent was removed. Restore access first.');
    user.is_active = status !== 'no_need';
    user.is_agent_active = status === 'online';
    const saved = await this.userRepository.save(user);
    let autoAssigned = 0;
    if (saved.is_agent_active) {
      autoAssigned = await this.agentRoutingService.assignOpenQueueForCompany(companyId);
    } else {
      await this.agentRoutingService.releasePendingChatsWhenNoOnlineAgents(companyId);
    }
    this.pusherService.trigger(`company-${companyId}`, 'agent_status_changed', {
      agent_id: saved.id,
      is_active: saved.is_active,
      is_agent_active: saved.is_agent_active,
      status,
    });
    const adminId = await this.adminUserId(companyId);
    return { ...UsersService.toMember(saved, adminId), auto_assigned: autoAssigned };
  }

  async toggleAgent(companyId: number, agentId: number) {
    const user = await this.userRepository.findOne({ where: { id: agentId, company_id: companyId } });
    if (!user) throw new NotFoundException('Agent not found.');
    if (user.access_disabled) throw new BadRequestException('This agent was removed. Restore access first.');

    user.is_agent_active = !user.is_agent_active;
    const saved = await this.userRepository.save(user);

    let autoAssigned = 0;
    if (saved.is_agent_active) {
      autoAssigned = await this.agentRoutingService.assignOpenQueueForCompany(companyId);
      if (autoAssigned > 0) {
        this.pusherService.trigger(`company-${companyId}`, 'conversation_updated', { auto_assigned: autoAssigned });
      }
    } else {
      await this.agentRoutingService.releasePendingChatsWhenNoOnlineAgents(companyId);
    }

    this.pusherService.trigger(`company-${companyId}`, 'agent_status_changed', {
      agent_id: saved.id,
      is_agent_active: saved.is_agent_active,
    });
    const adminId = await this.adminUserId(companyId);
    return { ...UsersService.toMember(saved, adminId), auto_assigned: autoAssigned };
  }
}
