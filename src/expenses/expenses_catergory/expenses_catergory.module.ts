import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../../auth/auth.module';
import { ExpensesCatergoryService } from './expenses_catergory.service';
import { ExpensesCatergoryController } from './expenses_catergory.controller';
import { ExpensesCatergory } from './entities/expenses_catergory.entity';

@Module({
  imports: [TypeOrmModule.forFeature([ExpensesCatergory]), AuthModule],
  controllers: [ExpensesCatergoryController],
  providers: [ExpensesCatergoryService],
  exports: [ExpensesCatergoryService, TypeOrmModule],
})
export class ExpensesCatergoryModule {}
