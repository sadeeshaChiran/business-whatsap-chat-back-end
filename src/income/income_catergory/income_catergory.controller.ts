import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
} from '@nestjs/common';
import { IncomeCatergoryService } from './income_catergory.service';
import { CreateIncomeCatergoryDto } from './dto/create-income_catergory.dto';
import { UpdateIncomeCatergoryDto } from './dto/update-income_catergory.dto';

@Controller('income-catergory')
export class IncomeCatergoryController {
  constructor(
    private readonly incomeCatergoryService: IncomeCatergoryService,
  ) {}

  @Post()
  create(@Body() createIncomeCatergoryDto: CreateIncomeCatergoryDto) {
    return this.incomeCatergoryService.create(createIncomeCatergoryDto);
  }

  @Get()
  findAll() {
    return this.incomeCatergoryService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.incomeCatergoryService.findOne(+id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() updateIncomeCatergoryDto: UpdateIncomeCatergoryDto,
  ) {
    return this.incomeCatergoryService.update(+id, updateIncomeCatergoryDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.incomeCatergoryService.remove(+id);
  }
}
