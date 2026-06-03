export type EvolutionQrPayload = {
  qr_image: string | null;
  pairing_code: string | null;
  link_code: string | null;
  raw_count: number | null;
};

const BASE64_IMAGE_PREFIX = /^data:image\/[a-zA-Z+.\-]+;base64,/i;

function normalizeBase64Image(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (BASE64_IMAGE_PREFIX.test(trimmed)) {
    return trimmed;
  }
  // Raw base64 PNG payloads are usually long; short strings are Baileys link codes.
  if (trimmed.length < 80) {
    return null;
  }
  const withoutPrefix = trimmed.replace(BASE64_IMAGE_PREFIX, '');
  return `data:image/png;base64,${withoutPrefix}`;
}

function readCount(record: Record<string, unknown>): number | null {
  if (typeof record.count === 'number') {
    return record.count;
  }
  const qrcode = record.qrcode;
  if (qrcode && typeof qrcode === 'object') {
    const nested = qrcode as Record<string, unknown>;
    if (typeof nested.count === 'number') {
      return nested.count;
    }
  }
  return null;
}

function walk(
  node: unknown,
  visit: (record: Record<string, unknown>) => void,
  depth = 0,
): void {
  if (depth > 8 || node == null) {
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      walk(item, visit, depth + 1);
    }
    return;
  }
  if (typeof node !== 'object') {
    return;
  }
  const record = node as Record<string, unknown>;
  visit(record);
  for (const value of Object.values(record)) {
    walk(value, visit, depth + 1);
  }
}

/** Parse Evolution connect/create payloads into a displayable QR or pairing code. */
export function parseEvolutionQrResponse(payload: unknown): EvolutionQrPayload {
  let qr_image: string | null = null;
  let pairing_code: string | null = null;
  let link_code: string | null = null;
  let raw_count: number | null = null;

  walk(payload, (record) => {
    if (raw_count == null) {
      raw_count = readCount(record);
    }

    for (const key of ['base64', 'qrcode', 'qr', 'qrCode'] as const) {
      const value = record[key];
      if (typeof value === 'string') {
        const image = normalizeBase64Image(value);
        if (image) {
          qr_image = image;
        } else if (!link_code && value.length > 0 && value.length < 80) {
          link_code = value;
        }
      }
    }

    for (const key of ['pairingCode', 'pairing_code'] as const) {
      if (typeof record[key] === 'string' && record[key].trim()) {
        pairing_code = record[key].trim();
      }
    }

    if (
      !link_code &&
      typeof record.code === 'string' &&
      record.code.trim() &&
      !record.code.startsWith('data:image')
    ) {
      link_code = record.code.trim();
    }
  });

  return { qr_image, pairing_code, link_code, raw_count };
}
