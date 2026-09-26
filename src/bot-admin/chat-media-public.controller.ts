import { Controller, Get, NotFoundException, Param, Query, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import { RawResponse } from '../common/decorators/raw-response.decorator';
import { readChatMedia, verifyPublicChatMedia } from './chat-media.store';

/**
 * PUBLIC (no login) – serves a chat file only with a valid, unexpired signature.
 * Instagram downloads media we send from this URL.
 * Register it in BotAdminModule → controllers: [BotAdminController, ChatMediaPublicController]
 */
@Controller('public/chat-media')
export class ChatMediaPublicController {
  @Get(':token')
  @RawResponse()
  getFile(
    @Param('token') token: string,
    @Query('exp') exp: string,
    @Query('sig') sig: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const key = verifyPublicChatMedia(token, exp, sig);
    const file = key ? readChatMedia(key) : null;
    if (!file) throw new NotFoundException('File not found or link expired.');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    return new StreamableFile(file.buffer, { type: file.contentType, disposition: `inline; filename="${file.fileName}"` });
  }
}
