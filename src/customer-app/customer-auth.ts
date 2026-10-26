import { CanActivate, ExecutionContext, Injectable, UnauthorizedException, createParamDecorator } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { DataSource } from 'typeorm';

/**
 * Customer-app login tokens. They are NOT staff JWTs: own prefix, own secret (derived from JWT_SECRET or CUSTOMER_APP_SECRET),
 * so a customer token can never open the business dashboard and a staff token never opens the customer app.
 *   ca1.<base64url {aid, v, exp}>.<hmac>
 */
const PREFIX = 'ca1';
export const CUSTOMER_TOKEN_DAYS = 90;

function secret(): string {
  const own = String(process.env.CUSTOMER_APP_SECRET ?? '').trim();
  if (own) return own;
  const base = String(process.env.JWT_SECRET ?? '').trim();
  if (!base) throw new Error('JWT_SECRET is required');
  return createHash('sha256').update(`customer-app-v1:${base}`).digest('hex');
}

export function signCustomerToken(accountId: number, version: number): string {
  const payload = Buffer.from(JSON.stringify({ aid: accountId, v: version, exp: Math.floor(Date.now() / 1000) + CUSTOMER_TOKEN_DAYS * 86400 })).toString('base64url');
  const sig = createHmac('sha256', secret()).update(`${PREFIX}.${payload}`).digest('base64url');
  return `${PREFIX}.${payload}.${sig}`;
}

export function readCustomerToken(token: string): { aid: number; v: number } | null {
  const [prefix, payload, sig] = String(token ?? '').split('.');
  if (prefix !== PREFIX || !payload || !sig) return null;
  const expected = Buffer.from(createHmac('sha256', secret()).update(`${PREFIX}.${payload}`).digest('base64url'));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { aid?: number; v?: number; exp?: number };
    if (!data.aid || !data.exp || data.exp * 1000 < Date.now()) return null;
    return { aid: Number(data.aid), v: Number(data.v ?? 0) };
  } catch {
    return null;
  }
}

export type CustomerAccount = { id: number; phone: string; name: string | null; token_version: number };

/** Lets only logged-in customers in (Authorization: Bearer ca1.…). */
@Injectable()
export class CustomerAuthGuard implements CanActivate {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{ headers: Record<string, string | undefined>; customer?: CustomerAccount }>();
    const header = String(request.headers.authorization ?? '');
    const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
    const claims = readCustomerToken(token);
    if (!claims) throw new UnauthorizedException('Please log in again.');
    const [account] = await this.dataSource.query(`SELECT id, phone, name, token_version FROM ca_account WHERE id = $1`, [claims.aid]);
    if (!account || Number(account.token_version) !== claims.v) throw new UnauthorizedException('Please log in again.');
    request.customer = { ...account, id: Number(account.id), token_version: Number(account.token_version) };
    void this.dataSource.query(`UPDATE ca_account SET last_seen_at = NOW() WHERE id = $1 AND (last_seen_at IS NULL OR last_seen_at < NOW() - INTERVAL '5 minutes')`, [account.id]).catch(() => undefined);
    return true;
  }
}

export const CurrentCustomer = createParamDecorator((_: unknown, context: ExecutionContext) =>
  context.switchToHttp().getRequest<{ customer: CustomerAccount }>().customer);
