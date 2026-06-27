import {

  BadRequestException,

  Body,

  Controller,

  Get,

  Post,

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

import { WhatsappChannelService } from '../../whatsapp/whatsapp-channel.service';

import { CreateEvolutionInstanceDto } from './dto/create-evolution-instance.dto';

import { EvolutionService } from './evolution.service';



@Controller('integrations/evolution')

@ApiTags('Integrations - Evolution')

@ApiBearerAuth()

@UseGuards(JwtAuthGuard)

export class EvolutionController {

  constructor(

    private readonly evolutionService: EvolutionService,

    private readonly companyService: CompanyService,

    private readonly whatsappChannelService: WhatsappChannelService,

    @InjectRepository(Company)

    private readonly companyRepository: Repository<Company>,

  ) {}



  private async assertAdmin(user: AuthenticatedUser) {

    const company = await this.companyRepository.findOne({

      where: { id: user.company_id },

    });

    if (!company || Number(company.admin_user_id) !== Number(user.id)) {

      throw new BadRequestException(

        'Only the company admin can manage WhatsApp instances.',

      );

    }

    return company;

  }



  private resolveCompanyPhone(company: Company): string {

    const phoneDigits = this.whatsappChannelService.normalizePhone(company.phone);

    if (!phoneDigits) {

      throw new BadRequestException(

        'Set your company phone number in Settings first (country code, digits only, e.g. 94771234567). This number is used for WhatsApp.',

      );

    }

    return phoneDigits;

  }

  private settingsOverridesFromDto(body: CreateEvolutionInstanceDto) {
    const overrides: {
      readMessages?: boolean;
      alwaysOnline?: boolean;
      groupsIgnore?: boolean;
    } = {};
    if (typeof body.read_messages === 'boolean') {
      overrides.readMessages = body.read_messages;
    }
    if (typeof body.always_online === 'boolean') {
      overrides.alwaysOnline = body.always_online;
    }
    if (typeof body.groups_ignore === 'boolean') {
      overrides.groupsIgnore = body.groups_ignore;
    }
    return Object.keys(overrides).length > 0 ? overrides : undefined;
  }

  @Get('instance/settings-defaults')
  getInstanceSettingsDefaults() {
    const defaults = this.evolutionService.getInstanceSettingsDefaults();
    return {
      read_messages: defaults.readMessages,
      always_online: defaults.alwaysOnline,
      groups_ignore: defaults.groupsIgnore,
    };
  }

  @Post('instance')

  async createInstance(

    @CurrentUser() user: AuthenticatedUser,

    @Body() body: CreateEvolutionInstanceDto,

  ) {

    const company = await this.assertAdmin(user);

    const instanceName = body.whatsapp_instance_name.trim();

    const phoneDigits = this.resolveCompanyPhone(company);



    await this.whatsappChannelService.assertUniqueCompanyPhone(

      user.company_id,

      phoneDigits,

    );



    await this.whatsappChannelService.upsertForCompany(

      user.company_id,

      company.name,

      {

        instance_name: instanceName,

        evolution_instance_name: instanceName,

        provider_type: 'evolution',

        status: 'CONNECTING',

      },

    );



    const settingsOverrides = this.settingsOverridesFromDto(body);

    const result = await this.evolutionService.createInstance(

      instanceName,

      phoneDigits,

      undefined,

      settingsOverrides,

    );

    const instanceToken = this.evolutionService.extractInstanceToken(result);

    let webhookConfigured = false;
    let webhookError: string | null = null;

    if (this.evolutionService.isWebhookAutoConfigureEnabled()) {
      try {
        await this.evolutionService.configureInstanceWebhook(
          instanceName,
          instanceToken ?? undefined,
        );
        webhookConfigured = true;
      } catch (error) {
        webhookError =
          error instanceof BadRequestException
            ? String(error.message)
            : 'Failed to configure Evolution webhook for this instance.';
      }
    }

    let settingsApplied = false;
    let settingsError: string | null = null;
    try {
      await this.evolutionService.applyInstanceSettings(
        instanceName,
        instanceToken ?? undefined,
        settingsOverrides,
      );
      settingsApplied = true;
    } catch (error) {
      settingsError =
        error instanceof BadRequestException
          ? String(error.message)
          : 'Failed to apply Evolution instance settings (read messages / always online).';
    }



    await this.whatsappChannelService.upsertForCompany(

      user.company_id,

      company.name,

      {

        instance_name: instanceName,

        evolution_instance_name: instanceName,

        provider_type: 'evolution',

        evaluation_whatsapp_key: instanceToken,

        status: 'CONNECTING',

      },

    );



    const savedCompany = await this.companyService.findOne(

      user.company_id,

      user,

    );

    const connect = await this.resolveConnectPayload(
      instanceName,
      instanceToken ?? undefined,
      phoneDigits,
      result,
    );



    return {

      instance: instanceName,

      instance_token: instanceToken,

      phone: phoneDigits,

      qr_image: connect.qr_image,

      pairing_code: connect.pairing_code,

      link_code: connect.link_code,

      connection_state: connect.connection_state,

      webhook_configured: webhookConfigured,

      webhook_url: this.evolutionService.isWebhookAutoConfigureEnabled()
        ? process.env.EVOLUTION_WEBHOOK_URL?.trim() ?? null
        : null,

      webhook_events:
        process.env.EVOLUTION_WEBHOOK_EVENTS?.trim() || 'MESSAGES_UPSERT',

      webhook_error: webhookError,

      settings_applied: settingsApplied,

      settings_error: settingsError,

      read_messages: this.evolutionService.buildInstanceSettingsBody(settingsOverrides)
        .readMessages,

      always_online: this.evolutionService.buildInstanceSettingsBody(settingsOverrides)
        .alwaysOnline,

      groups_ignore: this.evolutionService.buildInstanceSettingsBody(settingsOverrides)
        .groupsIgnore,

      result: connect.result,

      company: savedCompany,

    };

  }

  /** QR and pairing code for the dashboard — same options as Get QR. */
  private async resolveConnectPayload(
    instanceName: string,
    instanceApiKey: string | undefined,
    phoneDigits: string,
    createResult?: unknown,
  ) {
    const parsedCreate = this.evolutionService.parseQrPayload(createResult);
    if (parsedCreate.qr_image || parsedCreate.pairing_code) {
      return {
        qr_image: parsedCreate.qr_image,
        pairing_code: parsedCreate.pairing_code,
        link_code: parsedCreate.link_code,
        connection_state: null as string | null,
        result: createResult ?? null,
      };
    }

    try {
      const fetched = await this.evolutionService.fetchQrForInstance(
        instanceName,
        instanceApiKey,
        phoneDigits,
      );
      return {
        qr_image: fetched.qr_image,
        pairing_code: fetched.pairing_code,
        link_code: fetched.link_code,
        connection_state: fetched.connection_state,
        result: fetched.last_raw,
      };
    } catch {
      return {
        qr_image: null,
        pairing_code: null,
        link_code: null,
        connection_state: null,
        result: createResult ?? null,
      };
    }
  }



  @Get('instance/qr')

  async getQr(@CurrentUser() user: AuthenticatedUser) {

    const company = await this.assertAdmin(user);

    const channel = await this.whatsappChannelService.getForCompany(

      user.company_id,

    );

    const instanceName = channel?.instance_name?.trim();

    if (!instanceName) {

      throw new BadRequestException(

        'Set company phone and instance name, then create the instance.',

      );

    }



    const phoneDigits = this.resolveCompanyPhone(company);

    const overrideKey = channel?.evaluation_whatsapp_key?.trim() || undefined;

    const fetched = await this.evolutionService.fetchQrForInstance(

      instanceName,

      overrideKey,

      phoneDigits,

    );



    if (!fetched.qr_image && !fetched.pairing_code) {

      throw new BadRequestException(

        this.evolutionService.qrUnavailableMessage(fetched),

      );

    }



    await this.whatsappChannelService.upsertForCompany(

      user.company_id,

      company.name,

      { status: 'CONNECTING' },

    );



    return {

      instance: instanceName,

      qr_image: fetched.qr_image,

      pairing_code: fetched.pairing_code,

      link_code: fetched.link_code,

      connection_state: fetched.connection_state,

      manager_url: this.evolutionService.managerUrl(),

      result: fetched.last_raw,

    };

  }



  @Get('instance/status')

  async syncConnectionStatus(@CurrentUser() user: AuthenticatedUser) {

    const company = await this.assertAdmin(user);

    const channel = await this.whatsappChannelService.getForCompany(

      user.company_id,

    );

    if (channel?.provider_type === 'meta') {

      const savedCompany = await this.companyService.findOne(

        user.company_id,

        user,

      );

      return {

        instance: channel.evolution_instance_name?.trim() || channel.instance_name?.trim() || '',

        evolution_state: null,

        whatsapp_status: channel.status ?? 'DISCONNECTED',

        connected: channel.status === 'CONNECTED',

        settings_applied: false,

        company: savedCompany,

        skipped: 'meta_provider_active',

      };

    }

    const instanceName = channel?.instance_name?.trim();

    if (!instanceName) {

      throw new BadRequestException('No WhatsApp instance configured yet.');

    }



    const apiKey = channel?.evaluation_whatsapp_key?.trim() || undefined;

    let evolutionState: string | null = null;

    try {

      const stateRes = await this.evolutionService.getConnectionState(

        instanceName,

        apiKey,

      );

      evolutionState = stateRes?.instance?.state ?? null;

    } catch {

      evolutionState = 'close';

    }



    const status =

      this.whatsappChannelService.mapEvolutionState(evolutionState);

    await this.whatsappChannelService.upsertForCompany(

      user.company_id,

      company.name,

      { status },

    );

    let settingsApplied = false;
    if (status === 'CONNECTED') {
      try {
        await this.evolutionService.applyInstanceSettings(instanceName, apiKey);
        settingsApplied = true;
      } catch {
        settingsApplied = false;
      }
    }



    const savedCompany = await this.companyService.findOne(

      user.company_id,

      user,

    );



    return {

      instance: instanceName,

      evolution_state: evolutionState,

      whatsapp_status: status,

      connected: status === 'CONNECTED',

      settings_applied: settingsApplied,

      company: savedCompany,

    };

  }

}


