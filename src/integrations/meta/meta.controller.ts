import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Repository } from 'typeorm';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { CompanyService } from '../../company/company.service';
import { Company } from '../../company/entities/company.entity';
import { MetaPageConnection } from '../../meta/entities/meta-page-connection.entity';
import { MetaPageConnectionService } from '../../meta/meta-page-connection.service';
import { ConnectMetaPageDto } from './dto/connect-meta-page.dto';
import { MetaGraphService, type MetaSocialPost } from './meta-graph.service';
import { buildMetaOAuthState } from './meta-oauth-state.util';

@Controller('integrations/meta')
@ApiTags('Integrations - Meta')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
export class MetaController {
  constructor(
    private readonly metaGraphService: MetaGraphService,
    private readonly metaPageConnectionService: MetaPageConnectionService,
    private readonly companyService: CompanyService,
    @InjectRepository(Company)
    private readonly companyRepository: Repository<Company>,
    @InjectRepository(MetaPageConnection)
    private readonly metaPageConnectionRepository: Repository<MetaPageConnection>,
  ) {}

  private async assertAdmin(user: AuthenticatedUser) {
    const company = await this.companyRepository.findOne({
      where: { id: user.company_id },
    });
    if (!company || Number(company.admin_user_id) !== Number(user.id)) {
      throw new BadRequestException(
        'Only the company admin can manage Facebook Page connections.',
      );
    }
    return company;
  }

  private async syncInstagramLink(
    connection: MetaPageConnection,
  ): Promise<MetaPageConnection> {
    const refreshed = await this.metaGraphService.refreshInstagramAccount(
      connection.page_id,
      connection.page_access_token,
    );
    if (
      refreshed.id &&
      refreshed.id !== connection.instagram_business_account_id
    ) {
      return (
        (await this.metaPageConnectionService.patchInstagramAccount(
          connection.company_id,
          refreshed.id,
        )) ?? connection
      );
    }
    return connection;
  }

  @Get('auth-url')
  async getAuthUrl(@CurrentUser() user: AuthenticatedUser) {
    await this.assertAdmin(user);
    const state = buildMetaOAuthState(user.company_id, user.id);
    return {
      url: this.metaGraphService.buildAuthUrl(state),
    };
  }

  @Get('pending-pages')
  async listPendingPages(@CurrentUser() user: AuthenticatedUser) {
    await this.assertAdmin(user);
    const pages = await this.metaPageConnectionService.listPendingPageChoices(
      user.company_id,
    );
    return { pages };
  }

  @Post('connect')
  async connectPage(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ConnectMetaPageDto,
  ) {
    const company = await this.assertAdmin(user);
    const cfg = this.metaGraphService.getConfig();
    let connection = await this.metaPageConnectionService.connectPage(
      user.company_id,
      company.name,
      body.page_id.trim(),
      cfg.scopes,
    );
    connection = await this.syncInstagramLink(connection);
    const savedCompany = await this.companyService.findOne(
      user.company_id,
      user,
    );
    return { company: savedCompany, connection };
  }

  @Delete('connection')
  async disconnect(@CurrentUser() user: AuthenticatedUser) {
    await this.assertAdmin(user);
    await this.metaPageConnectionService.disconnect(user.company_id);
    const savedCompany = await this.companyService.findOne(
      user.company_id,
      user,
    );
    return { company: savedCompany };
  }

  @Get('posts')
  async listPosts(
    @CurrentUser() user: AuthenticatedUser,
    @Query('platform') platform?: string,
    @Query('limit') limit?: string,
  ) {
    await this.assertAdmin(user);
    let connection = await this.metaPageConnectionService.requireConnected(
      user.company_id,
    );
    connection = await this.syncInstagramLink(connection);

    const parsedLimit = Math.min(Math.max(Number(limit) || 20, 1), 50);
    const normalizedPlatform = (platform ?? 'all').trim().toLowerCase();

    const posts: MetaSocialPost[] = [];
    const warnings: string[] = [];
    const errors: string[] = [];
    let facebookCount = 0;
    let instagramCount = 0;

    if (normalizedPlatform === 'all' || normalizedPlatform === 'facebook') {
      try {
        const facebookResult = await this.metaGraphService.fetchFacebookPosts(
          connection.page_id,
          connection.page_access_token,
          parsedLimit,
        );
        facebookCount = facebookResult.posts.length;
        posts.push(...facebookResult.posts);
        if (facebookResult.errors.length) {
          const permissionHint = facebookResult.errors.some((item) =>
            /permission|pages_read_engagement|OAuthException|200/i.test(item),
          );
          if (permissionHint) {
            errors.push(
              'Meta denied Page post access. Add pages_read_engagement to your Facebook Login for Business configuration, reconnect the Page, and submit App Review if the app is Live.',
            );
          }
          warnings.push(...facebookResult.errors.slice(0, 3));
        }
        if (!facebookResult.posts.length) {
          warnings.push(
            'No Facebook posts or photos returned from Graph API. If your Page has photos (e.g. facebook.com/photo?fbid=...), reconnect after granting pages_read_engagement in Meta app settings.',
          );
        }
      } catch (error) {
        const message =
          error instanceof BadRequestException
            ? String(error.message)
            : error instanceof Error
              ? error.message
              : 'Facebook posts request failed.';
        errors.push(message);
      }
    }

    const instagramLinked = Boolean(connection.instagram_business_account_id);
    if (
      !instagramLinked &&
      (normalizedPlatform === 'instagram' || normalizedPlatform === 'all')
    ) {
      warnings.push(
        'Instagram is not linked to this Facebook Page. Link a Professional Instagram account in Meta Business Suite, then click Load posts again.',
      );
    }
    if (
      instagramLinked &&
      (normalizedPlatform === 'all' || normalizedPlatform === 'instagram')
    ) {
      try {
        const instagramPosts = await this.metaGraphService.fetchInstagramPosts(
          connection.instagram_business_account_id as string,
          connection.page_access_token,
          parsedLimit,
        );
        instagramCount = instagramPosts.length;
        posts.push(...instagramPosts);
        if (!instagramPosts.length) {
          warnings.push(
            'No Instagram posts returned. Post on Instagram or check instagram_business_basic permission in your Meta app configuration.',
          );
        }
      } catch (error) {
        const message =
          error instanceof BadRequestException
            ? String(error.message)
            : error instanceof Error
              ? error.message
              : 'Instagram posts request failed.';
        errors.push(message);
      }
    }

    posts.sort((a, b) => {
      const aTime = a.created_time ? Date.parse(a.created_time) : 0;
      const bTime = b.created_time ? Date.parse(b.created_time) : 0;
      return bTime - aTime;
    });

    await this.metaPageConnectionRepository.save({
      ...connection,
      last_synced_at: new Date(),
      last_error: errors.length ? errors.join(' | ') : null,
      updated_at: new Date(),
    });

    return {
      page_id: connection.page_id,
      page_name: connection.page_name,
      instagram_business_account_id: connection.instagram_business_account_id,
      instagram_linked: instagramLinked,
      facebook_count: facebookCount,
      instagram_count: instagramCount,
      warnings,
      errors,
      posts: posts.slice(0, parsedLimit),
    };
  }
}
