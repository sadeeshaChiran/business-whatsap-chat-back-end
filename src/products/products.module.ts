import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { ProductVariant } from './entities/product-variant.entity';
import { Product } from './entities/product.entity';
import { ProductCatergoryModule } from './product_catergory/product_catergory.module';
import { ProductCatergory } from './product_catergory/entities/product_catergory.entity';
import { PRODUCT_DATA_SOURCE } from './product-database';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';

@Module({
  imports: [
    TypeOrmModule.forFeature(
      [Product, ProductVariant, ProductCatergory],
      PRODUCT_DATA_SOURCE,
    ),
    AuthModule,
    ProductCatergoryModule,
  ],
  controllers: [ProductsController],
  providers: [ProductsService],
})
export class ProductsModule {}
