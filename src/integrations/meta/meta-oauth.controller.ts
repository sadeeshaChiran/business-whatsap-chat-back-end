import {
  BadRequestException,
  Controller,
  Get,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { MetaGraphService } from './meta-graph.service';
import { parseMetaOAuthState } from './meta-oauth-state.util';
import { MetaPageConnectionService } from '../../meta/meta-page-connection.service';

@Controller('integrations/meta')
export class MetaOAuthController {
  constructor(
    private readonly metaGraphService: MetaGraphService,
    private readonly metaPageConnectionService: MetaPageConnectionService,
  ) {}

  @Get('callback')
  async oauthCallback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Query('error_description') errorDescription: string | undefined,
    @Res() res: Response,
  ) {
    let returnPath: string | undefined;
    if (state) {
      try {
        returnPath = parseMetaOAuthState(state.trim()).r;
      } catch {
        returnPath = undefined;
      }
    }
    if (error) {
      const message = errorDescription?.trim() || error;
      return res.redirect(
        this.metaGraphService.frontendErrorRedirect(message, returnPath),
      );
    }
    if (!code?.trim() || !state?.trim()) {
      return res.redirect(
        this.metaGraphService.frontendErrorRedirect(
          'Missing authorization code from Meta.',
          returnPath,
        ),
      );
    }

    try {
      const payload = parseMetaOAuthState(state.trim());
      const userToken = await this.metaGraphService.exchangeCodeForUserToken(
        code.trim(),
      );
      const metaUserId =
        await this.metaGraphService.fetchMetaUserId(userToken);
      const pages = await this.metaGraphService.fetchManagedPages(userToken);
      await this.metaPageConnectionService.savePendingPages(
        payload.c,
        metaUserId,
        pages,
      );

      const redirectParams = new URLSearchParams({
        meta: 'connected',
      });
      return res.redirect(
        this.metaGraphService.frontendSuccessRedirect(
          redirectParams.toString(),
          payload.r,
        ),
      );
    } catch (err) {
      const message =
        err instanceof BadRequestException
          ? String(err.message)
          : err instanceof Error
            ? err.message
            : 'Facebook authorization failed.';
      return res.redirect(
        this.metaGraphService.frontendErrorRedirect(message, returnPath),
      );
    }
  }
}
