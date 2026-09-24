import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { SaveAutomationFlowDto } from './dto/save-automation-flow.dto';
import { AutomationFlow } from './entities/automation-flow.entity';

@Injectable()
export class AutomationService {
  constructor(@InjectRepository(AutomationFlow) private readonly flows: Repository<AutomationFlow>) {}
  list(user: AuthenticatedUser) { return this.flows.find({ where: { company_id: user.company_id }, order: { updated_at: 'DESC' } }); }
  async get(user: AuthenticatedUser, id: number) {
    const flow = await this.flows.findOne({ where: { id, company_id: user.company_id } });
    if (!flow) throw new NotFoundException('Automation flow not found.');
    return flow;
  }
  create(user: AuthenticatedUser, dto: SaveAutomationFlowDto) {
    return this.flows.save(this.flows.create({ ...dto, name: dto.name.trim(), description: dto.description?.trim() || '', company_id: user.company_id }));
  }
  async update(user: AuthenticatedUser, id: number, dto: SaveAutomationFlowDto) {
    const flow = await this.get(user, id);
    Object.assign(flow, dto, { name: dto.name.trim(), description: dto.description?.trim() || '' });
    return this.flows.save(flow);
  }
  async remove(user: AuthenticatedUser, id: number) { const flow = await this.get(user, id); await this.flows.remove(flow); return { id, removed: true }; }
}
