import {
  parseEvolutionFindMessages,
  parseEvolutionFindChats,
  resolvePhoneFromChatList,
  resolveRelatedChatJids,
} from './evolution-inbox.util';

describe('parseEvolutionFindMessages', () => {
  it('parses Evolution v2 paginated messages.records', () => {
    const result = parseEvolutionFindMessages(
      {
        messages: {
          total: 1,
          pages: 1,
          currentPage: 1,
          records: [
            {
              id: 'db-1',
              key: {
                id: 'msg-1',
                fromMe: false,
                remoteJid: '94757120896@s.whatsapp.net',
              },
              messageType: 'conversation',
              message: { conversation: 'Hello from Evolution' },
              messageTimestamp: 1710000000,
            },
            {
              id: 'db-2',
              key: {
                id: 'msg-2',
                fromMe: true,
                remoteJid: '94757120896@s.whatsapp.net',
              },
              messageType: 'extendedTextMessage',
              message: {
                extendedTextMessage: { text: 'Reply text' },
              },
              messageTimestamp: '1710000060',
            },
          ],
        },
      },
      '94757120896@s.whatsapp.net',
    );

    expect(result).toHaveLength(2);
    expect(result[0].content).toBe('Hello from Evolution');
    expect(result[0].direction).toBe('inbound');
    expect(result[1].content).toBe('Reply text');
    expect(result[1].direction).toBe('outbound');
  });
});

describe('parseEvolutionFindChats', () => {
  it('keeps direct-messages chats', () => {
    const chats = parseEvolutionFindChats([
      {
        remoteJid: '94757120896@s.whatsapp.net',
        pushName: 'Customer',
        lastMessage: { message: { conversation: 'Hi' }, messageTimestamp: 1710000000 },
      },
    ]);
    expect(chats).toHaveLength(1);
    expect(chats[0].remote_jid).toBe('94757120896@s.whatsapp.net');
    expect(chats[0].last_message_preview).toBe('Hi');
  });

  it('resolves phone from @lid chat via remoteJidAlt', () => {
    const chats = parseEvolutionFindChats([
      {
        remoteJid: '206300533256221@lid',
        remoteJidAlt: '94750807055@s.whatsapp.net',
        pushName: 'Customer',
        lastMessage: { message: { conversation: 'Hi' }, messageTimestamp: 1710000000 },
      },
    ]);
    expect(chats).toHaveLength(1);
    expect(chats[0].alternate_jid).toBe('94750807055@s.whatsapp.net');
    expect(chats[0].phone).toBe('94750807055');
  });
});

describe('resolveRelatedChatJids', () => {
  const chats = parseEvolutionFindChats([
    {
      remoteJid: '206300533256221@lid',
      remoteJidAlt: '94750807055@s.whatsapp.net',
      pushName: 'Customer',
    },
  ]);

  it('links @lid and phone JIDs for the same contact', () => {
    expect(resolveRelatedChatJids('94750807055@s.whatsapp.net', chats).sort()).toEqual(
      ['206300533256221@lid', '94750807055@s.whatsapp.net'].sort(),
    );
    expect(resolveRelatedChatJids('206300533256221@lid', chats).sort()).toEqual(
      ['206300533256221@lid', '94750807055@s.whatsapp.net'].sort(),
    );
  });

  it('resolves real phone from @lid JID', () => {
    expect(resolvePhoneFromChatList('206300533256221@lid', chats)).toBe('94750807055');
    expect(resolvePhoneFromChatList('94750807055@s.whatsapp.net', chats)).toBe(
      '94750807055',
    );
  });
});
