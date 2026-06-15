import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { subDays } from 'date-fns';
import { Repository } from 'typeorm';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { Expense } from '../expenses/entities/expense.entity';
import { Income } from '../income/entities/income.entity';
import { Note } from '../notes/entities/note.entity';
import { ReportQueryDto } from '../reports/dto/report-query.dto';
import { ReportsService } from '../reports/reports.service';
import { NotificationsQueryDto } from './dto/notifications-query.dto';

type NotificationType = 'REMINDER' | 'RISK' | 'INFO';
type NotificationPriority = 'LOW' | 'MEDIUM' | 'HIGH';
type RelatedEntityType = 'expense' | 'income' | 'note' | null;

type NotificationItem = {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  is_read: boolean;
  priority: NotificationPriority;
  related_entity_type: RelatedEntityType;
  related_entity_id: number | null;
  created_at: string;
  updated_at: string;
};

type CachedFeed = {
  expiresAt: number;
  items: NotificationItem[];
};

@Injectable()
export class NotificationsService {
  private readonly feedCache = new Map<number, CachedFeed>();
  private readonly readState = new Map<number, Set<string>>();
  private readonly cacheTtlMs = 60_000;

  constructor(
    @InjectRepository(Expense)
    private readonly expenseRepository: Repository<Expense>,
    @InjectRepository(Income)
    private readonly incomeRepository: Repository<Income>,
    @InjectRepository(Note)
    private readonly noteRepository: Repository<Note>,
    private readonly reportsService: ReportsService,
  ) {}

  async getNotifications(
    user: AuthenticatedUser,
    query: NotificationsQueryDto,
  ) {
    const items = await this.getOrBuildFeed(user);
    let filtered = items;

    if (query.unread === 'true') {
      filtered = filtered.filter((item) => !item.is_read);
    }

    if (query.type) {
      filtered = filtered.filter((item) => item.type === query.type);
    }

    return filtered.sort(
      (left, right) =>
        new Date(right.created_at).getTime() - new Date(left.created_at).getTime(),
    );
  }

  async generateNotifications(user: AuthenticatedUser) {
    const items = await this.buildNotificationFeed(user);
    this.feedCache.set(user.id, {
      expiresAt: Date.now() + this.cacheTtlMs,
      items,
    });
    return items;
  }

  async markAsRead(user: AuthenticatedUser, notificationId: string) {
    const readIds = this.readState.get(user.id) ?? new Set<string>();
    readIds.add(notificationId);
    this.readState.set(user.id, readIds);

    const items = await this.getOrBuildFeed(user);
    const item = items.find((entry) => entry.id === notificationId);

    return {
      id: notificationId,
      is_read: true,
      notification: item ?? null,
    };
  }

  private async getOrBuildFeed(user: AuthenticatedUser) {
    const cached = this.feedCache.get(user.id);
    if (cached && cached.expiresAt > Date.now()) {
      return this.attachReadState(user.id, cached.items);
    }

    const items = await this.buildNotificationFeed(user);
    this.feedCache.set(user.id, {
      expiresAt: Date.now() + this.cacheTtlMs,
      items,
    });
    return this.attachReadState(user.id, items);
  }

  private attachReadState(userId: number, items: NotificationItem[]) {
    const readIds = this.readState.get(userId) ?? new Set<string>();
    return items.map((item) => ({
      ...item,
      is_read: readIds.has(item.id),
    }));
  }

  private async buildNotificationFeed(user: AuthenticatedUser) {
    const [incomes, expenses, notes, healthWeekly, healthMonthly] =
      await Promise.all([
        this.incomeRepository.find({
          where: { company_id: user.company_id },
          relations: ['incomeCategory'],
          order: { date: 'DESC' },
          take: 20,
        }),
        this.expenseRepository.find({
          where: { company_id: user.company_id },
          relations: ['expenseCategory'],
          order: { date: 'DESC' },
          take: 30,
        }),
        this.noteRepository.find({
          where: {
            company: { id: user.company_id },
            created_user_id: user.id,
            is_selected_for_ai: true,
          },
          relations: ['color_tag'],
          order: { updated_at: 'DESC' },
          take: 20,
        }),
        this.reportsService.buildHealthCheck(
          user,
          { period: 'weekly' } as ReportQueryDto,
        ),
        this.reportsService.buildHealthCheck(
          user,
          { period: 'monthly' } as ReportQueryDto,
        ),
      ]);

    const now = new Date();
    const notifications: NotificationItem[] = [];
    const hasFinancialActivity = incomes.length > 0 || expenses.length > 0;

    const totals7d = this.sumPeriod(incomes, expenses, 7);
    if (hasFinancialActivity && totals7d.expenses > totals7d.income) {
      notifications.push(
        this.createNotification({
          id: 'risk-expense-vs-income-7d',
          type: 'RISK',
          title: 'High Spending Alert',
          message:
            'Your expenses exceeded income in the last 7 days. Review recent spending before margin pressure increases.',
          priority: 'HIGH',
          createdAt: now,
        }),
      );
    }

    const totals30d = this.sumPeriod(incomes, expenses, 30);
    if (hasFinancialActivity && totals30d.expenses > totals30d.income) {
      notifications.push(
        this.createNotification({
          id: 'risk-expense-vs-income-30d',
          type: 'RISK',
          title: 'Monthly Cashflow Risk',
          message:
            'Your expenses exceeded income in the last 30 days. Current spending trend is weakening profitability.',
          priority: 'HIGH',
          createdAt: now,
        }),
      );
    }

    const decliningIncome = this.detectDecliningIncome(incomes);
    if (decliningIncome) {
      notifications.push(
        this.createNotification({
          id: 'info-income-trend-down',
          type: 'INFO',
          title: 'Income Trend Softening',
          message:
            'Recent income entries are trending down. Monitor upcoming revenue closely to avoid a low-balance pattern.',
          priority: 'MEDIUM',
          relatedEntityType: 'income',
          relatedEntityId: decliningIncome.id,
          createdAt: decliningIncome.date,
        }),
      );
    }

    const staleNotes = notes.filter((note) => this.isImportantStaleNote(note));
    for (const note of staleNotes.slice(0, 3)) {
      notifications.push(
        this.createNotification({
          id: `reminder-stale-note-${note.id}`,
          type: 'REMINDER',
          title: 'Follow Up Selected Note',
          message: `"${note.title}" looks important but has not been updated recently.`,
          priority: 'LOW',
          relatedEntityType: 'note',
          relatedEntityId: note.id,
          createdAt: note.updated_at ?? note.created_at,
        }),
      );
    }

    if (
      hasFinancialActivity &&
      (healthWeekly.healthScore < 50 || healthMonthly.healthScore < 50)
    ) {
      const weakerHealth =
        healthWeekly.healthScore <= healthMonthly.healthScore
          ? healthWeekly
          : healthMonthly;
      const primaryWarning =
        weakerHealth.warnings.find((warning) => warning?.trim()) ??
        'Business risk indicators need immediate review.';
      notifications.push(
        this.createNotification({
          id: 'risk-business-health-check',
          type: 'RISK',
          title: 'Business Risk Alert',
          message: `Business health score dropped to ${weakerHealth.healthScore}. ${weakerHealth.status} conditions need attention. ${primaryWarning}`,
          priority: 'HIGH',
          createdAt: now,
        }),
      );
    }

    const metricHealth =
      healthWeekly.healthScore <= healthMonthly.healthScore
        ? healthWeekly
        : healthMonthly;
    const currentRatioMetric = metricHealth.metrics.find(
      (metric) => metric.label === 'Current Ratio',
    );
    const netProfitMarginMetric = metricHealth.metrics.find(
      (metric) => metric.label === 'Net Profit Margin',
    );
    const topExpenseWarning = metricHealth.warnings.find((warning) =>
      warning.toLowerCase().includes('key category to monitor for leakage'),
    );

    if (hasFinancialActivity && currentRatioMetric?.status === 'risk') {
      notifications.push(
        this.createNotification({
          id: 'risk-current-ratio',
          type: 'RISK',
          title: 'Liquidity Coverage Alert',
          message: `Current Ratio is at ${currentRatioMetric.value}. Short-term income coverage is below expense pressure and needs action.`,
          priority: 'HIGH',
          createdAt: now,
        }),
      );
    }

    if (hasFinancialActivity && netProfitMarginMetric?.status === 'risk') {
      notifications.push(
        this.createNotification({
          id: 'risk-net-profit-margin',
          type: 'RISK',
          title: 'Net Margin Risk',
          message: `Net Profit Margin is at ${netProfitMarginMetric.value}. Profitability is under pressure and costs should be reviewed immediately.`,
          priority: 'HIGH',
          createdAt: now,
        }),
      );
    }

    if (hasFinancialActivity && topExpenseWarning) {
      notifications.push(
        this.createNotification({
          id: 'warning-expense-category-leakage',
          type: 'RISK',
          title: 'Expense Leakage Watch',
          message: topExpenseWarning,
          priority: 'MEDIUM',
          createdAt: now,
        }),
      );
    }

    const reminderSignals = this.findReminderSignals(notes, incomes, expenses);
    for (const reminder of reminderSignals.slice(0, 3)) {
      notifications.push(
        this.createNotification({
          id: reminder.id,
          type: 'REMINDER',
          title: reminder.title,
          message: reminder.message,
          priority: reminder.priority,
          relatedEntityType: reminder.relatedEntityType,
          relatedEntityId: reminder.relatedEntityId,
          createdAt: reminder.createdAt,
        }),
      );
    }

    return this.deduplicate(notifications)
      .sort(
        (left, right) =>
          new Date(right.created_at).getTime() - new Date(left.created_at).getTime(),
      )
      .slice(0, 20);
  }

  private sumPeriod(incomes: Income[], expenses: Expense[], days: number) {
    const threshold = subDays(new Date(), days);
    return {
      income: incomes
        .filter((income) => new Date(income.date) >= threshold)
        .reduce((sum, income) => sum + Number(income.amount ?? 0), 0),
      expenses: expenses
        .filter((expense) => new Date(expense.date) >= threshold)
        .reduce((sum, expense) => sum + Number(expense.amount ?? 0), 0),
    };
  }

  private detectDecliningIncome(incomes: Income[]) {
    const latest = [...incomes]
      .sort((left, right) => new Date(right.date).getTime() - new Date(left.date).getTime())
      .slice(0, 3);

    if (latest.length < 3) {
      return null;
    }

    if (
      Number(latest[0].amount) < Number(latest[1].amount) &&
      Number(latest[1].amount) < Number(latest[2].amount)
    ) {
      return latest[0];
    }

    return null;
  }

  private isImportantStaleNote(note: Note) {
    const tagText = `${note.color_tag?.name ?? ''} ${note.color_tag?.meaning ?? ''}`.toLowerCase();
    const titleText = `${note.title ?? ''} ${note.content ?? ''}`.toLowerCase();
    const isImportant =
      tagText.includes('important') ||
      tagText.includes('urgent') ||
      tagText.includes('high') ||
      titleText.includes('important') ||
      titleText.includes('urgent');

    if (!isImportant) {
      return false;
    }

    const updatedAt = note.updated_at ?? note.created_at;
    return updatedAt ? updatedAt < subDays(new Date(), 14) : false;
  }

  private findReminderSignals(notes: Note[], incomes: Income[], expenses: Expense[]) {
    const items: Array<{
      id: string;
      title: string;
      message: string;
      priority: NotificationPriority;
      relatedEntityType: RelatedEntityType;
      relatedEntityId: number | null;
      createdAt: Date;
    }> = [];

    for (const note of notes) {
      const text = `${note.title} ${note.content}`.toLowerCase();
      if (/(today|tomorrow|due|remind|follow up|overdue)/.test(text)) {
        items.push({
          id: `reminder-note-signal-${note.id}`,
          title: 'Reminder From Selected Note',
          message: `Selected note "${note.title}" contains a reminder or due-date signal.`,
          priority: text.includes('overdue') ? 'HIGH' : 'MEDIUM',
          relatedEntityType: 'note',
          relatedEntityId: note.id,
          createdAt: note.updated_at ?? note.created_at ?? new Date(),
        });
      }
    }

    for (const expense of expenses.slice(0, 10)) {
      const text = `${expense.note ?? ''}`.toLowerCase();
      if (/(due|overdue|today|tomorrow|remind)/.test(text)) {
        items.push({
          id: `reminder-expense-signal-${expense.id}`,
          title: 'Expense Reminder Alert',
          message: 'A recent expense note contains a due-date or reminder signal.',
          priority: text.includes('overdue') ? 'HIGH' : 'MEDIUM',
          relatedEntityType: 'expense',
          relatedEntityId: expense.id,
          createdAt: expense.updated_at ?? expense.created_at ?? new Date(),
        });
      }
    }

    for (const income of incomes.slice(0, 10)) {
      const text = `${income.note ?? ''}`.toLowerCase();
      if (/(client|payment|due|tomorrow|today|follow up)/.test(text)) {
        items.push({
          id: `reminder-income-signal-${income.id}`,
          title: 'Income Follow-Up Reminder',
          message: 'A recent income note may need follow-up to protect expected cash inflow.',
          priority: 'MEDIUM',
          relatedEntityType: 'income',
          relatedEntityId: income.id,
          createdAt: income.updated_at ?? income.created_at ?? new Date(),
        });
      }
    }

    return items;
  }

  private deduplicate(items: NotificationItem[]) {
    const map = new Map<string, NotificationItem>();
    for (const item of items) {
      if (!map.has(item.id)) {
        map.set(item.id, item);
      }
    }
    return [...map.values()];
  }

  private createNotification(params: {
    id: string;
    type: NotificationType;
    title: string;
    message: string;
    priority: NotificationPriority;
    createdAt: Date;
    relatedEntityType?: RelatedEntityType;
    relatedEntityId?: number | null;
  }): NotificationItem {
    const createdAt = params.createdAt.toISOString();
    return {
      id: params.id,
      type: params.type,
      title: params.title,
      message: params.message,
      is_read: false,
      priority: params.priority,
      related_entity_type: params.relatedEntityType ?? null,
      related_entity_id: params.relatedEntityId ?? null,
      created_at: createdAt,
      updated_at: createdAt,
    };
  }
}
