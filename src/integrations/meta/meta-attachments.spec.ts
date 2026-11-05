import { MetaMessagesController } from './meta-messages.controller';

function controller(graph: Record<string, unknown>, query: jest.Mock = jest.fn().mockResolvedValue([])) {
  const repo = { query };
  const c = new MetaMessagesController({} as never, {} as never, {} as never, repo as never, graph as never);
  (c as unknown as { downloadAndStore: unknown }).downloadAndStore = jest.fn().mockResolvedValue({ key: 'chat-media:1/x.jpg', fileName: 'x.jpg', contentType: 'image/jpeg' });
  return c as unknown as { buildRows: (...a: unknown[]) => Promise<Array<{ message_type: string; content: string; media_url: string | null; media_note?: string | null }>>; describeSharedLink: (t: string, ctx: unknown) => Promise<string | null> };
}

describe('Meta attachments', () => {
  it('a private-reply card shows the comment and the post photo', async () => {
    const query = jest.fn().mockResolvedValue([{ message: 'Price kiyada?', post_id: '262_99', post_text: 'Storage box Rs 1,475', post_link: 'https://fb.com/p/1' }]);
    const graph = { healthGet: jest.fn().mockResolvedValue({ ok: true, data: { full_picture: 'https://cdn/x.jpg' } }) };
    const rows = await controller(graph, query).buildRows(5, {
      attachments: [{ type: 'fallback', title: 'You are responding to a user comment to a post on your Page. View comment.', payload: { url: 'https://www.facebook.com/262_99?comment_id=777' } }],
    }, undefined, { token: 't' });
    expect(rows[0].message_type).toBe('image');
    expect(rows[0].content).toContain('Price kiyada?');
    expect(rows[0].content).toContain('Storage box');
    expect(query.mock.calls[0][1]).toEqual([5, '777']);
  });

  it('a photo without a link in the webhook is read from the message', async () => {
    const graph = { healthGet: jest.fn().mockResolvedValue({ ok: true, data: { attachments: { data: [{ mime_type: 'image/jpeg', image_data: { url: 'https://cdn/p.jpg' } }] } } }) };
    const rows = await controller(graph).buildRows(5, { attachments: [{ type: 'unsupported_type' }] }, undefined, { token: 't', mid: 'm1' });
    expect(rows).toEqual([{ message_type: 'image', content: '[image]', media_url: 'chat-media:1/x.jpg' }]);
  });

  it('a shared Instagram post of the account is described; other links are not', async () => {
    const graph = { healthGet: jest.fn().mockResolvedValue({ ok: true, data: { data: [{ shortcode: 'ABC1', caption: 'Storage box JR-402028 Rs 1,475' }] } }) };
    const c = controller(graph);
    await expect(c.describeSharedLink('meka https://www.instagram.com/p/ABC1/ ', { token: 't', igId: '17' })).resolves.toContain('JR-402028');
    await expect(c.describeSharedLink('https://www.instagram.com/p/OTHER/', { token: 't', igId: '17' })).resolves.toBeNull();
    await expect(c.describeSharedLink('no link here', { token: 't' })).resolves.toBeNull();
  });
});
