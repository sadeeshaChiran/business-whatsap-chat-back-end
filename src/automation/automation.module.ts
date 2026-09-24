import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { AutomationController } from './automation.controller';
import { AutomationService } from './automation.service';
import { AutomationFlow } from './entities/automation-flow.entity';

@Module({
	imports: [AuthModule, TypeOrmModule.forFeature([AutomationFlow])],
	controllers: [AutomationController],
	providers: [AutomationService],
})
export class AutomationModule {}
