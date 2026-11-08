import { CoexistenceService, parseCoexistence } from './coexistence';

const hook = (field: string, value: Record<string, unknown>) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'waba', changes: [{ field, value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '94718191000', phone_number_id: 'PN1' }, ...value } }] }],
});

describe('WhatsApp coexistence webhooks (Business app + Cloud API on one number)', () => {
  it('a message sent from the phone app = outbound for that customer', () => {
    const [change] = parseCoexistence(hook('smb_message_echoes', {
      message_echoes: [{ from: '94718191000', to: '94771234567', id: 'wamid.E1', timestamp: '1762600000', type: 'text', text: { body: 'Hari, heta deliver karannam' } }],
    }));
    expect(change).toMatchObject({ phoneNumberId: 'PN1', field: 'smb_message_echoes' });
    expect(change.messages).toEqual([{ id: 'wamid.E1', customer: '94771234567', direction: 'outbound', type: 'text', content: 'Hari, heta deliver karannam', mediaId: null, at: 1762600000 }]);
  });

  it('history: messages of each customer thread, in and out', () => {
    const [change] = parseCoexistence(hook('history', {
      history: [{ metadata: { phase: 0, chunk_order: 1, progress: 100 }, threads: [{ id: '94771234567', messages: [
        { from: '94771234567', id: 'wamid.H1', timestamp: '1760000000', type: 'text', text: { body: 'Price kiyada?' } },
        { from: '94718191000', id: 'wamid.H2', timestamp: '1760000100', type: 'image', image: { id: 'MEDIA9', caption: 'Blue dress' } },
        { from: '94771234567', id: 'wamid.H3', timestamp: '1760000200', type: 'reaction', reaction: { emoji: '👍' } },
      ] }] }],
    }));
    expect(change.messages.map((m) => [m.id, m.direction, m.type, m.content, m.mediaId])).toEqual([
      ['wamid.H1', 'inbound', 'text', 'Price kiyada?', null],
      ['wamid.H2', 'outbound', 'image', 'Blue dress', 'MEDIA9'],
    ]);
  });

  it('phone contacts: names only', () => {
    const [change] = parseCoexistence(hook('smb_app_state_sync', {
      state_sync: [
        { type: 'contact', contact: { full_name: 'Nimal Perera', first_name: 'Nimal', phone_number: '+94 77 123 4567' }, action: 'add', metadata: { timestamp: '1' } },
        { type: 'contact', contact: { phone_number: '94770000000' }, action: 'remove', metadata: { timestamp: '1' } },
      ],
    }));
    expect(change.contacts).toEqual([{ phone: '94771234567', name: 'Nimal Perera', action: 'add' }, { phone: '94770000000', name: '', action: 'remove' }]);
  });

  it('normal message webhooks are not touched', async () => {
    expect(parseCoexistence(hook('messages', { messages: [{ id: 'x' }] }))).toEqual([]);
    const service = new CoexistenceService({ query: async () => { throw new Error('no db call expected'); } } as never);
    expect(await service.handle(hook('messages', { messages: [{ id: 'x' }] }))).toBeNull();
  });

  it('an echo is saved once and the AI bot steps back in that chat', async () => {
    const sql: string[] = [];
    const db = {
      query: async (text: string) => {
        sql.push(text.replace(/\s+/g, ' ').trim());
        if (text.includes('FROM whatsapp_channels')) return [{ id: 3, company_id: 34 }];
        if (text.includes('FROM bot_channel_user WHERE')) return [{ id: 50 }];
        if (text.includes('FROM bot_conversation WHERE')) return [{ id: 70 }];
        if (text.includes('INSERT INTO bot_message')) return [{ id: 900 }];
        return [];
      },
    };
    const pushes: unknown[] = [];
    const service = new CoexistenceService(db as never, { trigger: (...args: unknown[]) => pushes.push(args) } as never);
    const result = await service.handle(hook('smb_message_echoes', {
      message_echoes: [{ from: '94718191000', to: '94771234567', id: 'wamid.E1', timestamp: '1762600000', type: 'text', text: { body: 'Ok' } }],
    }));
    expect(result).toEqual({ accepted: true, coexistence: { smb_message_echoes: 1 } });
    expect(sql.some((s) => s.startsWith('UPDATE bot_channel_user SET manual_mode = TRUE'))).toBe(true);
    expect(sql.find((s) => s.startsWith('INSERT INTO bot_message'))).toContain('WHERE NOT EXISTS');
    expect(pushes.length).toBe(1);
  });
});
