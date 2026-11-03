/**
 * WhatsApp "Connect with Meta" as a full-page redirect (like the Facebook Page login), the Page choice details
 * (picture, category, Instagram) and the connected-account card.
 *
 * Run the API with:
 *   META_GRAPH_BASE_URL=http://127.0.0.1:4599 META_APP_ID=new-app META_APP_SECRET=new-secret
 *   META_OAUTH_REDIRECT_URI=http://localhost/cb META_WHATSAPP_CONFIG_ID=wa-config META_OAUTH_SUCCESS_REDIRECT=http://dash.test/channels/messenger
 * then: node --test test/whatsapp-redirect.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { API, api, closeDb, createWorkspace, sql } from './helpers.mjs';

const seen = { redirectUris: [], subscribed: false, registered: false };
const meta = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname.replace(/^\/v[\d.]+/, '');
  res.setHeader('Content-Type', 'application/json');
  const send = (data, status = 200) => { res.statusCode = status; res.end(JSON.stringify(data)); };
  req.resume();
  req.on('end', () => {
    if (path === '/oauth/access_token') {
      const uri = url.searchParams.get('redirect_uri');
      seen.redirectUris.push(uri);
      if (url.searchParams.get('code') === 'wa-code') {
        // a redirect-flow code only works with the same redirect_uri
        if (uri !== 'http://localhost/cb') return send({ error: { message: 'Error validating verification code. Please make sure your redirect_uri is identical' } }, 400);
        return send({ access_token: 'wa-business-token' });
      }
      if (url.searchParams.get('code') === 'page-code') return send({ access_token: 'user-token' });
      if (url.searchParams.get('grant_type') === 'fb_exchange_token') return send({ access_token: 'long-user-token' });
      return send({ error: { message: 'bad code' } }, 400);
    }
    if (path === '/debug_token') return send({ data: { app_id: 'new-app', is_valid: true, granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: ['waba-r'] }] } });
    if (path === '/waba-r/phone_numbers') return send({ data: [
      { id: 'pn-old', display_phone_number: '+94 70 000 0001', verified_name: 'Old', platform_type: 'CLOUD_API' },
      { id: 'pn-new', display_phone_number: '+94 78 801 0947', verified_name: 'VORA', platform_type: 'NOT_APPLICABLE' },
    ] });
    if (path === '/pn-new' && req.method === 'GET') return send({ id: 'pn-new', display_phone_number: '+94 78 801 0947', verified_name: 'VORA', quality_rating: 'GREEN' });
    if (path === '/waba-r/subscribed_apps' && req.method === 'POST') { seen.subscribed = true; return send({ success: true }); }
    if (path === '/pn-new/register' && req.method === 'POST') { seen.registered = true; return send({ success: true }); }
    if (path === '/me') return send({ id: 'meta-user-1' });
    if (path === '/me/accounts') return send({ data: [
      { id: 'page-a', name: 'VORA Clothing', access_token: 'tok-a', category: 'Clothing store', picture: { data: { url: 'https://img/page-a.jpg' } },
        instagram_business_account: { id: 'ig-a', username: 'vora.lk', name: 'VORA', profile_picture_url: 'https://img/ig-a.jpg' } },
      { id: 'page-b', name: 'VORA Fans', access_token: 'tok-b', category: 'Community' },
    ] });
    if (path === '/page-a') return send({ id: 'page-a', name: 'VORA Clothing', category: 'Clothing store', followers_count: 1520, link: 'https://facebook.com/vora', picture: { data: { url: 'https://img/page-a.jpg' } } });
    if (path === '/ig-a') return send({ id: 'ig-a', username: 'vora.lk', name: 'VORA', profile_picture_url: 'https://img/ig-a.jpg', followers_count: 980 });
    send({ error: { message: `not faked: ${req.method} ${path}` } }, 404);
  });
});

let owner;
const followCallback = (query) => fetch(`${API}/integrations/meta/callback?${new URLSearchParams(query)}`, { redirect: 'manual' });

test.before(async () => {
  await new Promise((resolve) => meta.listen(4599, '127.0.0.1', resolve));
  await sql(`UPDATE whatsapp_channels SET meta_phone_number_id = NULL WHERE meta_phone_number_id IN ('pn-new', 'pn-old')`);
  await sql(`DELETE FROM meta_page_connections WHERE page_id IN ('page-a', 'page-b')`);
  owner = await createWorkspace('waredirect');
  await sql(`UPDATE companies SET plan = 'growth' WHERE id = $1`, [owner.companyId]);
});
test.after(async () => { meta.close(); await closeDb(); });

test('WhatsApp auth URL is a normal Meta login page with the Embedded Signup configuration', async () => {
  const res = await api('GET', '/integrations/meta/whatsapp/auth-url', { token: owner.token });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const url = new URL(res.data.url);
  assert.match(url.pathname, /\/dialog\/oauth$/);
  assert.equal(url.searchParams.get('config_id'), 'wa-config');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost/cb');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('override_default_response_type'), 'true');
  assert.equal(JSON.parse(url.searchParams.get('extras')).sessionInfoVersion, '3');
  assert.ok(url.searchParams.get('state'));
});

test('Meta comes back with a code → the new number is connected and the browser returns to the WhatsApp page', async () => {
  const auth = await api('GET', '/integrations/meta/whatsapp/auth-url', { token: owner.token });
  const state = new URL(auth.data.url).searchParams.get('state');
  const res = await followCallback({ code: 'wa-code', state });
  assert.equal(res.status, 302);
  const back = new URL(res.headers.get('location'));
  assert.equal(back.origin + back.pathname, 'http://dash.test/channels/whatsapp');
  assert.equal(back.searchParams.get('meta'), 'whatsapp_connected', back.toString());
  assert.equal(back.searchParams.get('number'), '+94 78 801 0947');
  assert.equal(back.searchParams.get('name'), 'VORA');
  assert.equal(seen.redirectUris[0], 'http://localhost/cb', 'the redirect_uri is tried first for a redirect-flow code');
  assert.ok(seen.subscribed && seen.registered);
  // the NEW number from the signup is chosen, not the one already on the Cloud API
  const rows = await sql(`SELECT meta_phone_number_id, meta_waba_id FROM whatsapp_channels WHERE company_id = $1`, [owner.companyId]);
  assert.equal(rows[0].meta_phone_number_id, 'pn-new');
  assert.equal(rows[0].meta_waba_id, 'waba-r');
});

test('a cancelled or forged login returns to the WhatsApp page with a message', async () => {
  const auth = await api('GET', '/integrations/meta/whatsapp/auth-url', { token: owner.token });
  const state = new URL(auth.data.url).searchParams.get('state');
  const cancelled = await followCallback({ error: 'access_denied', error_description: 'Permissions error', state });
  const back = new URL(cancelled.headers.get('location'));
  assert.equal(back.pathname, '/channels/whatsapp');
  assert.equal(back.searchParams.get('meta'), 'error');
  const forged = await followCallback({ code: 'wa-code', state: `${state.split('.')[0]}.bad` });
  assert.equal(new URL(forged.headers.get('location')).searchParams.get('meta'), 'error');
});

test('Page choices carry the picture, category and Instagram account; the card shows who is connected', async () => {
  const auth = await api('GET', '/integrations/meta/auth-url?return_path=/channels/instagram', { token: owner.token });
  assert.equal(auth.status, 200, JSON.stringify(auth.json));
  const state = new URL(auth.data.url).searchParams.get('state');
  const res = await followCallback({ code: 'page-code', state });
  assert.equal(new URL(res.headers.get('location')).searchParams.get('meta'), 'connected');
  const pending = await api('GET', '/integrations/meta/pending-pages', { token: owner.token });
  const a = pending.data.pages.find((p) => p.id === 'page-a');
  assert.deepEqual(
    { picture: a.picture_url, category: a.category, ig: a.instagram_username, igName: a.instagram_name, igPic: a.instagram_picture_url, has: a.has_instagram },
    { picture: 'https://img/page-a.jpg', category: 'Clothing store', ig: 'vora.lk', igName: 'VORA', igPic: 'https://img/ig-a.jpg', has: true },
  );
  assert.equal(pending.data.pages.find((p) => p.id === 'page-b').has_instagram, false);

  await sql(`INSERT INTO meta_page_connections (company_id, page_id, page_name, page_access_token, instagram_business_account_id, status, created_at, updated_at) VALUES ($1, 'page-a', 'VORA Clothing', 'tok-a', 'ig-a', 'CONNECTED', NOW(), NOW())`, [owner.companyId]);
  const details = await api('GET', '/integrations/meta/account-details', { token: owner.token });
  assert.equal(details.status, 200, JSON.stringify(details.json));
  assert.deepEqual(details.data.whatsapp, { number: '+94 78 801 0947', name: 'VORA', quality: 'GREEN' });
  assert.equal(details.data.page.name, 'VORA Clothing');
  assert.equal(details.data.page.followers, 1520);
  assert.equal(details.data.instagram.username, 'vora.lk');
  assert.equal(details.data.instagram.followers, 980);
});
