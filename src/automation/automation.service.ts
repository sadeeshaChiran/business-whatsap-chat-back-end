import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { SaveAutomationFlowDto } from './dto/save-automation-flow.dto';
import { AutomationFlow } from './entities/automation-flow.entity';

type FlowTriggerConfig = {
  keywords?: string;
  matchMode?: 'contains' | 'exact' | 'starts_with';
  caseSensitive?: string;
};

type FlowDefinition = {
  trigger?: { type: string; config?: FlowTriggerConfig };
  nodes?: unknown[];
  edges?: unknown[];
};

@Injectable()
export class AutomationService {
  constructor(@InjectRepository(AutomationFlow) private readonly flows: Repository<AutomationFlow>) {}

  list(user: AuthenticatedUser) {
    return this.flows.find({ where: { company_id: user.company_id }, order: { updated_at: 'DESC' } });
  }

  async get(user: AuthenticatedUser, id: number) {
    const flow = await this.flows.findOne({ where: { id, company_id: user.company_id } });
    if (!flow) throw new NotFoundException('Automation flow not found.');
    return flow;
  }

  create(user: AuthenticatedUser, dto: SaveAutomationFlowDto) {
    const prepared = this.prepareFlowDto(dto);
    return this.flows.save(this.flows.create({ ...prepared, company_id: user.company_id }));
  }

  async update(user: AuthenticatedUser, id: number, dto: SaveAutomationFlowDto) {
    const flow = await this.get(user, id);
    Object.assign(flow, this.prepareFlowDto(dto));
    return this.flows.save(flow);
  }

  async remove(user: AuthenticatedUser, id: number) {
    const flow = await this.get(user, id);
    await this.flows.remove(flow);
    return { id, removed: true };
  }
  async findMatchingActiveFlows(companyId: number, message: string, event: 'new_message' | 'conversation_started' = 'new_message') {
    const content = message.trim();
    if (!content) {
      return [];
    }
    const active = await this.flows.find({ where: { company_id: companyId, status: 'active' }, order: { updated_at: 'DESC' } });
    return active.filter((flow) => this.flowMatchesMessage(flow, content, event));
  }

  private flowMatchesMessage(flow: AutomationFlow, message: string, event: 'new_message' | 'conversation_started'): boolean {
    const definition = flow.definition as FlowDefinition;
    const trigger = definition?.trigger ?? { type: flow.trigger_type, config: {} };
    const type = trigger.type || flow.trigger_type;
    if (type === 'manual') {
      return false;
    }
    if (type === 'conversation_started') {
      return event === 'conversation_started';
    }
    if (type === 'new_message') {
      return event === 'new_message' || event === 'conversation_started';
    }
    if (type !== 'keyword_matches') {
      return false;
    }

    const config = trigger.config ?? {};
    const keywords = this.keywordArray(config.keywords || '');
    if (!keywords.length) {
      return false;
    }
    const caseSensitive = config.caseSensitive === 'true';
    const target = caseSensitive ? message : message.toLowerCase();
    return keywords.some((keyword) => {
      const needle = caseSensitive ? keyword : keyword.toLowerCase();
      if (config.matchMode === 'exact') {
        return target === needle;
      }
      if (config.matchMode === 'starts_with') {
        return target.startsWith(needle);
      }
      return target.includes(needle);
    });
  }

  private keywordArray(value: string): string[] {
    return value.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
  }

  private prepareFlowDto(dto: SaveAutomationFlowDto): SaveAutomationFlowDto {
    const triggerType = dto.trigger_type?.trim() || 'new_message';
    const definition = this.normalizeDefinition(dto.definition as FlowDefinition, triggerType);
    if (dto.status === 'active' && triggerType === 'keyword_matches' && !definition.trigger?.config?.keywords?.trim()) {
      throw new BadRequestException('Add at least one keyword before activating this flow.');
    }
    return {
      ...dto,
      name: dto.name.trim(),
      description: dto.description?.trim() || '',
      trigger_type: triggerType,
      definition,
    };
  }

  private normalizeDefinition(definition: FlowDefinition, triggerType: string) {
    const config = definition?.trigger?.config ?? {};
    return {
      trigger: {
        type: definition?.trigger?.type || triggerType,
        config: {
          keywords: this.normalizeKeywords(config.keywords || ''),
          matchMode: ['contains', 'exact', 'starts_with'].includes(String(config.matchMode)) ? config.matchMode : 'contains',
          caseSensitive: config.caseSensitive === 'true' ? 'true' : 'false',
        },
      },
      nodes: Array.isArray(definition?.nodes) ? definition.nodes : [],
      edges: Array.isArray(definition?.edges) ? definition.edges : [],
    };
  }

  private normalizeKeywords(value: string): string {
    return value
      .split(/\r?\n|,/)
      .map((item) => item.trim())
      .filter(Boolean)
      .join('\n');
  }
}