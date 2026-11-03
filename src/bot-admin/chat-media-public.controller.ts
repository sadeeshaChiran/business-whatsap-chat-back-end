import { Controller, Get, Headers, NotFoundException, Param, Query, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import { createReadStream } from 'fs';
import { RawResponse } from '../common/decorators/raw-response.decorator';
import { chatMediaFile, verifyPublicChatMedia } from './chat-media.store';

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
    @Headers('range') range?: string,
  ) {
    const key = verifyPublicChatMedia(token, exp, sig);
    const file = key ? chatMediaFile(key) : null;
    if (!file) throw new NotFoundException('File not found or link expired.');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Accept-Ranges', 'bytes');
    // streamed from disk (videos can be large); byte ranges let players and Meta fetch parts
    const match = /^bytes=(\d*)-(\d*)$/.exec(String(range ?? '').trim());
    if (match && file.size > 0 && (match[1] || match[2])) {
      const start = match[1] ? Number(match[1]) : Math.max(0, file.size - Number(match[2]));
      let end = match[1] && match[2] ? Number(match[2]) : file.size - 1;
      end = Math.min(end, file.size - 1);
      if (start > end || start >= file.size) {
        res.status(416);
        res.setHeader('Content-Range', `bytes */${file.size}`);
        return new StreamableFile(Buffer.alloc(0), { type: file.contentType });
      }
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${file.size}`);
      return new StreamableFile(createReadStream(file.path, { start, end }), { type: file.contentType, length: end - start + 1, disposition: `inline; filename="${file.fileName}"` });
    }
    return new StreamableFile(createReadStream(file.path), { type: file.contentType, length: file.size, disposition: `inline; filename="${file.fileName}"` });
  }
}
