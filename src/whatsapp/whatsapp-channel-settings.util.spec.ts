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

describe('buildWhatsappChannelPatch (Meta Cloud API settings)', () => {
  it('sets meta provider and CONNECTED status when number id + token exist', () => {
    const patch = buildWhatsappChannelPatch(
      13,
      'Chu.lk',
      { whatsapp_provider_type: 'meta', meta_phone_number_id: '1131918370007812' },
      baseChannel(),
    );
    expect(patch.provider_type).toBe('meta');
    expect(patch.status).toBe('CONNECTED');
    expect(patch.meta_phone_number_id).toBe('1131918370007812');
    expect(patch.instance_name).toBe('1131918370007812');
  });

  it('stays DISCONNECTED without an access token', () => {
    const patch = buildWhatsappChannelPatch(
      13,
      'Chu.lk',
      { whatsapp_provider_type: 'meta', meta_phone_number_id: '555' },
      baseChannel({ meta_access_token: null, meta_phone_number_id: null, instance_name: '' }),
    );
    expect(patch.status).toBe('DISCONNECTED');
    expect(patch.instance_name).toBe('555');
  });

  it('falls back to meta-<company id> when no number is known', () => {
    const patch = buildWhatsappChannelPatch(
      13,
      'Chu.lk',
      { whatsapp_provider_type: 'meta' },
      baseChannel({ meta_access_token: null, meta_phone_number_id: null, instance_name: '' }),
    );
    expect(patch.instance_name).toBe('meta-13');
  });
});
