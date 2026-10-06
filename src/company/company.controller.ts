import { Body, Controller, Get, Param, ParseIntPipe, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AdminOnly } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { CompanyService } from './company.service';
import { UpdateCompanyDto } from './dto/update-company.dto';

/** The signed-in user's own workspace. Agents can read it (without secrets); only the admin can change it. */
@Controller('company')
@ApiTags('Company')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
export class CompanyController {
  constructor(private readonly companyService: CompanyService) {}

  @Get()
  findCurrent(@CurrentUser() user: AuthenticatedUser) {
    return this.companyService.findCurrent(user);
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthenticatedUser) {
    return this.companyService.findOne(id, user);
  }

  @Patch(':id')
  @AdminOnly()
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() updateCompanyDto: UpdateCompanyDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.companyService.update(id, updateCompanyDto, user);
  }
}
