import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { CreateProductCatergoryDto } from './dto/create-product_catergory.dto';
import { UpdateProductCatergoryDto } from './dto/update-product_catergory.dto';
import { ProductCatergoryService } from './product_catergory.service';

@Controller('product-catergory')
@ApiTags('Product Categories')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
export class ProductCatergoryController {
  constructor(
    private readonly productCatergoryService: ProductCatergoryService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create a product category' })
  create(
    @Body() createProductCatergoryDto: CreateProductCatergoryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.productCatergoryService.create(createProductCatergoryDto, user);
  }

  @Get()
  @ApiOperation({ summary: 'List product categories for the current company' })
  findAll(@CurrentUser() user: AuthenticatedUser) {
    return this.productCatergoryService.findAll(user);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one product category by id' })
  @ApiParam({ name: 'id', type: Number })
  findOne(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.productCatergoryService.findOne(+id, user);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a product category' })
  @ApiParam({ name: 'id', type: Number })
  update(
    @Param('id') id: string,
    @Body() updateProductCatergoryDto: UpdateProductCatergoryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.productCatergoryService.update(
      +id,
      updateProductCatergoryDto,
      user,
    );
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a product category' })
  @ApiParam({ name: 'id', type: Number })
  remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.productCatergoryService.remove(+id, user);
  }
}
