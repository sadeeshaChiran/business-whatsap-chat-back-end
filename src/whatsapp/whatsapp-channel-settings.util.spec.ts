import { buildWhatsappChannelPatch } from './whatsapp-channel-settings.util';
import type { WhatsappChannel } from './entities/whatsapp-channel.entity';

function baseChannel(overrides: Partial<WhatsappChannel> = {}): WhatsappChannel {
  return {
    id: 12,
    company_id: 13,
    company_name: 'Chu.lk',
    role_type: 'general',
    instance_name: '1131918370007812',
    evolution_instance_name: '1131918370007812',
    status: 'DISCONNECTED',
    weight: 1,
    last_used_at: null,
    created_at: new Date(),
    evaluation_whatsapp_key: 'token',
    provider_type: 'evolution',
    meta_phone_number_id: '1131918370007812',
    meta_access_token: 'meta-token',
    meta_waba_id: 'waba',
    meta_verify_token: 'verify',
    evolution_api_base: null,
    meta_webhook_base_url: null,
    ...overrides,
  } as WhatsappChannel;
}

describe('buildWhatsappChannelPatch', () => {
  it('sets meta provider, CONNECTED status, and fixes instance_name on meta save', () => {
    const patch = buildWhatsappChannelPatch(
      13,
      'Chu.lk',
      {
        whatsapp_provider_type: 'meta',
        meta_phone_number_id: '1131918370007812',
      },
      baseChannel(),
    );

    expect(patch.provider_type).toBe('meta');
    expect(patch.status).toBe('CONNECTED');
    expect(patch.meta_phone_number_id).toBe('1131918370007812');
    expect(patch.instance_name).not.toBe('1131918370007812');
    expect(patch.evolution_instance_name).toBeTruthy();
  });

  it('preserves explicit evolution instance name when switching to meta', () => {
    const patch = buildWhatsappChannelPatch(
      13,
      'Chu.lk',
      {
        whatsapp_provider_type: 'meta',
        whatsapp_instance_name: 'chu.lk whatsapp bot',
        meta_phone_number_id: '1131918370007812',
      },
      baseChannel(),
    );

    expect(patch.instance_name).toBe('chu.lk whatsapp bot');
    expect(patch.evolution_instance_name).toBe('chu.lk whatsapp bot');
  });

  it('sets evolution provider and instance when switching back', () => {
    const patch = buildWhatsappChannelPatch(
      13,
      'Chu.lk',
      {
        whatsapp_provider_type: 'evolution',
        whatsapp_instance_name: 'chu.lk whatsapp bot',
      },
      baseChannel({ provider_type: 'meta', status: 'CONNECTED' }),
    );

    expect(patch.provider_type).toBe('evolution');
    expect(patch.instance_name).toBe('chu.lk whatsapp bot');
    expect(patch.evolution_instance_name).toBe('chu.lk whatsapp bot');
  });
});
