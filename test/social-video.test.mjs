/**
 * Social: videos, reels and stories (upload, Meta rules, background publishing + notification),
 * the posts list with every kind, and the results of one post – through a fake Meta Graph API.
 *
 * Run the API with
 *   META_GRAPH_BASE_URL=http://127.0.0.1:4599  META_RUPLOAD_BASE_URL=http://127.0.0.1:4599  IG_VIDEO_POLL_MS=200
 *   PUBLIC_API_BASE_URL=https://localhost:3001/v1/api   (https like production; the test reads the files over http)
 * then:  node --test test/social-video.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { api, closeDb, createWorkspace, sql } from './helpers.mjs';

const PAGE = `9${Date.now() % 1e9}`;
const IG = `17${Date.now() % 1e9}`;
const requests = [];
let containerChecks = 0;

const meta = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname.replace(/^\/v\d+\.\d+/, '');
    const json = body ? (() => { try { return JSON.parse(body); } catch { return null; } })() : null;
    requests.push({ method: req.method, path, body: json, query: Object.fromEntries(url.searchParams), headers: req.headers });
    res.setHeader('Content-Type', 'application/json');
    const send = (data, status = 200) => { res.statusCode = status; res.end(JSON.stringify(data)); };

    // rupload: Meta fetches the video from file_url
    if (path.startsWith('/video-upload/')) return send(req.headers.file_url ? { success: true } : { error: { message: 'file_url missing' } }, req.headers.file_url ? 200 : 400);

    // publishing
    if (req.method === 'POST' && path === `/${PAGE}/video_reels`) {
      if (json?.upload_phase === 'start') return send({ video_id: '5551', upload_url: `http://127.0.0.1:4599/video-upload/v22.0/5551` });
      return send({ success: true, post_id: `${PAGE}_reel1` });
    }
    if (req.method === 'POST' && path === `/${PAGE}/video_stories`) {
      if (json?.upload_phase === 'start') return send({ video_id: '5552', upload_url: `http://127.0.0.1:4599/video-upload/v22.0/5552` });
      return send({ success: true, post_id: `${PAGE}_story2` });
    }
    if (req.method === 'POST' && path === `/${PAGE}/photos`) return send({ id: 'photo9', post_id: `${PAGE}_photo9` });
    if (req.method === 'POST' && path === `/${PAGE}/photo_stories`) return send({ success: true, post_id: `${PAGE}_story1` });
    if (req.method === 'POST' && path === `/${PAGE}/videos`) return send({ id: '5553' });
    if (req.method === 'POST' && path === `/${IG}/media`) return send({ id: `c${requests.length}` });
    if (req.method === 'POST' && path === `/${IG}/media_publish`) return send({ id: `ig${requests.length}` });
    if (req.method === 'GET' && /^\/c\d+$/.test(path)) {
      containerChecks += 1;
      return send({ status_code: containerChecks % 2 ? 'IN_PROGRESS' : 'FINISHED' });
    }

    // lists
    if (path === `/${PAGE}/posts`) {
      return send({ data: [
        { id: `${PAGE}_1`, message: 'Photo post', created_time: '2026-10-20T10:00:00+0000', full_picture: 'https://x/p.jpg', permalink_url: 'https://fb/p1', reactions: { summary: { total_count: 5 } }, comments: { summary: { total_count: 2 } }, shares: { count: 1 }, attachments: { data: [{ media_type: 'photo', media: { image: { src: 'https://x/p.jpg' } } }] } },
        { id: `${PAGE}_2`, message: 'Video post', created_time: '2026-10-21T10:00:00+0000', full_picture: 'https://x/v.jpg', permalink_url: 'https://fb/p2', attachments: { data: [{ media_type: 'video', media: { source: 'https://x/v.mp4', image: { src: 'https://x/v.jpg' } }, target: { id: '7001' } }] } },
        { id: `${PAGE}_3`, message: 'Reel shown in the feed too', created_time: '2026-10-22T10:00:00+0000', attachments: { data: [{ media_type: 'video', target: { id: '7002' } }] } },
      ] });
    }
    if (path === `/${PAGE}/video_reels`) return send({ data: [{ id: '7002', description: 'My reel', created_time: '2026-10-22T10:00:00+0000', permalink_url: '/reel/7002', picture: 'https://x/r.jpg', source: 'https://x/r.mp4' }] });
    if (path === `/${PAGE}/stories`) return send({ data: [{ post_id: `${PAGE}_s1`, status: 'PUBLISHED', creation_time: '1792000000', media_type: 'photo', url: 'https://fb/s1' }] });
    if (path === `/${IG}/media`) {
      // the rich field list is "not supported" once, to check the fallback to basic fields
      if (String(url.searchParams.get('fields')).includes('children') && !meta.igRichOk) { meta.igRichOk = true; return send({ error: { message: 'Tried accessing nonexisting field (children)' } }, 400); }
      return send({ data: [
        { id: '1801', caption: 'IG photo', media_type: 'IMAGE', media_product_type: 'FEED', media_url: 'https://x/i.jpg', permalink: 'https://ig/1', timestamp: '2026-10-19T10:00:00+0000', like_count: 9, comments_count: 1 },
        { id: '1802', caption: 'IG reel', media_type: 'VIDEO', media_product_type: 'REELS', media_url: 'https://x/ir.mp4', thumbnail_url: 'https://x/ir.jpg', permalink: 'https://ig/2', timestamp: '2026-10-23T10:00:00+0000', like_count: 30, comments_count: 4 },
      ] });
    }
    if (path === `/${IG}/stories`) return send({ data: [{ id: '1803', media_type: 'IMAGE', media_url: 'https://x/is.jpg', permalink: 'https://ig/3', timestamp: '2026-10-24T10:00:00+0000' }] });

    // one item + its results
    if (path === `/${PAGE}_1`) return send({ id: `${PAGE}_1`, shares: { count: 1 }, reactions: { summary: { total_count: 5 } }, comments: { summary: { total_count: 2 } } });
    if (path === `/${PAGE}_1/insights`) {
      const metric = url.searchParams.get('metric');
      const known = { post_impressions_unique: 120, post_impressions: 180, post_clicks: 14, post_impressions_organic_unique: 100, post_impressions_paid_unique: 20, post_reactions_by_type_total: { like: 4, love: 1 } };
      if (!(metric in known)) return send({ error: { message: `(#100) The value must be a valid insights metric (${metric})` } }, 400);
      return send({ data: [{ name: metric, values: [{ value: known[metric] }] }] });
    }
    if (path === '/7002') return send({ id: '7002', from: { id: PAGE }, likes: { summary: { total_count: 11 } }, comments: { summary: { total_count: 3 } } });
    if (path === '/7002/video_insights') {
      const metric = url.searchParams.get('metric');
      const known = { fb_reels_total_plays: 900, post_impressions_unique: 640, post_video_avg_time_watched: 6400, fb_reels_replay_count: 40, post_video_retention_graph: { 0: 1, 5: 0.6, 10: 0.35 } };
      if (!(metric in known)) return send({ error: { message: 'unknown metric' } }, 400);
      return send({ data: [{ name: metric, values: [{ value: known[metric] }] }] });
    }
    if (path === '/1802') return send({ id: '1802', owner: { id: IG }, like_count: 30, comments_count: 4, media_product_type: 'REELS' });
    if (path === '/1802/insights') {
      const metric = url.searchParams.get('metric');
      const known = { reach: 1500, views: 2600, likes: 30, comments: 4, shares: 7, saved: 12, total_interactions: 53, ig_reels_avg_watch_time: 8200 };
      if (!(metric in known)) return send({ error: { message: 'metric not supported' } }, 400);
      return send({ data: [{ name: metric, values: [{ value: known[metric] }] }] });
    }
    if (path === '/9999') return send({ id: '9999', owner: { id: '123' } });
    send({ error: { message: `not faked: ${req.method} ${path}` } }, 404);
  });
});

let owner;
const video = (name = 'clip.mp4') => {
  const form = new FormData();
  form.append('file', new Blob([Buffer.alloc(4096, 1)], { type: 'video/mp4' }), name);
  return form;
};
const photo = () => {
  const form = new FormData();
  form.append('file', new Blob([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(200)], { type: 'image/png' }), 'p.png');
  return form;
};
const waitFor = async (check, ms = 20_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) return null;
    await new Promise((r) => setTimeout(r, 300));
  }
};

test.before(async () => {
  await new Promise((resolve) => meta.listen(4599, '127.0.0.1', resolve));
  owner = await createWorkspace('socvid');
  await sql(`UPDATE companies SET plan = 'growth' WHERE id = $1`, [owner.companyId]);
  await sql(`INSERT INTO meta_page_connections (company_id, meta_user_id, page_id, page_name, page_access_token, instagram_business_account_id, status, created_at, updated_at) VALUES ($1, '', $2, 'Test Page', 'tok', $3, 'CONNECTED', NOW(), NOW())`,
    [owner.companyId, PAGE, IG]);
  await new Promise((r) => setTimeout(r, 31_000)); // the API keeps a company's package 30 s
});
test.after(async () => { meta.close(); await closeDb(); });

let videoUrl; let photoUrl;

test('upload: MP4 video and PNG photo get public links; other files are refused', async () => {
  const v = await api('POST', '/social/media', { token: owner.token, form: video() });
  assert.equal(v.status, 201, JSON.stringify(v.json));
  assert.equal(v.data.kind, 'video');
  assert.match(new URL(v.data.url).pathname, /\.mp4$/);
  videoUrl = v.data.url;
  const p = await api('POST', '/social/media', { token: owner.token, form: photo() });
  assert.equal(p.status, 201, JSON.stringify(p.json));
  assert.equal(p.data.kind, 'image');
  photoUrl = p.data.url;
  const form = new FormData();
  form.append('file', new Blob(['hello'], { type: 'text/plain' }), 'a.txt');
  const bad = await api('POST', '/social/media', { token: owner.token, form });
  assert.equal(bad.status, 400);
  // the public link streams the file, also in parts
  // the API runs with an https PUBLIC_API_BASE_URL (Meta needs https); locally the same link is served over http
  const local = videoUrl.replace(/^https:/, 'http:');
  const full = await fetch(local);
  assert.equal(full.status, 200);
  assert.equal((await full.arrayBuffer()).byteLength, 4096);
  const part = await fetch(local, { headers: { Range: 'bytes=0-99' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), 'bytes 0-99/4096');
  assert.equal((await part.arrayBuffer()).byteLength, 100);
});

test('Meta rules are checked before sending', async () => {
  const reelPhoto = await api('POST', '/social/posts', { token: owner.token, body: { platforms: ['facebook'], format: 'reel', message: 'x', media_urls: [photoUrl] } });
  assert.equal(reelPhoto.status, 400);
  assert.match(String(reelPhoto.json?.message), /reel is one video/i);
  const mixed = await api('POST', '/social/posts', { token: owner.token, body: { platforms: ['facebook'], message: 'x', media_urls: [photoUrl, videoUrl] } });
  assert.equal(mixed.status, 400);
  const twoStory = await api('POST', '/social/posts', { token: owner.token, body: { platforms: ['instagram'], format: 'story', media_urls: [photoUrl, photoUrl] } });
  assert.equal(twoStory.status, 400);
});

test('reel "post now": queued, published in the background on both platforms, owner notified', async () => {
  requests.length = 0;
  const r = await api('POST', '/social/posts', { token: owner.token, body: { platforms: ['facebook', 'instagram'], format: 'reel', message: 'New dresses 👗 #sale', media_urls: [videoUrl] } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.ok(r.data.queued?.id, 'queued');
  assert.equal(r.data.queued.format, 'reel');
  const row = await waitFor(async () => {
    const [x] = await sql(`SELECT * FROM social_post_schedule WHERE id = $1`, [r.data.queued.id]);
    return x.status === 'published' ? x : null;
  });
  assert.ok(row, 'published');
  assert.equal(row.error, null);
  assert.equal(row.results.facebook.id, `${PAGE}_reel1`);
  assert.ok(row.results.instagram.id);
  // Facebook: start → rupload with file_url → finish PUBLISHED with the caption
  const fbStart = requests.find((q) => q.path === `/${PAGE}/video_reels` && q.body?.upload_phase === 'start');
  const fbUpload = requests.find((q) => q.path.startsWith('/video-upload/'));
  const fbFinish = requests.find((q) => q.path === `/${PAGE}/video_reels` && q.body?.upload_phase === 'finish');
  assert.ok(fbStart && fbUpload && fbFinish);
  assert.equal(fbUpload.headers.file_url, videoUrl);
  assert.equal(fbFinish.body.video_state, 'PUBLISHED');
  assert.equal(fbFinish.body.description, 'New dresses 👗 #sale');
  // Instagram: REELS container, waited until FINISHED, then published
  const igCreate = requests.find((q) => q.path === `/${IG}/media` && q.method === 'POST');
  assert.equal(igCreate.body.media_type, 'REELS');
  assert.equal(igCreate.body.video_url, videoUrl);
  assert.equal(igCreate.body.share_to_feed, true);
  assert.ok(requests.some((q) => q.path === `/${IG}/media_publish`));
  const [note] = await sql(`SELECT title FROM bot_notification WHERE company_id = $1 AND kind = 'social' ORDER BY id DESC LIMIT 1`, [owner.companyId]);
  assert.equal(note.title, 'Your reel is live');
});

test('photo story is published right away; video story goes to the background', async () => {
  requests.length = 0;
  const s = await api('POST', '/social/posts', { token: owner.token, body: { platforms: ['facebook', 'instagram'], format: 'story', message: 'ignored for stories', media_urls: [photoUrl] } });
  assert.equal(s.status, 201, JSON.stringify(s.json));
  assert.equal(s.data.published.facebook.id, `${PAGE}_story1`);
  assert.ok(s.data.published.instagram.id);
  const unpublished = requests.find((q) => q.path === `/${PAGE}/photos`);
  assert.equal(unpublished.body.published, false);
  const igStory = requests.find((q) => q.path === `/${IG}/media` && q.method === 'POST');
  assert.deepEqual({ type: igStory.body.media_type, url: igStory.body.image_url, caption: igStory.body.caption }, { type: 'STORIES', url: photoUrl, caption: undefined });

  const v = await api('POST', '/social/posts', { token: owner.token, body: { platforms: ['facebook'], format: 'story', media_urls: [videoUrl] } });
  assert.equal(v.status, 201, JSON.stringify(v.json));
  assert.ok(v.data.queued?.id);
  const row = await waitFor(async () => {
    const [x] = await sql(`SELECT * FROM social_post_schedule WHERE id = $1`, [v.data.queued.id]);
    return x.status === 'published' ? x : null;
  });
  assert.equal(row.results.facebook.id, `${PAGE}_story2`);
});

test('a video in a normal post: Facebook /videos, Instagram feed reel', async () => {
  requests.length = 0;
  const r = await api('POST', '/social/posts', { token: owner.token, body: { platforms: ['facebook', 'instagram'], message: 'Watch this', media_urls: [videoUrl] } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const row = await waitFor(async () => {
    const [x] = await sql(`SELECT * FROM social_post_schedule WHERE id = $1`, [r.data.queued.id]);
    return x.status === 'published' ? x : null;
  });
  assert.equal(row.results.facebook.id, '5553');
  const fb = requests.find((q) => q.path === `/${PAGE}/videos`);
  assert.deepEqual(fb.body, { file_url: videoUrl, description: 'Watch this' });
});

test('drafts keep their format; "post now" on a reel draft goes to the background', async () => {
  const d = await api('POST', '/social/posts', { token: owner.token, body: { platforms: ['instagram'], format: 'reel', message: 'draft reel', media_urls: [videoUrl], draft: true } });
  assert.equal(d.status, 201, JSON.stringify(d.json));
  assert.equal(d.data.draft.format, 'reel');
  const p = await api('POST', `/social/schedules/${d.data.draft.id}/publish`, { token: owner.token });
  assert.equal(p.status, 201, JSON.stringify(p.json));
  assert.equal(p.data.queued.id, d.data.draft.id);
  const row = await waitFor(async () => {
    const [x] = await sql(`SELECT * FROM social_post_schedule WHERE id = $1`, [d.data.draft.id]);
    return x.status === 'published' ? x : null;
  });
  assert.ok(row?.results?.instagram?.id);
});

test('posts list: every kind, reels not listed twice, filter by kind, fallback fields', async () => {
  const fb = await api('GET', '/social/posts?platform=facebook', { token: owner.token });
  assert.equal(fb.status, 200, fb.text);
  const kinds = fb.data.posts.map((p) => `${p.kind}:${p.id}`);
  assert.ok(kinds.includes(`post:${PAGE}_1`));
  assert.ok(kinds.includes(`video:${PAGE}_2`));
  assert.ok(kinds.includes('reel:7002'));
  assert.ok(!kinds.includes(`video:${PAGE}_3`), 'the reel is not listed again as a video post');
  assert.ok(kinds.some((k) => k.startsWith('story:')));
  const reel = fb.data.posts.find((p) => p.id === '7002');
  assert.equal(reel.video, 'https://x/r.mp4');
  assert.equal(reel.link, 'https://www.facebook.com/reel/7002');
  // newest first
  const times = fb.data.posts.map((p) => new Date(p.created_time).getTime());
  assert.deepEqual(times, [...times].sort((a, b) => b - a));

  const ig = await api('GET', '/social/posts?platform=instagram', { token: owner.token });
  assert.equal(ig.status, 200, ig.text);
  assert.deepEqual(ig.data.posts.map((p) => p.kind).sort(), ['post', 'reel', 'story']);
  const igReels = await api('GET', '/social/posts?platform=instagram&kind=reel', { token: owner.token });
  assert.deepEqual(igReels.data.posts.map((p) => p.id), ['1802']);
  assert.equal(igReels.data.posts[0].video, 'https://x/ir.mp4');
});

test('results of one post: Facebook post, Facebook reel, Instagram reel; unknown metrics are skipped', async () => {
  const post = await api('GET', `/social/posts/${PAGE}_1/insights?platform=facebook&kind=post`, { token: owner.token });
  assert.equal(post.status, 200, post.text);
  assert.equal(post.data.reach, 120);
  assert.equal(post.data.views, 180);
  assert.deepEqual(post.data.reactions, { like: 4, love: 1 });
  assert.ok(post.data.metrics.some((m) => m.key === 'clicks' && m.value === 14));
  assert.ok(post.data.metrics.some((m) => m.key === 'paid_reach' && m.value === 20));
  assert.equal(post.data.engagement_rate, Math.round(((5 + 2 + 1) / 120) * 1000) / 10);

  const reel = await api('GET', '/social/posts/7002/insights?platform=facebook&kind=reel', { token: owner.token });
  assert.equal(reel.status, 200, reel.text);
  assert.equal(reel.data.views, 900);
  assert.equal(reel.data.reach, 640);
  assert.ok(reel.data.metrics.some((m) => m.key === 'avg_watch' && m.value === 6.4));
  assert.deepEqual(reel.data.retention.map((r) => r.value), [100, 60, 35]);

  const ig = await api('GET', '/social/posts/1802/insights?platform=instagram&kind=reel', { token: owner.token });
  assert.equal(ig.status, 200, ig.text);
  assert.equal(ig.data.reach, 1500);
  assert.equal(ig.data.views, 2600);
  assert.equal(ig.data.interactions, 53);
  assert.ok(ig.data.metrics.some((m) => m.key === 'saved' && m.value === 12));
  assert.ok(ig.data.metrics.some((m) => m.key === 'avg_watch' && m.value === 8.2));

  const foreign = await api('GET', '/social/posts/9999/insights?platform=instagram', { token: owner.token });
  assert.equal(foreign.status, 400);
  const otherPage = await api('GET', '/social/posts/123_456/insights?platform=facebook', { token: owner.token });
  assert.equal(otherPage.status, 400);
});
