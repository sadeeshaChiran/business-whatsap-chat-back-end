import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './entities/user.entity';
import { Company } from '../company/entities/company.entity';
import { BotConversation } from '../bot-admin/entities/bot-conversation.entity';
import { AgentRoutingService } from '../agent-routing/agent-routing.service';
import { PusherService } from '../common/pusher.service';
import { randomBytes, scryptSync } from 'crypto';

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
  ) {}

  async getAgents(companyId: number): Promise<User[]> {
    return this.userRepository.find({
      where: { company_id: companyId },
      order: { id: 'ASC' },
    });
  }

  /**
   * Returns only non-admin agents with per-agent conversation stats.
   * Excludes the company admin (owner) so only actual support agents appear.
   * Accessible by any authenticated company member.
   */
  async getAgentsWithStats(companyId: number): Promise<Array<Omit<User, 'password_hash'> & {
    stats: {
      total_assigned: number;
      pending: number;
      active: number;
    };
  }>> {
    // Find the company to know which user is the owner/admin
    const company = await this.companyRepository.findOne({
      where: { id: companyId },
    });
    const adminUserId = company?.admin_user_id ? Number(company.admin_user_id) : null;

    const allUsers = await this.userRepository.find({
      where: { company_id: companyId },
      order: { id: 'ASC' },
    });

    // Exclude the company admin — only show actual support agents
    const agents = allUsers.filter(
      (u) => adminUserId === null || Number(u.id) !== adminUserId,
    );

    const result = await Promise.all(
      agents.map(async (agent) => {
        const [pending, active] = await Promise.all([
          this.conversationRepository.count({
            where: { assigned_agent_id: agent.id, status: 'pending' as any },
          }),
          this.conversationRepository.count({
            where: { assigned_agent_id: agent.id, status: 'active' as any },
          }),
        ]);

        const { password_hash, ...agentData } = agent as any;
        return {
          ...agentData,
          stats: {
            total_assigned: pending + active,
            pending,
            active,
          },
        };
      }),
    );

    return result;
  }

  async createAgent(
    companyId: number,
    name: string,
    email: string,
    password: string,
  ): Promise<Omit<User, 'password_hash'>> {
    const normalizedEmail = email.trim().toLowerCase();
    const existing = await this.userRepository.findOne({
      where: { email: normalizedEmail },
    });
    if (existing) {
      throw new ConflictException('User with this email already exists.');
    }

    const passwordHash = this.hashPassword(password);
    const user = this.userRepository.create({
      name: name.trim(),
      email: normalizedEmail,
      password_hash: passwordHash,
      company_id: companyId,
      is_active: true,
    });

    const saved = await this.userRepository.save(user);
    const { password_hash, ...result } = saved;
    return result as any;
  }

  async toggleAgent(companyId: number, agentId: number): Promise<User> {
    const user = await this.userRepository.findOne({
      where: { id: agentId, company_id: companyId },
    });
    if (!user) {
      throw new NotFoundException('Agent not found.');
    }

    const wasActive = user.is_agent_active;
    user.is_agent_active = !user.is_agent_active;
    const saved = await this.userRepository.save(user);

    if (wasActive && !saved.is_agent_active) {
      await this.agentRoutingService.reroutePendingConversationsForAgent(
        companyId,
        saved.id,
      );
    }

    this.pusherService.trigger(
      `company-${companyId}`,
      'agent_status_changed',
      { agent_id: saved.id, is_agent_active: saved.is_agent_active },
    );

    return saved;
  }

  private hashPassword(password: string): string {
    const salt = randomBytes(16).toString('hex');
    const hash = scryptSync(password, salt, 64).toString('hex');
    return `${salt}:${hash}`;
  }
}
