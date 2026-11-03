/**
 * Reference implementation of the customer app's end-to-end encryption (same protocol as the web app's src/customer/e2ee.ts),
 * used by the tests to encrypt / decrypt like a phone would. WebCrypto: ECDH P-256 device keys, HKDF-SHA256, AES-256-GCM.
 */
const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();
export const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
export const unb64 = (text) => new Uint8Array(Buffer.from(text, 'base64url'));
const rand = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
const INFO = enc.encode('am-ca-e2ee-v1');

export async function newDevice() {
  const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const raw = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  return { device_id: b64(rand(18)), privateKey: pair.privateKey, public_key: b64(raw) };
}

async function wrapKey(privateKey, publicKeyB64) {
  const pub = await subtle.importKey('raw', unb64(publicKeyB64), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const bits = await subtle.deriveBits({ name: 'ECDH', public: pub }, privateKey, 256);
  const hk = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: INFO }, hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function encrypt(me, devices, payload, fileBytes) {
  const contentKey = rand(32);
  const ck = await subtle.importKey('raw', contentKey, 'AES-GCM', false, ['encrypt']);
  const iv = rand(12);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, ck, enc.encode(JSON.stringify(payload))));
  const keys = {};
  for (const d of devices) {
    const wk = await wrapKey(me.privateKey, d.public_key);
    const wiv = rand(12);
    keys[d.device_id] = { iv: b64(wiv), wk: b64(new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: wiv }, wk, contentKey))) };
  }
  const cipher = { v: 1, iv: b64(iv), ct: b64(ct), sender_pub: me.public_key, sender_device: me.device_id, keys };
  if (!fileBytes) return { cipher };
  const miv = rand(12);
  const file = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: miv }, ck, fileBytes));
  cipher.media = { iv: b64(miv) };
  return { cipher, file };
}

/** The message's content key (raw bytes), or null when this device has no copy of it. */
export async function contentKey(me, cipher) {
  const w = cipher?.keys?.[me.device_id];
  if (!w) return null;
  const wk = await wrapKey(me.privateKey, w.from ?? cipher.sender_pub);
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: unb64(w.iv) }, wk, unb64(w.wk)));
}

export async function decrypt(me, cipher, fileBytes) {
  const raw = await contentKey(me, cipher);
  if (!raw) return null;
  const ck = await subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  const payload = JSON.parse(dec.decode(await subtle.decrypt({ name: 'AES-GCM', iv: unb64(cipher.iv) }, ck, unb64(cipher.ct))));
  const file = fileBytes && cipher.media ? new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: unb64(cipher.media.iv) }, ck, fileBytes)) : null;
  return { payload, file };
}

/** Wrap a message's key for another device (a new phone of either person). */
export async function rewrap(me, cipher, device) {
  const raw = await contentKey(me, cipher);
  if (!raw) return null;
  const wk = await wrapKey(me.privateKey, device.public_key);
  const iv = rand(12);
  return { iv: b64(iv), wk: b64(new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, wk, raw))), from: me.public_key };
}

/** Test helpers: a person's phone registers its key; send / read an encrypted member message through the API. */
export async function phone(api, token) {
  const device = await newDevice();
  const r = await api('POST', '/ca/keys', { token, body: { device_id: device.device_id, public_key: device.public_key } });
  if (r.status !== 201) throw new Error(`key registration failed: ${r.status} ${JSON.stringify(r.json)}`);
  return { ...device, token };
}
export async function sendDm(api, me, dmId, text) {
  const keys = await api('GET', `/ca/dms/${dmId}/keys`, { token: me.token });
  const { cipher } = await encrypt(me, keys.data.devices, { t: text });
  return api('POST', `/ca/dms/${dmId}/messages`, { token: me.token, body: { cipher } });
}
export async function readDm(api, me, dmId) {
  const r = await api('GET', `/ca/dms/${dmId}/messages`, { token: me.token });
  for (const m of r.data?.messages ?? []) m.plain = m.cipher ? (await decrypt(me, m.cipher).catch(() => null))?.payload?.t ?? null : m.text;
  return r;
}
