import {
  All,
  Controller,
  Get,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RawResponse } from '../common/decorators/raw-response.decorator';
import { BotProxyService } from './bot-proxy.service';

@Controller('bot/ai')
@ApiTags('Bot AI Proxy')
export class BotProxyController {
  constructor(private readonly botProxyService: BotProxyService) {}

  @Get('health')
  @RawResponse()
  health() {
    return this.botProxyService.forward('GET', 'health');
  }

  @All('*path')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @RawResponse()
  proxy(@Req() request: Request) {
    const pathParam = request.params.path;
    const subPath = Array.isArray(pathParam)
      ? pathParam.join('/')
      : String(pathParam ?? '');
    const authorization = request.headers.authorization;

    return this.botProxyService.forward(
      request.method,
      subPath,
      request.body,
      authorization,
    );
  }
}
