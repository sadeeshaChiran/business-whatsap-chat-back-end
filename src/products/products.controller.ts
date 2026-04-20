import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { CreateProductDto } from './dto/create-product.dto';
import { ImportProductsFileDto } from './dto/import-products-file.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ProductsService } from './products.service';

@Controller('products')
@ApiTags('Products')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a product with optional variants' })
  create(
    @Body() createProductDto: CreateProductDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.productsService.create(createProductDto, user);
  }

  @Post('import')
  @ApiOperation({ summary: 'Import products from CSV or Excel' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: ImportProductsFileDto })
  @UseInterceptors(FileInterceptor('file'))
  importProducts(
    @UploadedFile() file: { buffer: Buffer } | undefined,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.productsService.import(file, user);
  }

  @Get()
  @ApiOperation({ summary: 'List products for the current company' })
  @ApiQuery({
    name: 'category_id',
    required: false,
    type: Number,
    description: 'Optional product category id filter',
  })
  findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Query('category_id') categoryId?: string,
  ) {
    return this.productsService.findAll(
      user,
      categoryId ? Number(categoryId) : undefined,
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one product by id' })
  @ApiParam({ name: 'id', type: Number })
  findOne(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.productsService.findOne(+id, user);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a product and replace variants if provided' })
  @ApiParam({ name: 'id', type: Number })
  update(
    @Param('id') id: string,
    @Body() updateProductDto: UpdateProductDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.productsService.update(+id, updateProductDto, user);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Soft delete a product' })
  @ApiParam({ name: 'id', type: Number })
  remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.productsService.remove(+id, user);
  }
}
