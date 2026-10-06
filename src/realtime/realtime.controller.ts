import { Body, Controller, ForbiddenException, HttpCode, Module, Post, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsString, Matches, MaxLength } from 'class-validator';
import { AuthModule } from '../auth/auth.module';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { RawResponse } from '../common/decorators/raw-response.decorator';
import { PusherService } from '../common/pusher.service';

class PusherAuthDto {
  @IsString() @MaxLength(100) @Matches(/^\d+\.\d+$/) socket_id: string;
  @IsString() @MaxLength(100) channel_name: string;
}

/** Pusher private channel auth: a user may only listen to their own company's channel. */
@Controller('realtime')
@ApiTags('Realtime')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
export class RealtimeController {
  constructor(private readonly pusher: PusherService) {}

  @Post('auth')
  @HttpCode(200)
  @RawResponse()
  auth(@CurrentUser() user: AuthenticatedUser, @Body() dto: PusherAuthDto) {
    if (dto.channel_name !== `private-company-${Number(user.company_id)}`) {
      throw new ForbiddenException('You cannot listen to this channel.');
    }
    const signature = this.pusher.authorize(dto.socket_id, dto.channel_name);
    if (!signature) throw new ServiceUnavailableException('Real-time updates are not configured.');
    return signature;
  }
}

@Module({ imports: [AuthModule], controllers: [RealtimeController], providers: [PusherService] })
export class RealtimeModule {}
