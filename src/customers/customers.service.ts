import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { SupabaseCustomer } from '../supabase/entities/supabase-customer.entity';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';

@Injectable()
export class CustomersService {
  constructor(
    @InjectRepository(SupabaseCustomer)
    private readonly customerRepository: Repository<SupabaseCustomer>,
  ) {}

  private normalizePhone(phone: string): string {
    return phone.trim();
  }

  private async findOwnedCustomer(id: number, companyId: number) {
    const customer = await this.customerRepository.findOne({
      where: { id, company_id: companyId },
    });
    if (!customer) {
      throw new NotFoundException('Customer not found');
    }
    return customer;
  }

  async create(dto: CreateCustomerDto, user: AuthenticatedUser) {
    const customer_phone = this.normalizePhone(dto.customer_phone);
    const existing = await this.customerRepository.findOne({
      where: { company_id: user.company_id, customer_phone },
    });
    if (existing) {
      throw new ConflictException('Customer with this phone already exists');
    }

    const now = new Date();
    const customer = this.customerRepository.create({
      company_id: user.company_id,
      customer_phone,
      assigned_instance: dto.assigned_instance?.trim() || null,
      first_seen_at: now,
      last_seen_at: now,
    });
    return this.customerRepository.save(customer);
  }

  async findAll(user: AuthenticatedUser) {
    return this.customerRepository.find({
      where: { company_id: user.company_id },
      order: { last_seen_at: 'DESC', id: 'DESC' },
    });
  }

  async findOne(id: number, user: AuthenticatedUser) {
    return this.findOwnedCustomer(id, user.company_id);
  }

  async update(id: number, dto: UpdateCustomerDto, user: AuthenticatedUser) {
    const customer = await this.findOwnedCustomer(id, user.company_id);

    if (dto.customer_phone !== undefined) {
      const customer_phone = this.normalizePhone(dto.customer_phone);
      const duplicate = await this.customerRepository.findOne({
        where: { company_id: user.company_id, customer_phone },
      });
      if (duplicate && duplicate.id !== customer.id) {
        throw new ConflictException('Customer with this phone already exists');
      }
      customer.customer_phone = customer_phone;
    }

    if (dto.assigned_instance !== undefined) {
      customer.assigned_instance = dto.assigned_instance?.trim() || null;
    }

    customer.last_seen_at = new Date();
    return this.customerRepository.save(customer);
  }

  async remove(id: number, user: AuthenticatedUser) {
    const customer = await this.findOwnedCustomer(id, user.company_id);
    await this.customerRepository.remove(customer);
    return { id };
  }

  async touchByPhone(companyId: number, customerPhone: string) {
    const customer_phone = this.normalizePhone(customerPhone);
    let customer = await this.customerRepository.findOne({
      where: { company_id: companyId, customer_phone },
    });
    const now = new Date();
    if (!customer) {
      customer = this.customerRepository.create({
        company_id: companyId,
        customer_phone,
        first_seen_at: now,
        last_seen_at: now,
      });
    } else {
      customer.last_seen_at = now;
    }
    return this.customerRepository.save(customer);
  }
}
