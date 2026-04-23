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

  private async assertCompanyAdmin(user: AuthenticatedUser) {
    const company = await this.companyRepository.findOne({
      where: { id: user.company_id },
    });

    if (!company || company.admin_user_id !== user.id) {
      throw new ForbiddenException('Only the company admin can manage bot settings.');
    }
  }

  async getUsers(user: AuthenticatedUser, query: BotUsersQueryDto) {
    await this.assertCompanyAdmin(user);
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const offset = (page - 1) * limit;

    const [items, total] = await Promise.all([
      this.channelUserRepository
        .createQueryBuilder('channel_user')
        .leftJoinAndSelect('channel_user.conversations', 'conversation')
        .where('channel_user.company_id = :companyId', { companyId: user.company_id })
        .orderBy('channel_user.last_seen_at', 'DESC')
        .addOrderBy('channel_user.id', 'DESC')
        .skip(offset)
        .take(limit)
        .getMany(),
      this.channelUserRepository.count({
        where: { company_id: user.company_id },
      }),
    ]);

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
    await this.assertCompanyAdmin(user);
    const channelUser = await this.channelUserRepository.findOne({
      where: { id, company_id: user.company_id },
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
    await this.assertCompanyAdmin(user);
    const unresolvedOnly = query.unresolved !== 'false';

    const builder = this.flagRepository
      .createQueryBuilder('flag')
      .leftJoinAndSelect('flag.channelUser', 'channel_user')
      .leftJoinAndSelect('flag.conversation', 'conversation')
      .where('channel_user.company_id = :companyId', { companyId: user.company_id })
      .orderBy('flag.created_at', 'DESC');

    if (unresolvedOnly) {
      builder.andWhere('flag.resolved = false');
    }

    return builder.getMany();
  }

  async getConversation(user: AuthenticatedUser, id: number) {
    await this.assertCompanyAdmin(user);
    const conversation = await this.conversationRepository.findOne({
      where: {
        id,
        channelUser: { company_id: user.company_id },
      },
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
    await this.assertCompanyAdmin(user);
    const item = this.trainingRepository.create({
      company_id: user.company_id,
      question: payload.question.trim(),
      answer: payload.answer.trim(),
      category: payload.category?.trim() ?? '',
      language: payload.language?.trim() ?? 'English',
      is_active: true,
    });

    return this.trainingRepository.save(item);
  }
}
