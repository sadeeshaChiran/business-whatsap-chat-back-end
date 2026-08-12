import { EvolutionAdapter } from './adapters/evolution.adapter';
import { MetaAdapter } from './adapters/meta.adapter';

describe('WhatsApp inbound adapter batches', () => {
  it('processes every Evolution message and resolves @lid through remoteJidAlt', () => {
    const adapter = new EvolutionAdapter();
    const result = adapter.normalizeInboundWebhooks({
      instance: 'shop-instance',
      data: {
        messages: [
          { key: { id: 'EV-1', remoteJid: '206300533256221@lid', remoteJidAlt: '94750807055@s.whatsapp.net', fromMe: false }, message: { conversation: 'First' } },
          { key: { id: 'EV-2', remoteJid: '94711111111@s.whatsapp.net', fromMe: false }, message: { conversation: 'Second' } },
        ],
      },
    });

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ phone: '94750807055', remote_jid: '94750807055@s.whatsapp.net', message_id: 'EV-1' });
    expect(result[1]).toMatchObject({ phone: '94711111111', message_id: 'EV-2' });
  });

  it('processes every Meta message in a webhook batch', () => {
    const adapter = new MetaAdapter();
    const result = adapter.normalizeInboundWebhooks({
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ value: {
        metadata: { phone_number_id: '123456789012' },
        messages: [
          { id: 'wamid.1', from: '94750000001', type: 'text', text: { body: 'First' }, timestamp: '1700000000' },
          { id: 'wamid.2', from: '94750000002', type: 'text', text: { body: 'Second' }, timestamp: '1700000001' },
        ],
      } }] }],
    });

    expect(result).toHaveLength(2);
    expect(result.map((item) => item.message_id)).toEqual(['wamid.1', 'wamid.2']);
    expect(result.map((item) => item.phone)).toEqual(['94750000001', '94750000002']);
  });
});

describe('Meta deleted messages', () => {
  it('normalizes explicit deleted events as system messages', () => {
    const adapter = new MetaAdapter();
    const result = adapter.normalizeInboundWebhooks({
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ value: {
        metadata: { phone_number_id: '123456789012' },
        messages: [
          {
            id: 'wamid.deleted.1',
            from: '94750000001',
            type: 'deleted',
            timestamp: '1700000002',
          },
        ],
      } }] }],
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      message: 'This message was deleted',
      input_type: 'system',
      message_type: 'system',
      has_image: false,
      has_voice: false,
    });
  });
});
