import {
  Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { memoryStorage } from 'multer';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AdminOnly, ManagerOnly, Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import {
  BookingsQueryDto, CreateBotServiceDto, CreateDeliveryZoneDto, FollowUpActionDto, RepliesQueryDto, ReportQueryDto, SalesBotTestDto,
  SimulateCustomerMessageDto, SimulatorConversationQueryDto, UpdateBookingNotesDto, UpdateBookingStatusDto, UpdateBotServiceDto,
  UpdateDeliveryZoneDto, UpdateSalesBotSettingsDto, CatalogQueryDto, ManualBookingDto, ManualOrderDto, ManualQuoteDto,
} from './dto/sales-bot.dto';
import { SalesBotAdminService } from './sales-bot-admin.service';
import { ManualOrdersService } from './manual-orders.service';

/** Endpoints for the Sales bot pages (docs: frontend docs/SALES_BOT_API.md). Admin only. */
@Controller('bot')
@ApiTags('Sales Bot')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@AdminOnly()
export class SalesBotController {
  constructor(private readonly service: SalesBotAdminService, private readonly manual: ManualOrdersService) {}

  /* Orders / bookings added by the team in a chat (admin, or the agent who holds the chat) */
  @Get('manual/catalog')
  @Roles('admin', 'supervisor', 'agent')
  manualCatalog(@CurrentUser() user: AuthenticatedUser, @Query() query: CatalogQueryDto) {
    return this.manual.catalog(user, query.search ?? '');
  }

  @Post('manual/quote')
  @Roles('admin', 'supervisor', 'agent')
  manualQuote(@CurrentUser() user: AuthenticatedUser, @Body() dto: ManualQuoteDto) {
    return this.manual.quote(user, dto.items, dto.delivery_area);
  }

  @Post('conversations/:id/manual-order')
  @Roles('admin', 'supervisor', 'agent')
  manualOrder(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number, @Body() dto: ManualOrderDto) {
    return this.manual.createOrder(user, id, dto);
  }

  @Post('conversations/:id/manual-booking')
  @Roles('admin', 'supervisor', 'agent')
  manualBooking(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number, @Body() dto: ManualBookingDto) {
    return this.manual.createBooking(user, id, dto);
  }

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
  @ManagerOnly()
  listBookings(@CurrentUser() user: AuthenticatedUser, @Query() query: BookingsQueryDto) {
    return this.service.listBookings(user, query);
  }

  @Patch('bookings/:id/status')
  @ManagerOnly()
  updateBookingStatus(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number, @Body() dto: UpdateBookingStatusDto) {
    return this.service.updateBookingStatus(user, id, dto);
  }

  /* Agent performance (company admin) */
  @Get('team/performance')
  @ManagerOnly()
  teamPerformance(@CurrentUser() user: AuthenticatedUser, @Query('days') days?: string) {
    return this.service.teamPerformance(user, Number(days));
  }

  /* Home dashboard (company admin) */
  @Get('dashboard')
  @ManagerOnly()
  dashboard(@CurrentUser() user: AuthenticatedUser, @Query('days') days?: string) {
    return this.service.dashboard(user, Number(days));
  }

  @Patch('bookings/:id/notes')
  @ManagerOnly()
  updateBookingNotes(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number, @Body() dto: UpdateBookingNotesDto) {
    return this.service.updateBookingNotes(user, id, dto);
  }

  @Post('bookings/:id/invoice')
  @ManagerOnly()
  sendBookingInvoice(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number) {
    return this.service.sendBookingInvoice(user, id);
  }

  /* What the business sells (products / services / both) – any signed-in user */
  @Get('sales-bot/sells')
  @Roles('admin', 'supervisor', 'agent')
  sells(@CurrentUser() user: AuthenticatedUser) {
    return this.service.getSellsInfo(user);
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
  @ManagerOnly()
  replies(@CurrentUser() user: AuthenticatedUser, @Query() query: RepliesQueryDto) {
    return this.service.replies(user, query);
  }

  /** Follow-ups: stats for the settings page */
  @Get('sales-bot/followups/stats')
  @ManagerOnly()
  followUpStats(@CurrentUser() user: AuthenticatedUser) {
    return this.service.followUpStats(user);
  }

  /** Stop / resume follow-ups for one chat */
  @Post('sales-bot/followups/:conversationId')
  @ManagerOnly()
  setFollowUp(
    @CurrentUser() user: AuthenticatedUser,
    @Param('conversationId', ParseIntPipe) conversationId: number,
    @Body() dto: FollowUpActionDto,
  ) {
    return this.service.setFollowUp(user, conversationId, dto.action);
  }

  @Get('sales-bot/reports')
  @ManagerOnly()
  report(@CurrentUser() user: AuthenticatedUser, @Query() query: ReportQueryDto) {
    return this.service.report(user, query.days);
  }
}
