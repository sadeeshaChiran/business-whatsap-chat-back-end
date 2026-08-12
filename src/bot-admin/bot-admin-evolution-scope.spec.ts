import { BotAdminService } from './bot-admin.service';

describe('BotAdminService Evolution conversation scope', () => {
  it('returns only chats from the currently connected Evolution instance', async () => {
    const service = Object.create(BotAdminService.prototype) as any;
    service.whatsappChannelRepository = {
      find: jest.fn().mockResolvedValue([{
        id: 9,
        company_id: 7,
        provider_type: 'evolution',
        instance_name: 'current-instance',
        evolution_instance_name: 'current-instance',
        evaluation_whatsapp_key: 'instance-key',
      }]),
    };
    service.evolutionService = {
      findChats: jest.fn().mockResolvedValue([{
        remote_jid: '94750000001@s.whatsapp.net',
        alternate_jid: null,
        phone: '94750000001',
        display_name: 'Current contact',
        last_message_preview: 'Current message',
        last_message_at: '2026-08-10T00:00:00.000Z',
        unread_count: 0,
      }]),
    };

    const row = (phone: string) => ({
      customer: { id: 1, customer_phone: phone, assigned_instance: null, first_seen_at: null, last_seen_at: null },
      channelUser: null,
      conversation: null,
      evolution_remote_jid: null,
      last_message_preview: null,
    });

    const result = await service.mergeEvolutionInboxChats(
      7,
      [row('94750000001'), row('94750000099')],
      [],
    );

    expect(service.evolutionService.findChats).toHaveBeenCalledWith('current-instance', 'instance-key');
    expect(result.map((item: any) => item.customer.customer_phone)).toEqual(['94750000001']);
  });
  it('rejects messages for a different JID even if Evolution returns them', async () => {
    const service = Object.create(BotAdminService.prototype) as any;
    service.evolutionService = {
      findChats: jest.fn().mockResolvedValue([
        { remote_jid: '94750000001@s.whatsapp.net', alternate_jid: null, phone: '94750000001' },
        { remote_jid: '94750000002@s.whatsapp.net', alternate_jid: null, phone: '94750000002' },
      ]),
      findMessages: jest.fn().mockResolvedValue([
        { id: 'wanted', remote_jid: '94750000001@s.whatsapp.net', direction: 'inbound', message_type: 'text', content: 'Correct chat', media_url: null, created_at: '2026-08-10T00:00:00.000Z' },
        { id: 'foreign', remote_jid: '94750000002@s.whatsapp.net', direction: 'inbound', message_type: 'text', content: 'Wrong user chat', media_url: null, created_at: '2026-08-10T00:00:01.000Z' },
      ]),
    };
    service.enrichEvolutionImageMessages = jest.fn(async (_instance: string, _key: string, messages: unknown[]) => messages);

    const result = await service.fetchEvolutionMessagesForJid(
      7,
      '94750000001@s.whatsapp.net',
      'current-instance',
      'instance-key',
    );

    expect(result.messages.map((message: any) => message.id)).toEqual(['wanted']);
  });
});
