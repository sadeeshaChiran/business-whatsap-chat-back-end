import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Observable, tap } from 'rxjs';
import { DataSource } from 'typeorm';

const SECRET = /pass|secret|token|pin|hash/i;

/** Records every change a super admin makes (POST / PUT / PATCH / DELETE) in platform_audit_log. */
@Injectable()
export class SuperAdminAuditInterceptor implements NestInterceptor {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<{ method: string; route?: { path?: string }; originalUrl: string; params: Record<string, string>; body: unknown; user?: { id?: number; email?: string } }>();
    if (request.method === 'GET') return next.handle();
    const body = request.body && typeof request.body === 'object'
      ? Object.fromEntries(Object.entries(request.body as Record<string, unknown>).map(([key, value]) => [key, SECRET.test(key) ? '•••' : value]))
      : {};
    const action = `${request.method} ${request.route?.path ?? request.originalUrl}`.replace('/v1/api', '').slice(0, 120);
    return next.handle().pipe(tap({
      next: () => {
        void this.dataSource.query(
          `INSERT INTO platform_audit_log (user_id, user_email, action, target, details) VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [request.user?.id ?? null, request.user?.email ?? null, action, Object.values(request.params ?? {}).join('/').slice(0, 255), JSON.stringify(body)],
        ).catch(() => undefined);
      },
    }));
  }
}
