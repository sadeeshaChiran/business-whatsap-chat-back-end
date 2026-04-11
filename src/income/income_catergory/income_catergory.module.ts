import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../../auth/auth.module';
import { IncomeCatergoryService } from './income_catergory.service';
import { IncomeCatergoryController } from './income_catergory.controller';
import { IncomeCatergory } from './entities/income_catergory.entity';

@Module({
  imports: [TypeOrmModule.forFeature([IncomeCatergory]), AuthModule],
  controllers: [IncomeCatergoryController],
  providers: [IncomeCatergoryService],
  exports: [IncomeCatergoryService, TypeOrmModule],
})
export class IncomeCatergoryModule {}
