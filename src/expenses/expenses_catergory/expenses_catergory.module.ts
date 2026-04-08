import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ExpensesCatergoryService } from './expenses_catergory.service';
import { ExpensesCatergoryController } from './expenses_catergory.controller';
import { ExpensesCatergory } from './entities/expenses_catergory.entity';

@Module({
  imports: [TypeOrmModule.forFeature([ExpensesCatergory])],
  controllers: [ExpensesCatergoryController],
  providers: [ExpensesCatergoryService],
  exports: [ExpensesCatergoryService, TypeOrmModule],
})
export class ExpensesCatergoryModule {}
