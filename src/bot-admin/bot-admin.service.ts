import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { Company } from '../company/entities/company.entity';
import { CreateBotTrainingDto } from './dto/create-bot-training.dto';
import { BotFlagsQueryDto } from './dto/bot-flags-query.dto';
import { BotUsersQueryDto } from './dto/bot-users-query.dto';
import { ToggleBotUserDto } from './dto/toggle-bot-user.dto';
import { BotChannelUser } from './entities/bot-channel-user.entity';
import { BotConversation } from './entities/bot-conversation.entity';
import { BotFlag } from './entities/bot-flag.entity';
import { BotMessage } from './entities/bot-message.entity';
import { BotTrainingData } from './entities/bot-training-data.entity';

@Injectable()
export class BotAdminService {
  constructor(
    @InjectRepository(Company)
    private readonly companyRepository: Repository<Company>,
    @InjectRepository(BotChannelUser)
    private readonly channelUserRepository: Repository<BotChannelUser>,
    @InjectRepository(BotConversation)
    private readonly conversationRepository: Repository<BotConversation>,
    @InjectRepository(BotMessage)
    private readonly messageRepository: Repository<BotMessage>,
    @InjectRepository(BotTrainingData)
    private readonly trainingRepository: Repository<BotTrainingData>,
    @InjectRepository(BotFlag)
    private readonly flagRepository: Repository<BotFlag>,
  ) {}

  async getStats(user: AuthenticatedUser) {
    await this.assertAdminAccess(user);
    const [totalUsers, activeBots, totalConversations, pendingAlerts] = await Promise.all([
      this.channelUserRepository.count(),
      this.channelUserRepository.count({ where: { bot_enabled: true } }),
      this.conversationRepository.count(),
      this.flagRepository.count({ where: { resolved: false } }),
    ]);

    return {
      totalUsers,
      activeBots,
      totalConversations,
      pendingAlerts,
    };
  }

  private async assertAdminAccess(user: AuthenticatedUser, requireSuperAdmin = false) {
    if (user.is_admin) {
      return;
    }

    if (requireSuperAdmin) {
      throw new ForbiddenException('Only a system admin can perform this action.');
    }

    const company = await this.companyRepository.findOne({
      where: { id: user.company_id },
    });

    if (!company || company.admin_user_id !== user.id) {
      throw new ForbiddenException('Only the company admin can manage bot settings.');
    }
  }

  async getUsers(user: AuthenticatedUser, query: BotUsersQueryDto) {
    await this.assertAdminAccess(user);
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const offset = (page - 1) * limit;

    const builder = this.channelUserRepository
      .createQueryBuilder('channel_user')
      .leftJoinAndSelect('channel_user.conversations', 'conversation')
      .orderBy('channel_user.last_seen_at', 'DESC')
      .addOrderBy('channel_user.id', 'DESC')
      .skip(offset)
      .take(limit);

    if (!user.is_admin) {
      builder.where('channel_user.company_id = :companyId', { companyId: user.company_id });
    }

    const [items, total] = await builder.getManyAndCount();

    return {
      items: items.map((item) => ({
        id: item.id,
        platform: item.platform,
        external_user_id: item.external_user_id,
        display_name: item.display_name,
        language: item.language,
        bot_enabled: item.bot_enabled,
        manual_mode: item.manual_mode,
        last_seen_at: item.last_seen_at,
        latest_conversation_id:
          [...(item.conversations ?? [])]
            .sort((left, right) => {
              const leftTime = left.last_message_at ? new Date(left.last_message_at).getTime() : 0;
              const rightTime = right.last_message_at ? new Date(right.last_message_at).getTime() : 0;
              return rightTime - leftTime;
            })[0]?.id ?? null,
      })),
      pagination: {
        page,
        limit,
        total,
      },
    };
  }

  async toggleUser(
    user: AuthenticatedUser,
    id: number,
    payload: ToggleBotUserDto,
  ) {
    await this.assertAdminAccess(user, true); // Only super admin can toggle bot
    const where: any = { id };
    if (!user.is_admin) {
      where.company_id = user.company_id;
    }

    const channelUser = await this.channelUserRepository.findOne({
      where,
    });

    if (!channelUser) {
      throw new NotFoundException('Bot user not found.');
    }

    channelUser.bot_enabled = !channelUser.bot_enabled;
    channelUser.manual_mode =
      channelUser.bot_enabled === false
        ? payload.manual_mode ?? true
        : false;

    const saved = await this.channelUserRepository.save(channelUser);
    return {
      id: saved.id,
      bot_enabled: saved.bot_enabled,
      manual_mode: saved.manual_mode,
    };
  }

  async getFlags(user: AuthenticatedUser, query: BotFlagsQueryDto) {
    await this.assertAdminAccess(user);
    const unresolvedOnly = query.unresolved !== 'false';

    const builder = this.flagRepository
      .createQueryBuilder('flag')
      .leftJoinAndSelect('flag.channelUser', 'channel_user')
      .leftJoinAndSelect('flag.conversation', 'conversation')
      .orderBy('flag.created_at', 'DESC');

    if (!user.is_admin) {
      builder.where('channel_user.company_id = :companyId', { companyId: user.company_id });
    }

    if (unresolvedOnly) {
      builder.andWhere('flag.resolved = false');
    }

    return builder.getMany();
  }

  async getConversations(user: AuthenticatedUser) {
    await this.assertAdminAccess(user);
    const builder = this.conversationRepository
      .createQueryBuilder('conversation')
      .leftJoinAndSelect('conversation.channelUser', 'channelUser')
      .orderBy('conversation.last_message_at', 'DESC');

    if (!user.is_admin) {
      builder.where('channelUser.company_id = :companyId', { companyId: user.company_id });
    }

    return builder.getMany();
  }

  async getConversation(user: AuthenticatedUser, id: number) {
    await this.assertAdminAccess(user);
    const where: any = { id };
    if (!user.is_admin) {
      where.channelUser = { company_id: user.company_id };
    }

    const conversation = await this.conversationRepository.findOne({
      where,
      relations: ['channelUser'],
    });

    if (!conversation) {
      throw new NotFoundException('Conversation not found.');
    }

    const messages = await this.messageRepository.find({
      where: { conversation_id: id },
      order: { id: 'ASC' },
    });

    return {
      conversation,
      messages,
    };
  }

  async createTraining(user: AuthenticatedUser, payload: CreateBotTrainingDto) {
    await this.assertAdminAccess(user);
    const item = this.trainingRepository.create({
      company_id: user.is_admin ? null : user.company_id,
      question: payload.question.trim(),
      answer: payload.answer.trim(),
      category: payload.category?.trim() ?? '',
      language: payload.language?.trim() ?? 'English',
      is_active: true,
    });

    return this.trainingRepository.save(item);
  }

  async uploadTrainingFile(
    user: AuthenticatedUser,
    file: any,
    category?: string,
  ) {
    await this.assertAdminAccess(user);

    const content = file.buffer.toString('utf-8');
    // If it's an image, we can't just toString('utf-8'), but for now we'll assume it's a doc
    // In a real app, we'd use OCR here.
    
    const item = this.trainingRepository.create({
      company_id: user.is_admin ? null : user.company_id,
      question: `Document: ${file.originalname}`,
      answer: `[File Content from ${file.originalname}]`, // We should store the real content if possible
      category: category?.trim() ?? 'Document',
      language: 'English',
      is_active: true,
    });

    return this.trainingRepository.save(item);
  }

  async getTrainingHistory(user: AuthenticatedUser) {
    await this.assertAdminAccess(user);
    const builder = this.trainingRepository
      .createQueryBuilder('training')
      .orderBy('training.created_at', 'DESC')
      .take(10);

    if (!user.is_admin) {
      builder.where('training.company_id = :companyId', { companyId: user.company_id });
    } else {
      builder.where('training.company_id IS NULL');
    }

    return builder.getMany();
  }
}
