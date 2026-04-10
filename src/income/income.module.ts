import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { IncomeService } from './income.service';
import { IncomeController } from './income.controller';
import { IncomeCatergoryModule } from './income_catergory/income_catergory.module';
import { Income } from './entities/income.entity';
import { IncomeCatergory } from './income_catergory/entities/income_catergory.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Income, IncomeCatergory]),
    AuthModule,
    IncomeCatergoryModule,
  ],
  controllers: [IncomeController],
  providers: [IncomeService],
})
export class IncomeModule {}
