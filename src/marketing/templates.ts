import { BadRequestException } from '@nestjs/common';

/**
 * WhatsApp message templates: what the admin fills in, and the "components" Meta expects.
 * Rules follow Meta's template guidelines so most mistakes are caught before Meta's review.
 */
export type TemplateButton = { type: 'QUICK_REPLY' | 'URL' | 'PHONE_NUMBER'; text: string; url?: string; phone_number?: string; url_example?: string };
export type TemplateInput = {
  name: string;
  language: string;
  category: 'MARKETING' | 'UTILITY';
  header_text?: string;
  header_example?: string;
  body: string;
  body_examples?: string[];
  footer?: string;
  buttons?: TemplateButton[];
};

const VARIABLE = /\{\{(\d+)\}\}/g;

function variablesIn(text: string): number[] {
  return [...text.matchAll(VARIABLE)].map((match) => Number(match[1]));
}

/** {{1}}, {{2}} … must start at 1 and have no gaps. Returns how many there are. */
function checkVariables(text: string, where: string): number {
  const found = variablesIn(text);
  const unique = [...new Set(found)].sort((a, b) => a - b);
  if (unique.some((value, index) => value !== index + 1)) {
    throw new BadRequestException(`${where}: number the variables in order – {{1}}, {{2}}, {{3}} …`);
  }
  return unique.length;
}

export function buildTemplateComponents(input: TemplateInput): Array<Record<string, unknown>> {
  if (!/^[a-z0-9_]{1,512}$/.test(input.name)) throw new BadRequestException('Template name: only small letters, numbers and _ (e.g. new_arrivals_may).');
  if (!['MARKETING', 'UTILITY'].includes(input.category)) throw new BadRequestException('Choose Marketing or Utility.');
  if (!/^[a-z]{2,3}(_[A-Z]{2})?$/.test(input.language)) throw new BadRequestException('Choose a language.');
  const components: Array<Record<string, unknown>> = [];

  const header = String(input.header_text ?? '').trim();
  if (header) {
    if (header.length > 60) throw new BadRequestException('Header: up to 60 characters.');
    const count = checkVariables(header, 'Header');
    if (count > 1) throw new BadRequestException('Header: only one variable ({{1}}) is allowed.');
    if (/[\n*_~]|[\u{1F300}-\u{1FAFF}]/u.test(header)) throw new BadRequestException('Header: no new lines, emoji or formatting (* _ ~).');
    const example = String(input.header_example ?? '').trim();
    if (count && !example) throw new BadRequestException('Header: add an example for {{1}}.');
    components.push({ type: 'HEADER', format: 'TEXT', text: header, ...(count ? { example: { header_text: [example] } } : {}) });
  }

  const body = String(input.body ?? '').trim();
  if (!body) throw new BadRequestException('Write the message.');
  if (body.length > 1024) throw new BadRequestException('Message: up to 1,024 characters.');
  const count = checkVariables(body, 'Message');
  if (count) {
    if (/^\{\{\d+\}\}/.test(body) || /\{\{\d+\}\}[.!?\s]*$/.test(body)) throw new BadRequestException('Message: it cannot start or end with a variable – add a word before / after it.');
    const words = body.replace(VARIABLE, ' ').split(/\s+/).filter(Boolean).length;
    if (words < count * 2 + 1) throw new BadRequestException('Message: too many variables for the length – add more text (Meta rejects these).');
    const examples = (input.body_examples ?? []).map((value) => String(value ?? '').trim());
    if (examples.length < count || examples.slice(0, count).some((value) => !value)) throw new BadRequestException(`Message: add an example value for each of the ${count} variable(s).`);
    components.push({ type: 'BODY', text: body, example: { body_text: [examples.slice(0, count)] } });
  } else {
    components.push({ type: 'BODY', text: body });
  }

  const footer = String(input.footer ?? '').trim();
  if (footer) {
    if (footer.length > 60) throw new BadRequestException('Footer: up to 60 characters.');
    if (variablesIn(footer).length) throw new BadRequestException('Footer: no variables.');
    components.push({ type: 'FOOTER', text: footer });
  }

  const buttons = input.buttons ?? [];
  if (buttons.length > 10) throw new BadRequestException('Up to 10 buttons.');
  if (buttons.filter((b) => b.type === 'URL').length > 2) throw new BadRequestException('Up to 2 website buttons.');
  if (buttons.filter((b) => b.type === 'PHONE_NUMBER').length > 1) throw new BadRequestException('Only 1 call button.');
  // Meta wants quick replies grouped together (not mixed between link / call buttons)
  const ordered = [...buttons.filter((b) => b.type === 'QUICK_REPLY'), ...buttons.filter((b) => b.type !== 'QUICK_REPLY')];
  const out = ordered.map((button) => {
    const text = String(button.text ?? '').trim();
    if (!text || text.length > 25) throw new BadRequestException('Button text: 1 to 25 characters.');
    if (button.type === 'QUICK_REPLY') return { type: 'QUICK_REPLY', text };
    if (button.type === 'URL') {
      const url = String(button.url ?? '').trim();
      if (!/^https?:\/\/[^\s]+$/.test(url) || url.length > 2000) throw new BadRequestException(`Button “${text}”: enter a full link (https://…).`);
      const dynamic = /\{\{1\}\}$/.test(url);
      if (variablesIn(url).length && !dynamic) throw new BadRequestException(`Button “${text}”: a variable can only be {{1}} at the end of the link.`);
      if (dynamic && !String(button.url_example ?? '').trim()) throw new BadRequestException(`Button “${text}”: add an example link.`);
      return { type: 'URL', text, url, ...(dynamic ? { example: [String(button.url_example).trim()] } : {}) };
    }
    if (button.type === 'PHONE_NUMBER') {
      const phone = String(button.phone_number ?? '').replace(/[^\d+]/g, '');
      if (!/^\+?\d{9,15}$/.test(phone)) throw new BadRequestException(`Button “${text}”: enter the phone number with country code (+94…).`);
      return { type: 'PHONE_NUMBER', text, phone_number: phone.startsWith('+') ? phone : `+${phone}` };
    }
    throw new BadRequestException('Unknown button type.');
  });
  if (out.length) components.push({ type: 'BUTTONS', buttons: out });
  return components;
}
