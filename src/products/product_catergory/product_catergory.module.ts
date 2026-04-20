import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../../auth/auth.module';
import { ProductCategoryVariant } from './entities/product_category_variant.entity';
import { ProductCatergory } from './entities/product_catergory.entity';
import { ProductCatergoryController } from './product_catergory.controller';
import { ProductCatergoryService } from './product_catergory.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([ProductCatergory, ProductCategoryVariant]),
    AuthModule,
  ],
  controllers: [ProductCatergoryController],
  providers: [ProductCatergoryService],
  exports: [ProductCatergoryService, TypeOrmModule],
})
export class ProductCatergoryModule {}
