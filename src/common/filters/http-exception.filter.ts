import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';

/**
 * Every error leaves the API in one shape:
 *   { success: false, statusCode, message: "one readable sentence", errors?: [...] }
 * Unexpected errors (database, code bugs) are logged on the server and the client gets a friendly message
 * – no SQL, stack traces or internal details.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Errors');

  catch(exception: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request>();
    if (response.headersSent) return;

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Something went wrong on our side. Please try again in a moment.';
    let errors: string[] | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      const raw = typeof body === 'string' ? body : (body as { message?: unknown }).message;
      if (Array.isArray(raw)) {
        errors = raw.map((item) => humanize(String(item)));
        message = errors[0] ?? 'Please check the form and try again.';
        if (errors.length > 1) message = `${message} (+${errors.length - 1} more)`;
      } else if (raw) {
        message = humanize(String(raw));
      }
      if (status === HttpStatus.PAYLOAD_TOO_LARGE) message = 'The file or data is too large. Use a smaller file.';
      if (status === HttpStatus.TOO_MANY_REQUESTS && /ThrottlerException/i.test(message)) {
        message = 'Too many requests. Please wait a minute and try again.';
      }
      if (status === HttpStatus.NOT_FOUND && /^Cannot (GET|POST|PUT|PATCH|DELETE)/.test(message)) {
        message = 'This address does not exist.';
      }
    } else {
      const error = exception as { message?: string; stack?: string; type?: string; status?: number };
      if (error?.type === 'entity.too.large' || error?.status === 413) {
        status = HttpStatus.PAYLOAD_TOO_LARGE;
        message = 'The file or data is too large. Use a smaller file.';
      } else if ((exception as { name?: string })?.name === 'QueryFailedError' && /invalid input syntax|out of range/i.test(error?.message ?? '')) {
        status = HttpStatus.BAD_REQUEST;
        message = 'Some values in the request are not valid.';
      } else if (error?.type === 'entity.parse.failed') {
        status = HttpStatus.BAD_REQUEST;
        message = 'The request body is not valid JSON.';
      } else {
        this.logger.error(`${request.method} ${request.originalUrl ?? request.url} → ${error?.message ?? exception}`, error?.stack);
      }
    }

    if (status >= 500 && exception instanceof HttpException) {
      this.logger.warn(`${request.method} ${request.originalUrl ?? request.url} → ${status} ${message}`);
    }

    response.status(status).json({ success: false, statusCode: status, message, ...(errors && errors.length > 1 ? { errors } : {}), data: null });
  }
}

/** class-validator messages like "agent_id must be a number" → "Agent id must be a number." */
function humanize(text: string) {
  let value = text.trim();
  if (/^property \S+ should not exist$/.test(value)) {
    value = `${value.replace(/^property (\S+) should not exist$/, '$1')} is not allowed here`;
  }
  value = value.replace(/^([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/, (match) => match.replace(/_/g, ' '));
  value = value.charAt(0).toUpperCase() + value.slice(1);
  return /[.!?)]$/.test(value) ? value : `${value}.`;
}
