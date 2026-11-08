import { HIDDEN_PREVIEW, NO_PRIVACY, maskRows, maskThread } from './message-privacy';

describe('Inbox privacy: hide the message text of a channel', () => {
  const hideWa = { ...NO_PRIVACY, whatsapp: true };

  it('shows everything by default', () => {
    const thread = { messages: [{ id: 1, content: 'hi', media_url: 'x' }] };
    expect(maskThread(thread, NO_PRIVACY, 'whatsapp')).toBe(thread);
    const rows = [{ channelUser: { platform: 'whatsapp' }, last_message_preview: 'hi' }];
    expect(maskRows(rows, NO_PRIVACY)).toBe(rows);
  });

  it('hides the text, photos and quotes of a hidden channel but keeps who / when / ticks', () => {
    const thread = { conversation: { id: 9 }, messages: [
      { id: 1, direction: 'inbound', message_type: 'image', content: 'my address', media_url: 'meta-media:1', transcript: 'x',
        reply_to_text: 'quote', media_note: 'Blue dress', delivery_status: 'read', created_at: 't' },
    ] };
    const out = maskThread(thread, hideWa, 'whatsapp') as typeof thread & { messages_hidden?: boolean };
    expect(out.messages_hidden).toBe(true);
    expect(out.conversation).toEqual({ id: 9 });
    expect(out.messages[0]).toMatchObject({ id: 1, direction: 'inbound', message_type: 'image', delivery_status: 'read', created_at: 't',
      content: '', media_url: null, transcript: null, reply_to_text: '', media_note: null, hidden: true });
  });

  it('only the chosen channel is hidden', () => {
    const thread = { messages: [{ id: 1, content: 'hi' }] };
    expect(maskThread(thread, hideWa, 'messenger')).toBe(thread);
    const rows = [
      { channelUser: { platform: 'whatsapp' }, last_message_preview: 'secret' },
      { channelUser: { platform: 'instagram' }, last_message_preview: 'hello' },
      { channelUser: { platform: 'whatsapp' }, last_message_preview: null },
    ];
    const out = maskRows(rows, hideWa) as Array<Record<string, unknown>>;
    expect(out[0]).toMatchObject({ last_message_preview: HIDDEN_PREVIEW, message_hidden: true });
    expect(out[1]).toEqual(rows[1]);
    expect(out[2]).toMatchObject({ last_message_preview: null, message_hidden: true });
  });
});
