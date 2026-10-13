import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomBytes } from 'crypto';
import { DataSource } from 'typeorm';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { isChatMediaKey, publicChatMediaUrl, saveChatMedia } from '../bot-admin/chat-media.store';
import { FlowHook, type FlowCommentEvent, type FlowInboundEvent } from '../common/flow-hook';
import { PusherService } from '../common/pusher.service';
import { graphRequest } from '../marketing/graph';
import { FlowSenderService, numbered, type Outgoing, type Platform, type Target } from './flow-sender.service';

/* ═══════════════ types ═══════════════ */

export const FIELD_TYPES = ['text', 'long_text', 'phone', 'email', 'number', 'date', 'choice', 'multi', 'address', 'photo'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];
export type FormField = { id: string; label: string; type: FieldType; required?: boolean; options?: string[]; maps_to?: 'name' | 'phone' | 'email' | 'address' | ''; placeholder?: string };
export type FormInput = { name: string; title?: string; intro?: string; fields: Array<Omit<FormField, 'id'> & { id?: string }>; thank_you?: string; add_tags?: string[]; set_stage?: string | null; notify?: boolean; active?: boolean };

export const TRIGGERS = ['first_message', 'keyword', 'ad', 'comment'] as const;
export type Trigger = (typeof TRIGGERS)[number];
export const STEP_TYPES = ['text', 'image', 'video', 'buttons', 'form', 'delay', 'tag', 'stage', 'handoff'] as const;
export type Step = {
  id: string; type: (typeof STEP_TYPES)[number];
  text?: string; media_key?: string; url?: string; caption?: string;
  buttons?: Array<{ label: string; goto?: number | null; tag?: string }>; save_as?: string;
  form_id?: number; form_mode?: 'chat' | 'link';
  seconds?: number; tags?: string[]; stage?: string; to?: 'ai' | 'human';
};
export type TriggerConfig = {
  keywords?: string[]; match?: 'contains' | 'exact' | 'starts';
  any_ad?: boolean; campaign_ids?: string[]; ad_ids?: string[];
  post_ids?: string[]; comment_reply?: string; comment_platforms?: Array<'facebook' | 'instagram'>;
  gap_days?: number; once_per_contact?: boolean;
};
export type FlowInput = {
  name: string; description?: string; status?: 'active' | 'paused' | 'draft'; trigger_type: Trigger; trigger_config?: TriggerConfig;
  channels?: Platform[]; steps: Step[]; priority?: number;
};
type Waiting =
  | { kind: 'buttons'; step: number; attempts: number }
  | { kind: 'question'; step: number; form_id: number; field: number; answers: Record<string, unknown>; attempts: number; suggest?: string[] };
type Run = { id: number; flow_id: number; company_id: number; conversation_id: number; bot_channel_user_id: number | null; platform: Platform; status: string; step_index: number; waiting: Waiting | null; vars: Record<string, unknown> };

const STAGES = ['new', 'contacted', 'qualified', 'proposal', 'won', 'lost'];
const STOP_WORDS = /^(stop|cancel|exit|quit|nevathanna|epa)$/i;
const MAX_STEPS = 40;
const MAX_FIELDS = 25;
const clean = (value: unknown, max = 2000) => String(value ?? '').trim().slice(0, max);
const norm = (value: string) => value.toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

/* ═══════════════ service ═══════════════ */

@Injectable()
export class FlowsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FlowsService.name);
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly sender: FlowSenderService,
    private readonly pusherService: PusherService,
  ) {}

  onModuleInit() {
    FlowHook.register({ inbound: (event) => this.inbound(event), comment: (event) => this.comment(event) });
    const every = Number(process.env.FLOW_TICK_MS ?? 15_000);
    if (every > 0) this.timer = setInterval(() => void this.resumeDelayed(), every);
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  private async adminCompany(user: AuthenticatedUser): Promise<number> {
    const [row] = await this.dataSource.query(`SELECT id, admin_user_id FROM companies WHERE id = $1`, [user.company_id]);
    if (!row) throw new ForbiddenException('No company.');
    if (Number(row.admin_user_id) !== Number(user.id)) throw new ForbiddenException('Only the company admin can manage flows and forms.');
    return Number(row.id);
  }

  /* ═══════════════ forms: CRUD ═══════════════ */

  private validateForm(input: FormInput): FormInput {
    const name = clean(input.name, 120);
    if (!name) throw new BadRequestException('Give the form a name.');
    const fields = (input.fields ?? []).slice(0, MAX_FIELDS).map((f, index) => {
      const type = FIELD_TYPES.includes(f.type) ? f.type : 'text';
      const label = clean(f.label, 200);
      if (!label) throw new BadRequestException(`Question ${index + 1} needs a text.`);
      const options = (f.options ?? []).map((o) => clean(o, 60)).filter(Boolean).slice(0, 20);
      if ((type === 'choice' || type === 'multi') && options.length < 2) throw new BadRequestException(`“${label}” needs at least 2 choices.`);
      return {
        id: clean(f.id, 40) || `f${index + 1}`, label, type, required: Boolean(f.required),
        ...(options.length ? { options } : {}),
        maps_to: ['name', 'phone', 'email', 'address'].includes(String(f.maps_to)) ? f.maps_to : '',
        placeholder: clean(f.placeholder, 120),
      } as FormField;
    });
    if (!fields.length) throw new BadRequestException('Add at least one question.');
    const ids = new Set<string>();
    for (const field of fields) { if (ids.has(field.id)) field.id = `${field.id}_${randomBytes(2).toString('hex')}`; ids.add(field.id); }
    return {
      name, title: clean(input.title, 200) || name, intro: clean(input.intro, 1000), fields,
      thank_you: clean(input.thank_you, 1000) || 'Thank you! We received your details.',
      add_tags: [...new Set((input.add_tags ?? []).map((t) => clean(t, 40).toLowerCase()).filter(Boolean))].slice(0, 10),
      set_stage: input.set_stage && STAGES.includes(input.set_stage) ? input.set_stage : null,
      notify: input.notify ?? true, active: input.active ?? true,
    };
  }

  async forms(user: AuthenticatedUser) {
    const companyId = await this.adminCompany(user);
    return this.dataSource.query(`
      SELECT f.*, (SELECT COUNT(*) FROM chat_form_submission s WHERE s.form_id = f.id)::int AS submissions,
             (SELECT MAX(created_at) FROM chat_form_submission s WHERE s.form_id = f.id) AS last_submission_at
        FROM chat_form f WHERE f.company_id = $1 ORDER BY f.updated_at DESC`, [companyId]);
  }

  async form(user: AuthenticatedUser, id: number) {
    const companyId = await this.adminCompany(user);
    return this.ownForm(companyId, id);
  }

  private async ownForm(companyId: number, id: number) {
    const [row] = await this.dataSource.query(`SELECT * FROM chat_form WHERE id = $1 AND company_id = $2`, [id, companyId]);
    if (!row) throw new NotFoundException('Form not found.');
    return row;
  }

  async createForm(user: AuthenticatedUser, input: FormInput) {
    const companyId = await this.adminCompany(user);
    const f = this.validateForm(input);
    const slug = randomBytes(5).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, 'x');
    const [row] = await this.dataSource.query(`
      INSERT INTO chat_form (company_id, name, slug, title, intro, fields, thank_you, add_tags, set_stage, notify, active, created_by)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [companyId, f.name, slug, f.title, f.intro, JSON.stringify(f.fields), f.thank_you, f.add_tags, f.set_stage, f.notify, f.active, user.id]);
    return row;
  }

  async updateForm(user: AuthenticatedUser, id: number, input: FormInput) {
    const companyId = await this.adminCompany(user);
    await this.ownForm(companyId, id);
    const f = this.validateForm(input);
    const [row] = await this.dataSource.query(`
      UPDATE chat_form SET name=$3, title=$4, intro=$5, fields=$6::jsonb, thank_you=$7, add_tags=$8, set_stage=$9, notify=$10, active=$11, updated_at=NOW()
       WHERE id=$1 AND company_id=$2 RETURNING *`,
      [id, companyId, f.name, f.title, f.intro, JSON.stringify(f.fields), f.thank_you, f.add_tags, f.set_stage, f.notify, f.active]);
    return row;
  }

  async deleteForm(user: AuthenticatedUser, id: number) {
    const companyId = await this.adminCompany(user);
    await this.ownForm(companyId, id);
    const used = await this.dataSource.query(`SELECT name FROM automation_flow WHERE company_id = $1 AND steps @> $2::jsonb`, [companyId, JSON.stringify([{ form_id: id }])]);
    if (used.length) throw new BadRequestException(`This form is used in: ${used.map((u: { name: string }) => u.name).join(', ')}. Remove it from those flows first.`);
    await this.dataSource.query(`DELETE FROM chat_form WHERE id = $1 AND company_id = $2`, [id, companyId]);
    return { deleted: true };
  }

  async submissions(user: AuthenticatedUser, id: number) {
    const companyId = await this.adminCompany(user);
    const form = await this.ownForm(companyId, id);
    const rows = await this.dataSource.query(`
      SELECT s.id, s.answers, s.source, s.channel, s.conversation_id, s.created_at, cu.display_name, cu.external_user_id, cu.platform
        FROM chat_form_submission s LEFT JOIN bot_channel_user cu ON cu.id = s.bot_channel_user_id
       WHERE s.form_id = $1 ORDER BY s.created_at DESC LIMIT 1000`, [id]);
    return { form, submissions: rows.map((r: Record<string, unknown>) => ({ ...r, answers: this.displayAnswers(form.fields, r.answers as Record<string, unknown>) })) };
  }

  /** photo answers are stored as media keys – give the dashboard a link */
  private displayAnswers(fields: FormField[], answers: Record<string, unknown>) {
    const out: Record<string, unknown> = { ...answers };
    for (const field of fields ?? []) {
      const value = out[field.id];
      if (field.type === 'photo' && typeof value === 'string' && isChatMediaKey(value)) out[field.id] = publicChatMediaUrl(value, 7 * 24 * 3600) ?? value;
    }
    return out;
  }

  /* ═══════════════ forms: public link page ═══════════════ */

  async publicForm(slug: string, token?: string) {
    const [form] = await this.dataSource.query(`
      SELECT f.id, f.title, f.intro, f.fields, f.thank_you, f.active, c.company_name AS company_name
        FROM chat_form f JOIN companies c ON c.id = f.company_id WHERE f.slug = $1`, [clean(slug, 40)]);
    if (!form || !form.active) throw new NotFoundException('This form is not available.');
    let prefill: Record<string, string> = {};
    if (token) {
      const [invite] = await this.dataSource.query(`
        SELECT i.used_at, cu.display_name, cu.external_user_id, cu.platform FROM chat_form_invite i
          LEFT JOIN bot_channel_user cu ON cu.id = i.bot_channel_user_id WHERE i.token = $1 AND i.form_id = $2`, [clean(token, 40), form.id]);
      if (invite?.used_at) return { ...this.publicShape(form), already_sent: true };
      if (invite) {
        for (const field of form.fields as FormField[]) {
          if (field.maps_to === 'name' && invite.display_name) prefill[field.id] = invite.display_name;
          if (field.maps_to === 'phone' && invite.platform === 'whatsapp') prefill[field.id] = `+${invite.external_user_id}`;
        }
      }
    }
    return { ...this.publicShape(form), prefill };
  }

  private publicShape(form: Record<string, unknown>) {
    return { title: form.title, intro: form.intro, fields: form.fields, thank_you: form.thank_you, company_name: form.company_name };
  }

  async publicUpload(slug: string, file?: { buffer: Buffer; mimetype: string; originalname: string }) {
    const [form] = await this.dataSource.query(`SELECT id, company_id, active FROM chat_form WHERE slug = $1`, [clean(slug, 40)]);
    if (!form?.active) throw new NotFoundException('This form is not available.');
    if (!file?.buffer?.length) throw new BadRequestException('Choose a photo.');
    if (!/^image\/(jpeg|png|webp|heic|heif)$/.test(file.mimetype)) throw new BadRequestException('Use a photo (JPG or PNG).');
    if (file.buffer.length > 8 * 1024 * 1024) throw new BadRequestException('The photo is larger than 8 MB.');
    return { key: saveChatMedia(Number(form.company_id), file.buffer, file.mimetype, file.originalname || 'photo.jpg') };
  }

  async publicSubmit(slug: string, body: { token?: string; answers?: Record<string, unknown> }, ip?: string) {
    const [form] = await this.dataSource.query(`SELECT * FROM chat_form WHERE slug = $1`, [clean(slug, 40)]);
    if (!form?.active) throw new NotFoundException('This form is not available.');
    const answers: Record<string, unknown> = {};
    const errors: Record<string, string> = {};
    for (const field of form.fields as FormField[]) {
      const raw = body.answers?.[field.id];
      const result = this.checkAnswer(field, Array.isArray(raw) ? raw.map(String) : raw == null ? '' : String(raw), true);
      if (result.error) errors[field.id] = result.error;
      else if (result.value !== undefined) answers[field.id] = result.value;
    }
    if (Object.keys(errors).length) throw new BadRequestException({ message: 'Please check the highlighted answers.', errors });
    let invite: Record<string, unknown> | null = null;
    if (body.token) {
      [invite] = updatedRows(await this.dataSource.query(
        `UPDATE chat_form_invite SET used_at = NOW() WHERE token = $1 AND form_id = $2 AND used_at IS NULL RETURNING *`, [clean(body.token, 40), form.id]));
      if (!invite) {
        const [used] = await this.dataSource.query(`SELECT used_at FROM chat_form_invite WHERE token = $1 AND form_id = $2`, [clean(body.token, 40), form.id]);
        if (used?.used_at) throw new BadRequestException('This form was already sent from this link. Thank you!');
      }
    }
    const recent = await this.dataSource.query(
      `SELECT COUNT(*)::int AS n FROM chat_form_submission WHERE form_id = $1 AND ip = $2 AND created_at > NOW() - INTERVAL '10 minutes'`, [form.id, clean(ip, 64)]);
    if (!invite && Number(recent[0]?.n) >= 5) throw new BadRequestException('Too many answers from this device – please try again later.');
    await this.saveSubmission(form, answers, {
      source: 'link', ip: clean(ip, 64),
      channelUserId: invite?.bot_channel_user_id ? Number(invite.bot_channel_user_id) : null,
      conversationId: invite?.conversation_id ? Number(invite.conversation_id) : null,
      channel: (invite?.channel as string) ?? null,
    });
    if (invite?.conversation_id) {
      // tell the customer in the chat that we got it
      const target = await this.sender.target(Number(invite.conversation_id));
      if (target) await this.sender.send(target, { kind: 'text', text: form.thank_you }, `form:${form.id}`).catch((e) => this.logger.warn(`form thank-you: ${String(e)}`));
    }
    return { ok: true, thank_you: form.thank_you };
  }

  /** Validates one answer. chat = typed in the chat (numbers pick choices, "skip" skips). */
  checkAnswer(field: FormField, raw: string | string[], fromLink = false, inChat = false): { value?: unknown; error?: string } {
    const text = Array.isArray(raw) ? '' : clean(raw, 3000);
    const empty = Array.isArray(raw) ? raw.length === 0 : !text || (inChat && /^(skip|-)$/i.test(text));
    if (empty) return field.required ? { error: inChat ? 'This one is needed – please answer it.' : 'Required.' } : { value: undefined };
    switch (field.type) {
      case 'phone': {
        const digits = text.replace(/[^\d+]/g, '');
        let d = digits.replace(/^\+/, '');
        if (/^0\d{9}$/.test(d)) d = `94${d.slice(1)}`;
        if (!/^\d{9,15}$/.test(d)) return { error: 'Please send a valid phone number, e.g. 077 123 4567.' };
        return { value: `+${d}` };
      }
      case 'email':
        return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(text) ? { value: text.toLowerCase() } : { error: 'Please send a valid email address.' };
      case 'number': {
        const n = Number(text.replace(/,/g, ''));
        return Number.isFinite(n) ? { value: n } : { error: 'Please send a number.' };
      }
      case 'choice': {
        const options = field.options ?? [];
        const byNumber = /^\d+$/.test(text) ? options[Number(text) - 1] : undefined;
        const match = byNumber ?? options.find((o) => norm(o) === norm(text)) ?? options.find((o) => norm(text).includes(norm(o)) && norm(o).length > 1);
        return match ? { value: match } : { error: `Please choose one: ${options.join(', ')}.` };
      }
      case 'multi': {
        const options = field.options ?? [];
        const parts = Array.isArray(raw) ? raw : text.split(/[,;\n]+|\s+and\s+/i);
        const picked = [...new Set(parts.map((p) => clean(p, 100)).map((p) => (/^\d+$/.test(p) ? options[Number(p) - 1] : options.find((o) => norm(o) === norm(p)))).filter((p): p is string => Boolean(p)))];
        if (!picked.length) return { error: `Please choose from: ${options.join(', ')} (you can send several, e.g. 1,3).` };
        return { value: picked };
      }
      case 'photo':
        if (fromLink) return isChatMediaKey(text) ? { value: text } : { error: 'Please add a photo.' };
        return { value: text };
      default:
        return { value: text };
    }
  }

  private async saveSubmission(form: Record<string, any>, answers: Record<string, unknown>, meta: { source: 'chat' | 'link'; ip?: string; channelUserId: number | null; conversationId: number | null; channel: string | null }) {
    const companyId = Number(form.company_id);
    const [row] = await this.dataSource.query(`
      INSERT INTO chat_form_submission (form_id, company_id, bot_channel_user_id, conversation_id, channel, source, answers, ip)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING id`,
      [form.id, companyId, meta.channelUserId, meta.conversationId, meta.channel, meta.source, JSON.stringify(answers), meta.ip ?? null]);
    const fields = form.fields as FormField[];
    const pick = (to: string) => { const f = fields.find((x) => x.maps_to === to); return f ? answers[f.id] : undefined; };
    const summary = fields.filter((f) => answers[f.id] !== undefined).map((f) => `${f.label}: ${Array.isArray(answers[f.id]) ? (answers[f.id] as string[]).join(', ') : f.type === 'photo' ? '[photo]' : String(answers[f.id])}`).join('\n');
    if (meta.channelUserId) {
      const phone = pick('phone'); const email = pick('email'); const name = pick('name');
      await this.dataSource.query(`
        INSERT INTO crm_contact (bot_channel_user_id, company_id, tags, stage, phone, email, source, updated_at)
        VALUES ($1, $2, $3::text[], $4, $5, $6, 'form', NOW())
        ON CONFLICT (bot_channel_user_id) DO UPDATE SET
          tags = ARRAY(SELECT DISTINCT unnest(COALESCE(crm_contact.tags, '{}') || EXCLUDED.tags)),
          stage = COALESCE(EXCLUDED.stage, crm_contact.stage),
          phone = COALESCE(EXCLUDED.phone, crm_contact.phone), email = COALESCE(EXCLUDED.email, crm_contact.email), updated_at = NOW()`,
        [meta.channelUserId, companyId, form.add_tags ?? [], form.set_stage ?? null, phone ? String(phone) : null, email ? String(email) : null]);
      if (name) await this.dataSource.query(`UPDATE bot_channel_user SET display_name = $2 WHERE id = $1 AND (display_name IS NULL OR display_name = '' OR display_name ~ '^[0-9+ ]+$')`, [meta.channelUserId, clean(name, 100)]);
      await this.dataSource.query(`INSERT INTO bot_customer_note (company_id, bot_channel_user_id, content, created_by_name, created_at) VALUES ($1,$2,$3,'Form',NOW())`,
        [companyId, meta.channelUserId, `📝 ${form.name}\n${summary}`.slice(0, 4000)]);
    }
    if (meta.conversationId) {
      await this.dataSource.query(`UPDATE bot_conversation SET lead_details = COALESCE(lead_details, '{}'::jsonb) || jsonb_build_object($2::text, $3::jsonb) WHERE id = $1`,
        [meta.conversationId, `form: ${form.name}`, JSON.stringify(Object.fromEntries(fields.filter((f) => answers[f.id] !== undefined && f.type !== 'photo').map((f) => [f.label, answers[f.id]])))]);
    }
    if (form.notify) {
      await this.dataSource.query(`INSERT INTO bot_notification (company_id, kind, priority, title, message, conversation_id) VALUES ($1, 'form', 'NORMAL', $2, $3, $4)`,
        [companyId, `New answer: ${form.name}`.slice(0, 200), summary.slice(0, 900), meta.conversationId]).catch(() => undefined);
      this.pusherService.trigger(`company-${companyId}`, 'notification', { kind: 'form', form_id: form.id });
    }
    return Number(row.id);
  }

  /* ═══════════════ flows: CRUD ═══════════════ */

  private async validateFlow(companyId: number, input: FlowInput): Promise<Required<Omit<FlowInput, 'description'>> & { description: string }> {
    const name = clean(input.name, 255);
    if (!name) throw new BadRequestException('Give the flow a name.');
    if (!TRIGGERS.includes(input.trigger_type)) throw new BadRequestException('Choose what starts the flow.');
    const c = input.trigger_config ?? {};
    const keywords = [...new Set((c.keywords ?? []).map((k) => clean(k, 60)).filter(Boolean))].slice(0, 30);
    if (input.trigger_type === 'keyword' && !keywords.length) throw new BadRequestException('Add at least one keyword.');
    if (input.trigger_type === 'comment' && !keywords.length && !(c.post_ids ?? []).length) {
      throw new BadRequestException('Add a keyword or choose the posts – otherwise every comment would get a message.');
    }
    const trigger_config: TriggerConfig = {
      keywords, match: ['contains', 'exact', 'starts'].includes(String(c.match)) ? c.match : 'contains',
      any_ad: c.any_ad ?? !((c.campaign_ids ?? []).length || (c.ad_ids ?? []).length),
      campaign_ids: (c.campaign_ids ?? []).map((x) => clean(x, 40)).filter((x) => /^\d+$/.test(x)).slice(0, 50),
      ad_ids: (c.ad_ids ?? []).map((x) => clean(x, 40)).filter((x) => /^\d+$/.test(x)).slice(0, 50),
      post_ids: (c.post_ids ?? []).map((x) => clean(x, 80)).filter(Boolean).slice(0, 50),
      comment_reply: clean(c.comment_reply, 500),
      comment_platforms: (c.comment_platforms ?? ['facebook', 'instagram']).filter((p) => p === 'facebook' || p === 'instagram'),
      gap_days: Math.min(Math.max(Number(c.gap_days) || 0, 0), 365),
      once_per_contact: c.once_per_contact ?? input.trigger_type !== 'keyword',
    };
    const channels = [...new Set((input.channels ?? ['whatsapp', 'messenger', 'instagram']).filter((p) => ['whatsapp', 'messenger', 'instagram'].includes(p)))] as Platform[];
    if (!channels.length) throw new BadRequestException('Choose at least one channel.');
    const steps = (input.steps ?? []).slice(0, MAX_STEPS);
    if (!steps.length) throw new BadRequestException('Add at least one step.');
    const formIds = new Set<number>(
      (await this.dataSource.query(`SELECT id FROM chat_form WHERE company_id = $1`, [companyId])).map((r: { id: number }) => Number(r.id)));
    const out: Step[] = steps.map((s, index) => {
      const at = `Step ${index + 1}`;
      const id = clean(s.id, 40) || `s${index + 1}`;
      switch (s.type) {
        case 'text': {
          const text = clean(s.text, 4000);
          if (!text) throw new BadRequestException(`${at}: write the message.`);
          return { id, type: 'text', text };
        }
        case 'image': case 'video': {
          const key = s.media_key && isChatMediaKey(s.media_key) ? s.media_key : undefined;
          const url = !key && /^https:\/\//.test(clean(s.url)) ? clean(s.url) : undefined;
          if (!key && !url) throw new BadRequestException(`${at}: add the ${s.type}.`);
          return { id, type: s.type, ...(key ? { media_key: key } : { url }), caption: clean(s.caption, 1000) };
        }
        case 'buttons': {
          const text = clean(s.text, 1000);
          const buttons = (s.buttons ?? []).map((b) => ({ label: clean(b.label, 20), goto: b.goto == null || b.goto === -1 ? (b.goto ?? null) : Math.trunc(Number(b.goto)), tag: clean(b.tag, 40).toLowerCase() }))
            .filter((b) => b.label).slice(0, 10);
          if (!text) throw new BadRequestException(`${at}: write the question above the buttons.`);
          if (buttons.length < 2) throw new BadRequestException(`${at}: add at least 2 buttons.`);
          for (const b of buttons) if (b.goto != null && b.goto !== -1 && (b.goto < 0 || b.goto >= steps.length)) throw new BadRequestException(`${at}: button “${b.label}” goes to a step that does not exist.`);
          return { id, type: 'buttons', text, buttons, save_as: clean(s.save_as, 40) };
        }
        case 'form': {
          if (!s.form_id || !formIds.has(Number(s.form_id))) throw new BadRequestException(`${at}: choose a form.`);
          return { id, type: 'form', form_id: Number(s.form_id), form_mode: s.form_mode === 'link' ? 'link' : 'chat', text: clean(s.text, 1000) };
        }
        case 'delay': {
          const seconds = Math.trunc(Number(s.seconds));
          if (!(seconds >= 1 && seconds <= 7 * 86400)) throw new BadRequestException(`${at}: wait between 1 second and 7 days.`);
          return { id, type: 'delay', seconds };
        }
        case 'tag': {
          const tags = [...new Set((s.tags ?? []).map((t) => clean(t, 40).toLowerCase()).filter(Boolean))].slice(0, 10);
          if (!tags.length) throw new BadRequestException(`${at}: add a tag.`);
          return { id, type: 'tag', tags };
        }
        case 'stage':
          if (!STAGES.includes(String(s.stage))) throw new BadRequestException(`${at}: choose a stage.`);
          return { id, type: 'stage', stage: s.stage };
        case 'handoff':
          return { id, type: 'handoff', to: s.to === 'human' ? 'human' : 'ai', text: clean(s.text, 1000) };
        default:
          throw new BadRequestException(`${at}: unknown step.`);
      }
    });
    return {
      name, description: clean(input.description, 1000), status: input.status && ['active', 'paused', 'draft'].includes(input.status) ? input.status : 'draft',
      trigger_type: input.trigger_type, trigger_config, channels, steps: out, priority: Math.trunc(Number(input.priority) || 0),
    };
  }

  async flows(user: AuthenticatedUser) {
    const companyId = await this.adminCompany(user);
    const rows = await this.dataSource.query(`
      SELECT f.id, f.name, f.description, f.status, f.trigger_type, f.trigger_config, f.channels, f.steps, f.priority, f.runs, f.completed, f.last_run_at, f.updated_at,
             (SELECT COUNT(*) FROM automation_run r WHERE r.flow_id = f.id AND r.status IN ('waiting', 'delayed', 'running'))::int AS active_runs
        FROM automation_flow f WHERE f.company_id = $1 ORDER BY f.status = 'active' DESC, f.priority DESC, f.updated_at DESC`, [companyId]);
    return rows.map((r: Record<string, unknown>) => ({ ...r, steps: this.withPreview(r.steps as Step[]) }));
  }

  async flow(user: AuthenticatedUser, id: number) {
    const companyId = await this.adminCompany(user);
    const row = await this.ownFlow(companyId, id);
    return { ...row, steps: this.withPreview(row.steps) };
  }

  private withPreview(steps: Step[]) {
    return (steps ?? []).map((s) => (s.media_key ? { ...s, preview_url: publicChatMediaUrl(s.media_key, 24 * 3600) } : s));
  }

  private async ownFlow(companyId: number, id: number) {
    const [row] = await this.dataSource.query(`SELECT * FROM automation_flow WHERE id = $1 AND company_id = $2`, [id, companyId]);
    if (!row) throw new NotFoundException('Flow not found.');
    return row;
  }

  async createFlow(user: AuthenticatedUser, input: FlowInput) {
    const companyId = await this.adminCompany(user);
    const f = await this.validateFlow(companyId, input);
    const [row] = await this.dataSource.query(`
      INSERT INTO automation_flow (company_id, name, description, status, trigger_type, trigger_config, channels, steps, priority, definition, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb,$9,'{}'::jsonb,NOW(),NOW()) RETURNING id`,
      [companyId, f.name, f.description, f.status, f.trigger_type, JSON.stringify(f.trigger_config), f.channels, JSON.stringify(f.steps), f.priority]);
    return this.flow(user, Number(row.id));
  }

  async updateFlow(user: AuthenticatedUser, id: number, input: FlowInput) {
    const companyId = await this.adminCompany(user);
    await this.ownFlow(companyId, id);
    const f = await this.validateFlow(companyId, input);
    await this.dataSource.query(`
      UPDATE automation_flow SET name=$3, description=$4, status=$5, trigger_type=$6, trigger_config=$7::jsonb, channels=$8, steps=$9::jsonb, priority=$10, updated_at=NOW()
       WHERE id=$1 AND company_id=$2`,
      [id, companyId, f.name, f.description, f.status, f.trigger_type, JSON.stringify(f.trigger_config), f.channels, JSON.stringify(f.steps), f.priority]);
    // runs waiting on a changed flow continue from where they are; finished steps are not repeated
    return this.flow(user, id);
  }

  async setFlowStatus(user: AuthenticatedUser, id: number, status: 'active' | 'paused') {
    const companyId = await this.adminCompany(user);
    await this.ownFlow(companyId, id);
    await this.dataSource.query(`UPDATE automation_flow SET status = $3, updated_at = NOW() WHERE id = $1 AND company_id = $2`, [id, companyId, status]);
    if (status === 'paused') await this.dataSource.query(`UPDATE automation_run SET status = 'stopped', updated_at = NOW() WHERE flow_id = $1 AND status IN ('waiting', 'delayed', 'running')`, [id]);
    return this.flow(user, id);
  }

  async deleteFlow(user: AuthenticatedUser, id: number) {
    const companyId = await this.adminCompany(user);
    await this.ownFlow(companyId, id);
    await this.dataSource.query(`DELETE FROM automation_flow WHERE id = $1 AND company_id = $2`, [id, companyId]);
    return { deleted: true };
  }

  async uploadMedia(user: AuthenticatedUser, file?: { buffer: Buffer; mimetype: string; originalname: string }) {
    const companyId = await this.adminCompany(user);
    if (!file?.buffer?.length) throw new BadRequestException('Choose a file.');
    const image = /^image\/(jpeg|png)$/.test(file.mimetype);
    const video = /^video\/(mp4|3gpp)$/.test(file.mimetype);
    if (!image && !video) throw new BadRequestException('Use a JPG / PNG photo or an MP4 video (what WhatsApp, Messenger and Instagram accept).');
    if (image && file.buffer.length > 5 * 1024 * 1024) throw new BadRequestException('Photos can be up to 5 MB on WhatsApp.');
    if (video && file.buffer.length > 16 * 1024 * 1024) throw new BadRequestException('Videos can be up to 16 MB on WhatsApp.');
    const key = saveChatMedia(companyId, file.buffer, file.mimetype, file.originalname || (image ? 'photo.jpg' : 'video.mp4'));
    const url = publicChatMediaUrl(key, 24 * 3600);
    if (!url) throw new BadRequestException('PUBLIC_API_BASE_URL is not set on the server – Meta cannot download the file.');
    return { media_key: key, preview_url: url, type: image ? 'image' : 'video' };
  }

  /** Sends the flow to the admin's own test: runs it for one conversation now (ignores the trigger). */
  async testRun(user: AuthenticatedUser, id: number, conversationId: number) {
    const companyId = await this.adminCompany(user);
    const flow = await this.ownFlow(companyId, id);
    const target = await this.sender.target(conversationId);
    if (!target || target.companyId !== companyId) throw new NotFoundException('Chat not found.');
    await this.dataSource.query(`UPDATE automation_run SET status = 'stopped', updated_at = NOW() WHERE conversation_id = $1 AND status IN ('waiting', 'delayed', 'running')`, [conversationId]);
    const run = await this.startRun(flow, target);
    await this.execute(run, target);
    return { started: true, run_id: run.id };
  }

  async runs(user: AuthenticatedUser, id: number) {
    const companyId = await this.adminCompany(user);
    await this.ownFlow(companyId, id);
    return this.dataSource.query(`
      SELECT r.id, r.status, r.step_index, r.platform, r.conversation_id, r.created_at, r.updated_at, cu.display_name, cu.external_user_id
        FROM automation_run r LEFT JOIN bot_channel_user cu ON cu.id = r.bot_channel_user_id
       WHERE r.flow_id = $1 ORDER BY r.created_at DESC LIMIT 200`, [id]);
  }

  /* ═══════════════ engine ═══════════════ */

  /** Inbound customer message: answer a waiting flow, or start a matching flow. true = handled (AI stays quiet). */
  async inbound(event: FlowInboundEvent): Promise<boolean> {
    const text = clean(event.text, 2000);
    const target = await this.sender.target(event.conversationId);
    if (!target) return false;
    const [running] = await this.dataSource.query(`
      SELECT * FROM automation_run WHERE conversation_id = $1 AND status = 'waiting' ORDER BY id DESC LIMIT 1`, [event.conversationId]);
    if (running) {
      if (STOP_WORDS.test(text)) {
        await this.finish(running, 'stopped');
        await this.sender.send(target, { kind: 'text', text: 'OK, stopped. How can we help you?' }, `flow:${running.flow_id}`).catch(() => undefined);
        return true;
      }
      return this.answer(running as Run, target, text);
    }
    // a tap on a button that a comment flow sent as a private reply → continue that flow here in the chat
    const tap = /^cf(\d+)_(\d+)_b(\d+)$/.exec(String(event.payload ?? ''));
    if (tap) {
      const [flow] = await this.dataSource.query(`SELECT * FROM automation_flow WHERE id = $1 AND company_id = $2 AND status = 'active' AND trigger_type = 'comment'`, [Number(tap[1]), event.companyId]);
      const step = (flow?.steps as Step[] | undefined)?.[Number(tap[2])];
      if (flow && step?.type === 'buttons' && step.buttons?.[Number(tap[3])]) {
        const run = await this.startRun(flow, target, false);
        await this.save(run, { status: 'waiting', step_index: Number(tap[2]), waiting: { kind: 'buttons', step: Number(tap[2]), attempts: 0 } });
        return this.answer(run, target, String(Number(tap[3]) + 1));
      }
    }
    const flows = await this.dataSource.query(`
      SELECT * FROM automation_flow WHERE company_id = $1 AND status = 'active' AND $2 = ANY(channels) AND trigger_type IN ('first_message','keyword','ad')
       ORDER BY CASE trigger_type WHEN 'ad' THEN 0 WHEN 'keyword' THEN 1 ELSE 2 END, priority DESC, id`, [event.companyId, event.platform]);
    if (!flows.length) return false;
    for (const flow of flows) {
      if (!(await this.matches(flow, event, target, text))) continue;
      const run = await this.startRun(flow, target);
      await this.execute(run, target);
      return true;
    }
    return false;
  }

  private async matches(flow: Record<string, any>, event: FlowInboundEvent, target: Target, text: string): Promise<boolean> {
    const c = (flow.trigger_config ?? {}) as TriggerConfig;
    if (c.once_per_contact) {
      const [done] = await this.dataSource.query(`SELECT 1 FROM automation_run WHERE flow_id = $1 AND bot_channel_user_id = $2 LIMIT 1`, [flow.id, target.channelUserId]);
      if (done) return false;
    }
    if (flow.trigger_type === 'keyword') return keywordMatch(c, text);
    if (flow.trigger_type === 'ad') {
      if (!event.adId) return false;
      if (c.any_ad || (!(c.campaign_ids ?? []).length && !(c.ad_ids ?? []).length)) return true;
      if ((c.ad_ids ?? []).includes(event.adId)) return true;
      if ((c.campaign_ids ?? []).length) {
        const campaign = await this.campaignOfAd(event.companyId, event.adId);
        return Boolean(campaign && c.campaign_ids!.includes(campaign));
      }
      return false;
    }
    if (flow.trigger_type === 'first_message') {
      const [counts] = await this.dataSource.query(`
        SELECT COUNT(*) FILTER (WHERE m.direction::text = 'inbound')::int AS inbound,
               MAX(m.created_at) FILTER (WHERE m.direction::text = 'inbound' AND m.created_at < NOW() - INTERVAL '5 seconds') AS previous
          FROM bot_message m JOIN bot_conversation c ON c.id = m.conversation_id WHERE c.bot_channel_user_id = $1`, [target.channelUserId]);
      if (Number(counts?.inbound) <= 1) return true;
      const gap = Number(c.gap_days) || 0;
      return gap > 0 && counts?.previous && Date.now() - new Date(counts.previous).getTime() > gap * 86400_000;
    }
    return false;
  }

  /** ad id → Meta campaign id (from the cache the marketing module fills, else asked once from Meta) */
  private async campaignOfAd(companyId: number, adId: string): Promise<string | null> {
    const [cached] = await this.dataSource.query(`SELECT campaign_id FROM marketing_ad_cache WHERE ad_id = $1`, [adId]);
    if (cached?.campaign_id) return String(cached.campaign_id);
    const [settings] = await this.dataSource.query(`SELECT meta_user_token FROM marketing_settings WHERE company_id = $1`, [companyId]).catch(() => [null]);
    if (!settings?.meta_user_token) return null;
    const ad = await graphRequest<{ campaign?: { id: string; name: string }; name?: string }>('GET', `/${adId}`, settings.meta_user_token, { fields: 'name,campaign{id,name}' }).catch(() => null);
    if (!ad?.campaign?.id) return null;
    await this.dataSource.query(`
      INSERT INTO marketing_ad_cache (ad_id, ad_name, campaign_id, campaign_name, company_id) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (ad_id) DO UPDATE SET campaign_id = EXCLUDED.campaign_id, campaign_name = EXCLUDED.campaign_name`,
      [adId, ad.name ?? null, ad.campaign.id, ad.campaign.name, companyId]).catch(() => undefined);
    return ad.campaign.id;
  }

  private async startRun(flow: Record<string, any>, target: Target, count = true): Promise<Run> {
    await this.dataSource.query(`UPDATE automation_run SET status = 'replaced', updated_at = NOW() WHERE conversation_id = $1 AND status IN ('waiting', 'delayed', 'running')`, [target.conversationId]);
    const [run] = await this.dataSource.query(`
      INSERT INTO automation_run (flow_id, company_id, conversation_id, bot_channel_user_id, platform, status, step_index)
      VALUES ($1,$2,$3,$4,$5,'running',0) RETURNING *`, [flow.id, target.companyId, target.conversationId, target.channelUserId, target.platform]);
    if (count) await this.dataSource.query(`UPDATE automation_flow SET runs = runs + 1, last_run_at = NOW() WHERE id = $1`, [flow.id]);
    return run as Run;
  }

  private async finish(run: Pick<Run, 'id' | 'flow_id'>, status: 'done' | 'stopped' | 'failed' | 'handed_off') {
    await this.dataSource.query(`UPDATE automation_run SET status = $2, waiting = NULL, updated_at = NOW() WHERE id = $1`, [run.id, status]);
    if (status === 'done' || status === 'handed_off') await this.dataSource.query(`UPDATE automation_flow SET completed = completed + 1 WHERE id = $1`, [run.flow_id]);
  }

  private async save(run: Run, patch: { status?: string; step_index?: number; waiting?: Waiting | null; resume_at?: Date | null; vars?: Record<string, unknown> }) {
    Object.assign(run, patch);
    await this.dataSource.query(`
      UPDATE automation_run SET status = $2, step_index = $3, waiting = $4::jsonb, resume_at = $5, vars = $6::jsonb, updated_at = NOW() WHERE id = $1`,
      [run.id, run.status, run.step_index, run.waiting ? JSON.stringify(run.waiting) : null, patch.resume_at ?? null, JSON.stringify(run.vars ?? {})]);
  }

  private fill(text: string, target: Target, vars: Record<string, unknown>) {
    // answers saved in the flow win; then the contact's own name / phone
    const builtin: Record<string, string> = { name: target.name || '', phone: target.platform === 'whatsapp' ? `+${target.recipient}` : '' };
    return text
      .replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_m, key: string) => (vars[key] != null && vars[key] !== '' ? String(vars[key]) : builtin[key.toLowerCase()] ?? ''))
      .replace(/[ \t]+\n/g, '\n').trim();
  }

  /** Runs steps from run.step_index until the flow waits (buttons, question, delay) or ends. */
  private async execute(run: Run, target: Target): Promise<void> {
    const [flow] = await this.dataSource.query(`SELECT id, name, steps, status FROM automation_flow WHERE id = $1`, [run.flow_id]);
    if (!flow) return void (await this.finish(run, 'stopped'));
    const steps = (flow.steps ?? []) as Step[];
    const source = `flow:${flow.id}`;
    let guard = 0;
    try {
      while (run.step_index < steps.length) {
        if (++guard > MAX_STEPS * 2) throw new Error('the flow loops – check the button jumps');
        const step = steps[run.step_index];
        const vars = run.vars ?? {};
        switch (step.type) {
          case 'text':
            await this.sender.send(target, { kind: 'text', text: this.fill(step.text ?? '', target, vars) }, source);
            break;
          case 'image': case 'video': {
            const url = step.media_key ? publicChatMediaUrl(step.media_key, 7 * 24 * 3600) : step.url;
            if (!url) throw new Error('PUBLIC_API_BASE_URL is not set – the file cannot be sent');
            await this.sender.send(target, { kind: step.type, url, caption: step.caption ? this.fill(step.caption, target, vars) : undefined }, source);
            break;
          }
          case 'buttons':
            await this.sender.send(target, this.buttonsMessage(target, this.fill(step.text ?? '', target, vars), (step.buttons ?? []).map((b) => b.label)), source);
            await this.save(run, { status: 'waiting', waiting: { kind: 'buttons', step: run.step_index, attempts: 0 } });
            return;
          case 'form': {
            const [form] = await this.dataSource.query(`SELECT * FROM chat_form WHERE id = $1 AND company_id = $2`, [step.form_id, target.companyId]);
            if (!form || !form.active) break; // a removed / switched-off form is skipped
            if (step.form_mode === 'link') {
              const token = randomBytes(12).toString('base64url');
              await this.dataSource.query(`INSERT INTO chat_form_invite (token, form_id, company_id, bot_channel_user_id, conversation_id, channel) VALUES ($1,$2,$3,$4,$5,$6)`,
                [token, form.id, target.companyId, target.channelUserId, target.conversationId, target.platform]);
              const base = String(process.env.APP_PUBLIC_URL ?? '').replace(/\/+$/, '');
              const intro = this.fill(step.text || form.intro || `Please fill in this short form: ${form.title}`, target, vars);
              await this.sender.send(target, { kind: 'text', text: `${intro}\n${base}/f/${form.slug}?t=${token}` }, source);
              break;
            }
            // one clean message: the intro, what is coming, and the first question
            const intro = this.fill(step.text || form.intro || '', target, vars);
            const suggest = await this.askField(form, 0, target, source, { intro });
            await this.save(run, { status: 'waiting', waiting: { kind: 'question', step: run.step_index, form_id: form.id, field: 0, answers: {}, attempts: 0, suggest } });
            return;
          }
          case 'delay':
            await this.save(run, { status: 'delayed', step_index: run.step_index + 1, waiting: null, resume_at: new Date(Date.now() + (step.seconds ?? 1) * 1000) });
            return;
          case 'tag':
            await this.addTags(target, step.tags ?? []);
            break;
          case 'stage':
            await this.dataSource.query(`
              INSERT INTO crm_contact (bot_channel_user_id, company_id, stage, updated_at) VALUES ($1,$2,$3,NOW())
              ON CONFLICT (bot_channel_user_id) DO UPDATE SET stage = EXCLUDED.stage, updated_at = NOW()`, [target.channelUserId, target.companyId, step.stage]);
            await this.dataSource.query(`UPDATE bot_conversation SET lead_stage = $2 WHERE id = $1`, [target.conversationId, step.stage]).catch(() => undefined);
            break;
          case 'handoff':
            if (step.text) await this.sender.send(target, { kind: 'text', text: this.fill(step.text, target, vars) }, source);
            if (step.to === 'human') {
              await this.dataSource.query(`UPDATE bot_channel_user SET bot_enabled = false, manual_mode = true WHERE id = $1`, [target.channelUserId]);
              await this.dataSource.query(`UPDATE bot_conversation SET queue_reason = 'bot_handoff', queue_note = $2 WHERE id = $1`, [target.conversationId, `Flow “${flow.name}” asked for a person.`]);
              await this.dataSource.query(`INSERT INTO bot_notification (company_id, kind, priority, title, message, conversation_id) VALUES ($1,'handoff','HIGH',$2,$3,$4)`,
                [target.companyId, `Customer needs a person – ${target.name || target.recipient}`.slice(0, 200), `Flow “${flow.name}” handed the chat to the team.`, target.conversationId]).catch(() => undefined);
              this.pusherService.trigger(`company-${target.companyId}`, 'conversation_updated', { conversation_id: target.conversationId, handoff: 'flow' });
            }
            await this.finish(run, 'handed_off');
            return;
        }
        run.step_index += 1;
        await this.save(run, { status: 'running', waiting: null });
      }
      await this.finish(run, 'done');
    } catch (error) {
      this.logger.warn(`flow ${run.flow_id} run ${run.id} failed at step ${run.step_index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      await this.finish(run, 'failed');
    }
  }

  private buttonsMessage(target: Target, text: string, labels: string[]): Outgoing {
    return { kind: 'buttons', text, buttons: labels };
  }

  /**
   * Asks one form question in the chat: "2/4 · Your address?" with a short hint. Choices and things we already know
   * (the customer's name, their WhatsApp number) become tap buttons. The first question also carries the intro.
   * Returns the tap suggestions (so "1" / "2" also works where buttons are shown as a numbered list).
   */
  private async askField(form: Record<string, any>, index: number, target: Target, source: string, opts: { intro?: string; error?: string } = {}): Promise<string[]> {
    const fields = form.fields as FormField[];
    const field = fields[index];
    const wa = target.platform === 'whatsapp';
    const bold = (text: string) => (wa ? `*${text}*` : text);
    const italic = (text: string) => (wa ? `_${text}_` : text);
    const lines: string[] = [];
    if (opts.error) lines.push(`⚠️ ${opts.error}`, '');
    if (index === 0 && !opts.error) {
      if (opts.intro) lines.push(opts.intro, '');
      lines.push(`📝 ${bold(form.title || form.name)}${fields.length > 1 ? ` – ${fields.length} quick questions` : ''}. Send ${bold('stop')} any time to cancel.`, '');
    }
    const label = /[?:.!]$/.test(field.label.trim()) ? field.label.trim() : `${field.label.trim()}?`;
    lines.push(`${fields.length > 1 ? `${bold(`${index + 1}/${fields.length}`)} ` : ''}${label}`);

    let suggest: string[] = [];
    let hint = '';
    if ((field.type === 'choice' || field.type === 'multi') && field.options?.length) {
      if (field.type === 'multi') hint = 'You can pick several – e.g. 1,3';
      suggest = field.options;
    } else if (field.maps_to === 'name' || (field.type === 'text' && /name|නම/i.test(field.label))) {
      const known = String(target.name ?? '').trim();
      if (/\p{L}{2,}/u.test(known) && known.length <= 20) { suggest = [known]; hint = 'Tap your name or type it'; }
    } else if (field.type === 'phone') {
      const digits = String(target.recipient ?? '').replace(/\D/g, '');
      if (wa && /^94\d{9}$/.test(digits)) { suggest = [`0${digits.slice(2)}`]; hint = 'Tap to use this WhatsApp number, or type another'; }
      else hint = 'e.g. 077 123 4567';
    } else if (field.type === 'photo') hint = 'Send a photo';
    else if (field.type === 'date') hint = 'e.g. 25 Dec';
    else if (field.type === 'email') hint = 'e.g. name@gmail.com';
    if (!field.required) hint = hint ? `${hint} · or send “skip”` : 'Optional – send “skip” to leave it out';
    if (hint) lines.push(italic(hint));
    const text = lines.join('\n');

    const canButtons = suggest.length > 0 && field.type !== 'multi' && suggest.length <= (wa ? 10 : 13);
    if (canButtons) await this.sender.send(target, { kind: 'buttons', text, buttons: suggest.map((s) => s.slice(0, 20)) }, source);
    else if (suggest.length) await this.sender.send(target, { kind: 'text', text: `${text}\n\n${suggest.map((s, i) => `${i + 1}. ${s}`).join('\n')}` }, source);
    else await this.sender.send(target, { kind: 'text', text }, source);
    return suggest;
  }

  /** The customer answered while the flow waits. */
  private async answer(run: Run, target: Target, text: string): Promise<boolean> {
    const [flow] = await this.dataSource.query(`SELECT id, steps, status FROM automation_flow WHERE id = $1`, [run.flow_id]);
    if (!flow || flow.status !== 'active' || !run.waiting) { await this.finish(run, 'stopped'); return false; }
    const steps = flow.steps as Step[];
    const source = `flow:${flow.id}`;
    const waiting = run.waiting;
    if (waiting.kind === 'buttons') {
      const step = steps[waiting.step];
      const buttons = step?.buttons ?? [];
      const n = /^\d+$/.test(text) ? buttons[Number(text) - 1] : undefined;
      const chosen = n ?? buttons.find((b) => norm(b.label) === norm(text)) ?? buttons.find((b) => norm(text).includes(norm(b.label)) && norm(b.label).length > 2);
      if (!chosen) {
        if (waiting.attempts >= 1) { await this.finish(run, 'done'); return false; } // the customer asked something else → the AI answers
        await this.save(run, { waiting: { ...waiting, attempts: waiting.attempts + 1 } });
        await this.sender.send(target, this.buttonsMessage(target, 'Please choose one of these:', buttons.map((b) => b.label)), source);
        return true;
      }
      const vars = { ...(run.vars ?? {}), ...(step.save_as ? { [step.save_as]: chosen.label } : {}) };
      if (chosen.tag) await this.addTags(target, [chosen.tag]);
      if (chosen.goto === -1) { await this.save(run, { vars }); await this.finish(run, 'done'); return true; }
      await this.save(run, { status: 'running', waiting: null, vars, step_index: chosen.goto != null ? chosen.goto : waiting.step + 1 });
      await this.execute(run, target);
      return true;
    }
    // form question in the chat
    const [form] = await this.dataSource.query(`SELECT * FROM chat_form WHERE id = $1`, [waiting.form_id]);
    if (!form) { await this.finish(run, 'stopped'); return false; }
    const fields = form.fields as FormField[];
    const field = fields[waiting.field];
    let raw = text;
    if (field.type === 'photo') {
      const [last] = await this.dataSource.query(`
        SELECT media_url FROM bot_message WHERE conversation_id = $1 AND direction::text = 'inbound' AND message_type::text = 'image' AND created_at > NOW() - INTERVAL '2 minutes'
         ORDER BY id DESC LIMIT 1`, [target.conversationId]);
      raw = last?.media_url ?? (/^(skip|-)$/i.test(text) ? text : '');
      if (!raw && field.required) {
        await this.sender.send(target, { kind: 'text', text: 'Please send the photo.' }, source);
        return true;
      }
    }
    // "1" / "2" picks a suggestion (numbered list instead of buttons); a tapped button arrives as its text
    const suggestion = /^\d{1,2}$/.test(raw.trim()) && field.type !== 'number' && field.type !== 'multi' && field.type !== 'phone' ? waiting.suggest?.[Number(raw.trim()) - 1] : undefined;
    const result = this.checkAnswer(field, suggestion ?? raw, false, true);
    if (result.error) {
      if (waiting.attempts >= 2) { await this.finish(run, 'stopped'); await this.sender.send(target, { kind: 'text', text: 'No problem – a team member will help you with this.' }, source); return true; }
      await this.save(run, { waiting: { ...waiting, attempts: waiting.attempts + 1 } });
      await this.askField(form, waiting.field, target, source, { error: result.error });
      return true;
    }
    const answers = { ...waiting.answers, ...(result.value !== undefined ? { [field.id]: result.value } : {}) };
    const next = waiting.field + 1;
    if (next < fields.length) {
      const suggest = await this.askField(form, next, target, source);
      await this.save(run, { waiting: { ...waiting, field: next, answers, attempts: 0, suggest } });
      return true;
    }
    await this.saveSubmission(form, answers, { source: 'chat', channelUserId: target.channelUserId, conversationId: target.conversationId, channel: target.platform });
    await this.sender.send(target, { kind: 'text', text: formSummary(form, answers, target.platform === 'whatsapp') }, source);
    const vars = { ...(run.vars ?? {}), ...Object.fromEntries(fields.filter((f) => answers[f.id] !== undefined && f.type !== 'photo').map((f) => [f.id, Array.isArray(answers[f.id]) ? (answers[f.id] as string[]).join(', ') : answers[f.id]])) };
    await this.save(run, { status: 'running', waiting: null, vars, step_index: waiting.step + 1 });
    await this.execute(run, target);
    return true;
  }

  private async addTags(target: Target, tags: string[]) {
    if (!tags.length) return;
    await this.dataSource.query(`
      INSERT INTO crm_contact (bot_channel_user_id, company_id, tags, updated_at) VALUES ($1, $2, $3::text[], NOW())
      ON CONFLICT (bot_channel_user_id) DO UPDATE SET tags = ARRAY(SELECT DISTINCT unnest(COALESCE(crm_contact.tags, '{}') || EXCLUDED.tags)), updated_at = NOW()`,
      [target.channelUserId, target.companyId, tags]);
  }

  /** "Wait" steps: continue the runs whose time has come. */
  async resumeDelayed() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const due: Run[] = await this.dataSource.query(`
        UPDATE automation_run SET status = 'running', updated_at = NOW()
         WHERE id IN (SELECT id FROM automation_run WHERE status = 'delayed' AND resume_at <= NOW() ORDER BY resume_at LIMIT 50 FOR UPDATE SKIP LOCKED)
        RETURNING *`).then((r: unknown) => updatedRows<Run>(r));
      for (const run of due) {
        const target = await this.sender.target(run.conversation_id);
        if (!target) { await this.finish(run, 'stopped'); continue; }
        await this.execute(run, target);
      }
    } catch (error) {
      this.logger.warn(`delayed flows: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.ticking = false;
    }
  }

  /* ═══════════════ comment trigger ═══════════════ */

  /** A comment with a keyword on a post → private reply (DM) with the flow's first message, optional public reply. */
  async comment(event: FlowCommentEvent): Promise<boolean> {
    const text = clean(event.text, 2000);
    if (!text || !event.commentId) return false;
    const flows = await this.dataSource.query(`
      SELECT * FROM automation_flow WHERE company_id = $1 AND status = 'active' AND trigger_type = 'comment' ORDER BY priority DESC, id`, [event.companyId]);
    const [page] = await this.dataSource.query(`
      SELECT page_id, page_access_token, instagram_business_account_id FROM meta_page_connections WHERE company_id = $1 AND status = 'CONNECTED' ORDER BY updated_at DESC LIMIT 1`, [event.companyId]);
    if (!flows.length || !page?.page_access_token) return false;
    // never react to the Page's own comments
    if (event.authorId && (event.authorId === page.page_id || event.authorId === page.instagram_business_account_id)) return false;
    for (const flow of flows) {
      const c = (flow.trigger_config ?? {}) as TriggerConfig;
      if (!(c.comment_platforms ?? ['facebook', 'instagram']).includes(event.platform)) continue;
      if ((c.post_ids ?? []).length && !(event.postId && c.post_ids!.some((id) => event.postId === id || event.postId!.endsWith(`_${id}`)))) continue;
      if ((c.keywords ?? []).length && !keywordMatch(c, text)) continue;
      const [claimed] = await this.dataSource.query(
        `INSERT INTO automation_comment_reply (comment_id, flow_id, company_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING comment_id`, [event.commentId, flow.id, event.companyId]);
      if (!claimed) return true;
      const steps = (flow.steps ?? []) as Step[];
      const firstIndex = steps.findIndex((s) => s.type === 'text' || s.type === 'buttons');
      const first = steps[firstIndex];
      const name = event.authorName ?? '';
      // button taps carry the flow + step, so the flow can go on in the chat (see inbound)
      const message = first?.type === 'buttons'
        ? { text: (first.text ?? '').replace(/\{\{\s*name\s*\}\}/gi, name).slice(0, 1000), quick_replies: (first.buttons ?? []).slice(0, 13).map((b, i) => ({ content_type: 'text', title: b.label.slice(0, 20), payload: `cf${flow.id}_${firstIndex}_b${i}` })) }
        : { text: (first?.text ?? 'Thanks for your comment! We sent you the details here.').replace(/\{\{\s*name\s*\}\}/gi, name).slice(0, 1900) };
      try {
        await graphRequest('POST', `/${page.page_id}/messages`, page.page_access_token, { recipient: { comment_id: event.commentId }, message });
        if (c.comment_reply) {
          await graphRequest('POST', event.platform === 'instagram' ? `/${event.commentId}/replies` : `/${event.commentId}/comments`, page.page_access_token,
            { message: c.comment_reply.replace(/\{\{\s*name\s*\}\}/gi, name) });
        }
        // with buttons the flow is finished later in the chat (counted when that run ends)
        await this.dataSource.query(`UPDATE automation_flow SET runs = runs + 1, completed = completed + $2, last_run_at = NOW() WHERE id = $1`, [flow.id, first?.type === 'buttons' ? 0 : 1]);
        await this.dataSource.query(`UPDATE social_comment SET status = 'replied', updated_at = NOW() WHERE comment_id = $1`, [event.commentId]).catch(() => undefined);
      } catch (error) {
        this.logger.warn(`comment flow ${flow.id}: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
      return true;
    }
    return false;
  }
}

/** "✅ Thank you…" + what the customer sent, one line per answer. */
export function formSummary(form: { thank_you?: string; fields: FormField[] }, answers: Record<string, unknown>, whatsapp = true) {
  const rows = (form.fields ?? []).filter((f) => answers[f.id] !== undefined && answers[f.id] !== '').map((f) => {
    const value = answers[f.id];
    const shown = f.type === 'photo' ? 'photo received' : Array.isArray(value) ? value.join(', ') : String(value);
    return `• ${f.label.replace(/[?:]\s*$/, '')}: ${shown}`;
  });
  const thanks = `✅ ${String(form.thank_you || 'Thank you! We received your details.').trim()}`;
  return rows.length ? `${thanks}\n\n${whatsapp ? '*Your details*' : 'Your details'}\n${rows.join('\n')}` : thanks;
}

export function keywordMatch(c: TriggerConfig, text: string) {
  const t = norm(text);
  if (!t) return false;
  return (c.keywords ?? []).some((k) => {
    const key = norm(k);
    if (!key) return false;
    if (c.match === 'exact') return t === key;
    if (c.match === 'starts') return t.startsWith(key);
    return ` ${t} `.includes(` ${key} `) || (key.length >= 4 && t.includes(key));
  });
}

/** TypeORM returns [rows, count] for UPDATE … RETURNING on Postgres, and plain rows for SELECT / INSERT. */
function updatedRows<T = Record<string, unknown>>(result: unknown): T[] {
  if (Array.isArray(result) && result.length === 2 && Array.isArray(result[0]) && typeof result[1] === 'number') return result[0] as T[];
  return (Array.isArray(result) ? result : []) as T[];
}
