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

        status: 'CONNECTING',

      },

    );



    const result = await this.evolutionService.createInstance(

      instanceName,

      phoneDigits,

    );

    const instanceToken = this.evolutionService.extractInstanceToken(result);



    await this.whatsappChannelService.upsertForCompany(

      user.company_id,

      company.name,

      {

        instance_name: instanceName,

        evaluation_whatsapp_key: instanceToken,

        status: 'CONNECTING',

      },

    );



    const savedCompany = await this.companyService.findOne(

      user.company_id,

      user,

    );



    return {

      instance: instanceName,

      instance_token: instanceToken,

      phone: phoneDigits,

      result,

      company: savedCompany,

    };

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



    const savedCompany = await this.companyService.findOne(

      user.company_id,

      user,

    );



    return {

      instance: instanceName,

      evolution_state: evolutionState,

      whatsapp_status: status,

      connected: status === 'CONNECTED',

      company: savedCompany,

    };

  }

}


