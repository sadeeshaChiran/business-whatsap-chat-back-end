import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  MetaOauthPending,
  type MetaPendingPage,
} from './entities/meta-oauth-pending.entity';
import { MetaPageConnection } from './entities/meta-page-connection.entity';

export type MetaPageConnectionSnapshot = {
  page_id: string | null;
  page_name: string | null;
  instagram_business_account_id: string | null;
  status: string | null;
};

@Injectable()
export class MetaPageConnectionService {
  constructor(
    @InjectRepository(MetaPageConnection)
    private readonly connectionRepository: Repository<MetaPageConnection>,
    @InjectRepository(MetaOauthPending)
    private readonly pendingRepository: Repository<MetaOauthPending>,
  ) {}

  async getForCompany(companyId: number): Promise<MetaPageConnection | null> {
    return this.connectionRepository.findOne({
      where: { company_id: companyId, status: 'CONNECTED' },
      order: { id: 'DESC' },
    });
  }

  toSnapshot(
    connection: MetaPageConnection | null,
  ): MetaPageConnectionSnapshot {
    return {
      page_id: connection?.page_id ?? null,
      page_name: connection?.page_name ?? null,
      instagram_business_account_id:
        connection?.instagram_business_account_id ?? null,
      status: connection?.status ?? null,
    };
  }

  async savePendingPages(
    companyId: number,
    metaUserId: string,
    pages: MetaPendingPage[],
  ) {
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    const existing = await this.pendingRepository.findOne({
      where: { company_id: companyId },
    });
    if (existing) {
      return this.pendingRepository.save({
        ...existing,
        meta_user_id: metaUserId,
        pages_json: pages,
        expires_at: expiresAt,
      });
    }
    return this.pendingRepository.save(
      this.pendingRepository.create({
        company_id: companyId,
        meta_user_id: metaUserId,
        pages_json: pages,
        expires_at: expiresAt,
        created_at: new Date(),
      }),
    );
  }

  async listPendingPageChoices(companyId: number) {
    const pending = await this.pendingRepository.findOne({
      where: { company_id: companyId },
    });
    if (!pending || pending.expires_at.getTime() < Date.now()) {
      return [];
    }
    return (pending.pages_json ?? []).map((page) => ({
      id: page.id,
      name: page.name,
      has_instagram: Boolean(page.instagram_business_account_id),
    }));
  }

  async connectPage(
    companyId: number,
    companyName: string,
    pageId: string,
    scopes: string,
  ): Promise<MetaPageConnection> {
    const pending = await this.pendingRepository.findOne({
      where: { company_id: companyId },
    });
    if (!pending || pending.expires_at.getTime() < Date.now()) {
      throw new NotFoundException(
        'Facebook authorization expired. Connect again from Settings.',
      );
    }
    const selected = (pending.pages_json ?? []).find(
      (page) => page.id === pageId,
    );
    if (!selected) {
      throw new NotFoundException('Selected Facebook Page was not found.');
    }

    const now = new Date();
    const existing = await this.connectionRepository.findOne({
      where: { company_id: companyId, page_id: pageId },
    });

    const saved = await this.connectionRepository.save({
      ...(existing ?? {}),
      company_id: companyId,
      company_name: companyName,
      meta_user_id: pending.meta_user_id,
      page_id: selected.id,
      page_name: selected.name,
      page_access_token: selected.access_token,
      instagram_business_account_id:
        selected.instagram_business_account_id ?? null,
      status: 'CONNECTED',
      scopes,
      last_error: null,
      updated_at: now,
      created_at: existing?.created_at ?? now,
    });

    await this.pendingRepository.delete({ company_id: companyId });
    return saved;
  }

  async disconnect(companyId: number) {
    const connection = await this.getForCompany(companyId);
    if (!connection) {
      return;
    }
    await this.connectionRepository.save({
      ...connection,
      status: 'DISCONNECTED',
      updated_at: new Date(),
    });
  }

  async requireConnected(companyId: number): Promise<MetaPageConnection> {
    const connection = await this.getForCompany(companyId);
    if (!connection) {
      throw new NotFoundException(
        'No Facebook Page connected. Connect a Page in Settings first.',
      );
    }
    return connection;
  }

  async patchInstagramAccount(
    companyId: number,
    instagramId: string | null,
  ): Promise<MetaPageConnection | null> {
    const connection = await this.getForCompany(companyId);
    if (!connection) {
      return null;
    }
    return this.connectionRepository.save({
      ...connection,
      instagram_business_account_id: instagramId,
      updated_at: new Date(),
    });
  }
}
