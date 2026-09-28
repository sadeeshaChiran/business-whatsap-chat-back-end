import {
  Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { memoryStorage } from 'multer';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import {
  BookingsQueryDto, CreateBotServiceDto, CreateDeliveryZoneDto, RepliesQueryDto, ReportQueryDto, SalesBotTestDto,
  SimulateCustomerMessageDto, SimulatorConversationQueryDto, UpdateBookingStatusDto, UpdateBotServiceDto,
  UpdateDeliveryZoneDto, UpdateSalesBotSettingsDto,
} from './dto/sales-bot.dto';
import { SalesBotAdminService } from './sales-bot-admin.service';

/** Endpoints for the Sales bot pages (docs: frontend docs/SALES_BOT_API.md). Admin only. */
@Controller('bot')
@ApiTags('Sales Bot')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
export class SalesBotController {
  constructor(private readonly service: SalesBotAdminService) {}

  /* Services */
  @Get('services')
  listServices(@CurrentUser() user: AuthenticatedUser) {
    return this.service.listServices(user);
  }

  @Post('services')
  createService(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateBotServiceDto) {
    return this.service.createService(user, dto);
  }

  @Patch('services/:id')
  updateService(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number, @Body() dto: UpdateBotServiceDto) {
    return this.service.updateService(user, id, dto);
  }

  @Delete('services/:id')
  deleteService(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number) {
    return this.service.deleteService(user, id);
  }

  /* Delivery zones */
  @Get('delivery-zones')
  listZones(@CurrentUser() user: AuthenticatedUser) {
    return this.service.listZones(user);
  }

  @Post('delivery-zones')
  createZone(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateDeliveryZoneDto) {
    return this.service.createZone(user, dto);
  }

  @Patch('delivery-zones/:id')
  updateZone(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number, @Body() dto: UpdateDeliveryZoneDto) {
    return this.service.updateZone(user, id, dto);
  }

  @Delete('delivery-zones/:id')
  deleteZone(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number) {
    return this.service.deleteZone(user, id);
  }

  /* Bookings */
  @Get('bookings')
  listBookings(@CurrentUser() user: AuthenticatedUser, @Query() query: BookingsQueryDto) {
    return this.service.listBookings(user, query);
  }

  @Patch('bookings/:id/status')
  updateBookingStatus(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number, @Body() dto: UpdateBookingStatusDto) {
    return this.service.updateBookingStatus(user, id, dto);
  }

  /* Settings */
  @Get('sales-bot/settings')
  getSettings(@CurrentUser() user: AuthenticatedUser) {
    return this.service.getSettings(user);
  }

  @Patch('sales-bot/settings')
  updateSettings(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdateSalesBotSettingsDto) {
    return this.service.updateSettings(user, dto);
  }

  /* Test chat (nothing saved or sent) */
  @Post('sales-bot/test')
  test(@CurrentUser() user: AuthenticatedUser, @Body() dto: SalesBotTestDto) {
    return this.service.testReply(user, dto);
  }

  /* Customer simulator (SALES_BOT_TEST_MODE=true) */
  @Get('sales-bot/simulate/status')
  simulatorStatus() {
    return this.service.simulatorStatus();
  }

  @Get('sales-bot/simulate/conversation')
  simulatorConversation(@CurrentUser() user: AuthenticatedUser, @Query() query: SimulatorConversationQueryDto) {
    return this.service.findSimulatorConversation(user, query.phone);
  }

  @Post('sales-bot/simulate')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }))
  simulate(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SimulateCustomerMessageDto,
    @UploadedFile() file?: { buffer: Buffer; mimetype: string; originalname: string; size: number },
  ) {
    return this.service.simulate(user, dto, file);
  }

  /* Reply review + reports */
  @Get('sales-bot/replies')
  replies(@CurrentUser() user: AuthenticatedUser, @Query() query: RepliesQueryDto) {
    return this.service.replies(user, query);
  }

  @Get('sales-bot/reports')
  report(@CurrentUser() user: AuthenticatedUser, @Query() query: ReportQueryDto) {
    return this.service.report(user, query.days);
  }
}
