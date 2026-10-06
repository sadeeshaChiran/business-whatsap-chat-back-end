/**
 * Everything a package can switch on / off or limit. The super admin edits these per package;
 * a key a package does not have yet counts as "allowed / unlimited" (so new features never break old packages).
 * max_agents and max_products are columns of platform_package.
 */
export type LimitKind = 'feature' | 'number';
export type LimitDefinition = { key: string; label: string; kind: LimitKind; group: string; description: string };

export const LIMIT_CATALOG: LimitDefinition[] = [
  { key: 'messenger', label: 'Messenger', kind: 'feature', group: 'Channels', description: 'Connect a Facebook Page; the AI replies on Messenger.' },
  { key: 'instagram', label: 'Instagram', kind: 'feature', group: 'Channels', description: 'The AI replies to Instagram DMs.' },
  { key: 'lead_management', label: 'Lead Management', kind: 'feature', group: 'Sales', description: 'Lead pipeline board (new → won).' },
  { key: 'crm', label: 'CRM', kind: 'feature', group: 'Sales', description: 'Contacts, 360 view, tags, follow-up tasks, CSV import / export.' },
  { key: 'marketing_ads', label: 'Marketing – ad results', kind: 'feature', group: 'Marketing', description: 'Chats, orders and sales per Click-to-WhatsApp / Messenger / Instagram ad.' },
  { key: 'marketing_pro', label: 'Marketing – Meta ads', kind: 'feature', group: 'Marketing', description: 'Connect the ad account: campaigns, ROAS, pause / budget, audiences, Conversions API.' },
  { key: 'campaigns', label: 'Campaigns, short links & QR', kind: 'feature', group: 'Marketing', description: 'Campaigns with their own AI instructions, short links and QR codes that open a chat and track customers.' },
  { key: 'broadcasts', label: 'WhatsApp broadcasts', kind: 'feature', group: 'Marketing', description: 'Send approved templates to customer groups.' },
  { key: 'broadcasts_per_month', label: 'Broadcast messages per month', kind: 'number', group: 'Marketing', description: 'Empty = unlimited.' },
  { key: 'reports_days', label: 'Report history (days)', kind: 'number', group: 'Reports', description: 'How far back Bot reports go. Empty = unlimited.' },
  { key: 'social', label: 'Social – comments, posts & analytics', kind: 'feature', group: 'Marketing', description: 'Facebook / Instagram comment replies (AI), posting & scheduling, Page and Instagram analytics.' },
  { key: 'mobile_app', label: 'Mobile app', kind: 'feature', group: 'Apps', description: 'Use the Agent Metra Android / iPhone app.' },
];

export type ResolvedLimits = {
  features: Record<string, boolean>;
  numbers: Record<string, number | null>;
  max_agents: number | null;
  max_products: number | null;
};

export function resolveLimits(pkg: { limits?: Record<string, unknown> | null; max_agents?: number | null; max_products?: number | null } | null): ResolvedLimits {
  const raw = (pkg?.limits ?? {}) as Record<string, unknown>;
  const features: Record<string, boolean> = {};
  const numbers: Record<string, number | null> = {};
  for (const item of LIMIT_CATALOG) {
    const value = raw[item.key];
    if (item.kind === 'feature') features[item.key] = pkg ? value !== false : false;
    else numbers[item.key] = value === null || value === undefined || value === '' ? null : Math.max(0, Number(value) || 0);
  }
  return {
    features, numbers,
    max_agents: pkg ? pkg.max_agents ?? null : 0,
    max_products: pkg ? pkg.max_products ?? null : 0,
  };
}

/** Cleans what the super admin sends: only known keys, right types. */
export function cleanLimits(input: unknown): Record<string, boolean | number | null> {
  const source = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const out: Record<string, boolean | number | null> = {};
  for (const item of LIMIT_CATALOG) {
    if (!(item.key in source)) continue;
    const value = source[item.key];
    if (item.kind === 'feature') out[item.key] = value === true || value === 'true';
    else out[item.key] = value === null || value === '' || value === undefined ? null : Math.max(0, Math.floor(Number(value) || 0));
  }
  return out;
}

export const limitLabel = (key: string) => LIMIT_CATALOG.find((item) => item.key === key)?.label ?? key;
