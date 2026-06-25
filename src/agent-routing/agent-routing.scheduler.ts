import {
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { AgentRoutingService } from './agent-routing.service';

@Injectable()
export class AgentRoutingScheduler implements OnModuleInit, OnModuleDestroy {
  private interval?: ReturnType<typeof setInterval>;

  constructor(private readonly agentRoutingService: AgentRoutingService) {}

  onModuleInit() {
    const minutes = Math.max(
      1,
      Number(process.env.AGENT_ROUTING_CHECK_MINUTES ?? 1),
    );
    this.interval = setInterval(() => {
      void this.agentRoutingService.processPendingTimeouts();
      void this.agentRoutingService.processOpenUnassignedQueues();
    }, minutes * 60_000);
    void this.agentRoutingService.processPendingTimeouts();
    void this.agentRoutingService.processOpenUnassignedQueues();
  }

  onModuleDestroy() {
    if (this.interval) {
      clearInterval(this.interval);
    }
  }
}
