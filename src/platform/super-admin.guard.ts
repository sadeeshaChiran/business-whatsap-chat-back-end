import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';

/** Only Metrocoding team accounts (app_user.is_super_admin). Use after JwtAuthGuard. */
@Injectable()
export class SuperAdminGuard implements CanActivate {
  constructor(@InjectRepository(User) private readonly userRepository: Repository<User>) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{ user?: { id?: number } }>();
    const id = Number(request.user?.id);
    const user = Number.isFinite(id) && id > 0 ? await this.userRepository.findOne({ where: { id } }) : null;
    if (!user?.is_super_admin || !user.is_active) throw new ForbiddenException('Super admin only.');
    return true;
  }
}
