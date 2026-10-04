import { Controller, Get, Module, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { InjectRepository, TypeOrmModule } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuthModule } from '../../auth/auth.module';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { Industry } from './entities/industry.entity';

/** Business types for the company profile (read-only). */
@Controller('industry')
@ApiTags('Company')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
export class IndustryController {
  constructor(@InjectRepository(Industry) private readonly industries: Repository<Industry>) {}

  @Get()
  list() {
    return this.industries.find({ where: { is_active: true }, order: { name: 'ASC' } });
  }
}

@Module({ imports: [AuthModule, TypeOrmModule.forFeature([Industry])], controllers: [IndustryController] })
export class IndustryModule {}
