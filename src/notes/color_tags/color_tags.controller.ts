import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { ColorTagsService } from './color_tags.service';
import { CreateColorTagDto } from './dto/create-color_tag.dto';
import { UpdateColorTagDto } from './dto/update-color_tag.dto';

@Controller('color-tags')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
export class ColorTagsController {
  constructor(private readonly colorTagsService: ColorTagsService) {}

  @Post()
  create(
    @Body() createColorTagDto: CreateColorTagDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.colorTagsService.create(createColorTagDto, user);
  }

  @Get()
  findAll(@CurrentUser() user: AuthenticatedUser) {
    return this.colorTagsService.findAll(user);
  }

  @Get(':id')
  findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.colorTagsService.findOne(id, user);
  }

  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() updateColorTagDto: UpdateColorTagDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.colorTagsService.update(id, updateColorTagDto, user);
  }

  @Delete(':id')
  remove(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.colorTagsService.remove(id, user);
  }
}
