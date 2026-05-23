import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../../auth/auth.module';
import { Company } from '../../company/entities/company.entity';
import { PRODUCT_DATA_SOURCE } from '../product-database';
import { ProductCatergory } from './entities/product_catergory.entity';
import { ProductCatergoryController } from './product_catergory.controller';
import { ProductCatergoryService } from './product_catergory.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([ProductCatergory], PRODUCT_DATA_SOURCE),
    TypeOrmModule.forFeature([Company]),
    AuthModule,
  ],
  controllers: [ProductCatergoryController],
  providers: [ProductCatergoryService],
  exports: [ProductCatergoryService, TypeOrmModule],
})
export class ProductCatergoryModule {}
