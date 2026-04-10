import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { IncomeCatergoryService } from './income_catergory.service';
import { CreateIncomeCatergoryDto } from './dto/create-income_catergory.dto';
import { UpdateIncomeCatergoryDto } from './dto/update-income_catergory.dto';

@Controller('income-catergory')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
export class IncomeCatergoryController {
  constructor(
    private readonly incomeCatergoryService: IncomeCatergoryService,
  ) {}

  @Post()
  create(
    @Body() createIncomeCatergoryDto: CreateIncomeCatergoryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.incomeCatergoryService.create(createIncomeCatergoryDto, user);
  }

  @Get()
  findAll(@CurrentUser() user: AuthenticatedUser) {
    return this.incomeCatergoryService.findAll(user);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.incomeCatergoryService.findOne(+id, user);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() updateIncomeCatergoryDto: UpdateIncomeCatergoryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.incomeCatergoryService.update(
      +id,
      updateIncomeCatergoryDto,
      user,
    );
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.incomeCatergoryService.remove(+id, user);
  }
}
