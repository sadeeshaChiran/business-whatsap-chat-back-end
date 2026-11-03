import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PusherService } from '../common/pusher.service';
import { CustomerReportService, DemandService, ProductReportService, ReportsController } from './reports';
import { StockController, StockService } from './stock';

/**
 * Stock counting + product / customer reports. Global, so the order code (sales bot, manual orders, admin orders) can
 * tell StockService about order changes and the sales bot can record demand – without new module imports.
 */
@Global()
@Module({
  imports: [AuthModule],
  controllers: [StockController, ReportsController],
  providers: [StockService, DemandService, ProductReportService, CustomerReportService, PusherService],
  exports: [StockService, DemandService],
})
export class ReportsModule {}
