import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isWithinInterval,
  startOfMonth,
  startOfWeek,
  subMonths,
  subWeeks,
} from 'date-fns';
import { Repository } from 'typeorm';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { Expense } from '../expenses/entities/expense.entity';
import { Income } from '../income/entities/income.entity';
import { Note } from '../notes/entities/note.entity';
import type { ReportPeriod } from './dto/report-query.dto';

type Range = { start: Date; end: Date };

type ReportRow = {
  id: number;
  day: string;
  date: string;
  category: string;
  income: number;
  expense: number;
  profit: number;
  margin: number;
};

type ReportAdvicePayload = {
  period: ReportPeriod;
  generated_for: string;
  insights: string[];
  advice: string[];
  predictions: string[];
};

@Injectable()
export class ReportsService {
  constructor(
    @InjectRepository(Expense)
    private readonly expenseRepository: Repository<Expense>,
    @InjectRepository(Income)
    private readonly incomeRepository: Repository<Income>,
    @InjectRepository(Note)
    private readonly noteRepository: Repository<Note>,
  ) {}

  async buildReport(user: AuthenticatedUser, period: ReportPeriod) {
    const [incomes, expenses, notes] = await Promise.all([
      this.incomeRepository.find({
        where: { company_id: user.company_id },
        relations: ['incomeCategory'],
        order: { date: 'DESC' },
      }),
      this.expenseRepository.find({
        where: { company_id: user.company_id },
        relations: ['expenseCategory'],
        order: { date: 'DESC' },
      }),
      this.noteRepository.find({
        where: { company: { id: user.company_id } },
        relations: ['color_tag'],
        order: { created_at: 'DESC' },
      }),
    ]);

    return this.composeReportPayload({ period, incomes, expenses, notes });
  }

  async buildBusinessSummary(user: AuthenticatedUser, period: ReportPeriod) {
    const report = await this.buildReport(user, period);
    const botBaseUrl = process.env.BOT_BASE_URL ?? 'http://localhost:5005';
    const fallback = this.buildFallbackSummary(report);

    try {
      const response = await fetch(`${botBaseUrl}/bot/report-summary`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          company_id: user.company_id,
          user_id: user.id,
          period,
          generated_for: report.generatedFor,
          report,
        }),
      });

      const payload = (await response.json()) as {
        reply?: string;
        error?: string;
      };

      if (!response.ok) {
        return fallback;
      }

      return {
        summary: payload.reply ?? fallback.summary,
      };
    } catch {
      return fallback;
    }
  }

  async buildBusinessAdvice(user: AuthenticatedUser, period: ReportPeriod) {
    const report = await this.buildReport(user, period);
    const botBaseUrl = process.env.BOT_BASE_URL ?? 'http://localhost:5005';
    const fallback = this.buildFallbackAdvice(report, period);

    try {
      const response = await fetch(`${botBaseUrl}/bot/report-advice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          company_id: user.company_id,
          user_id: user.id,
          period,
          generated_for: report.generatedFor,
          report,
        }),
      });

      const payload =
        (await response.json()) as Partial<ReportAdvicePayload> & {
          error?: string;
        };

      if (!response.ok) {
        return fallback;
      }

      return {
        period,
        generated_for: payload.generated_for ?? report.generatedFor,
        insights: payload.insights?.length
          ? payload.insights
          : fallback.insights,
        advice: payload.advice?.length ? payload.advice : fallback.advice,
        predictions: payload.predictions?.length
          ? payload.predictions
          : fallback.predictions,
      };
    } catch {
      return fallback;
    }
  }

  private composeReportPayload({
    period,
    incomes,
    expenses,
    notes,
  }: {
    period: ReportPeriod;
    incomes: Income[];
    expenses: Expense[];
    notes: Note[];
  }) {
    const anchorDate = this.resolveAnchorDate(incomes, expenses, period);
    const currentRange = this.createRange(anchorDate, period);
    const previousRange = this.createRange(
      period === 'weekly' ? subWeeks(anchorDate, 1) : subMonths(anchorDate, 1),
      period,
    );

    const currentIncomes = incomes.filter((item) =>
      isWithinInterval(new Date(item.date), currentRange),
    );
    const currentExpenses = expenses.filter((item) =>
      isWithinInterval(new Date(item.date), currentRange),
    );
    const currentNotes = notes.filter((item) =>
      isWithinInterval(new Date(item.created_at), currentRange),
    );

    const rows = eachDayOfInterval(currentRange).map((date, index) => {
      const key = format(date, 'yyyy-MM-dd');
      const dayIncomes = currentIncomes.filter(
        (item) => format(new Date(item.date), 'yyyy-MM-dd') === key,
      );
      const dayExpenses = currentExpenses.filter(
        (item) => format(new Date(item.date), 'yyyy-MM-dd') === key,
      );
      const income = dayIncomes.reduce((sum, item) => sum + item.amount, 0);
      const expense = dayExpenses.reduce((sum, item) => sum + item.amount, 0);
      const profit = income - expense;
      const margin = income > 0 ? (profit / income) * 100 : 0;
      const category = this.findTopCategory(dayIncomes, dayExpenses);

      return {
        id: index + 1,
        day: period === 'weekly' ? format(date, 'EEE') : format(date, 'MMM d'),
        date: key,
        category,
        income,
        expense,
        profit,
        margin,
      } satisfies ReportRow;
    });

    const previousIncome = incomes
      .filter((item) => isWithinInterval(new Date(item.date), previousRange))
      .reduce((sum, item) => sum + item.amount, 0);
    const previousExpense = expenses
      .filter((item) => isWithinInterval(new Date(item.date), previousRange))
      .reduce((sum, item) => sum + item.amount, 0);
    const totalIncome = rows.reduce((sum, row) => sum + row.income, 0);
    const totalExpenses = rows.reduce((sum, row) => sum + row.expense, 0);
    const netProfit = totalIncome - totalExpenses;

    const categoryTotals = new Map<string, number>();
    currentIncomes.forEach((item) => {
      const name = item.incomeCategory?.name || 'Uncategorized';
      categoryTotals.set(name, (categoryTotals.get(name) ?? 0) + item.amount);
    });
    const categoryGrandTotal = [...categoryTotals.values()].reduce(
      (sum, value) => sum + value,
      0,
    );
    const categoryData = [...categoryTotals.entries()]
      .sort((left, right) => right[1] - left[1])
      .map(([name, value], index) => ({
        name,
        value: categoryGrandTotal
          ? Math.round((value / categoryGrandTotal) * 100)
          : 0,
        color: [
          '#10b981',
          '#3b82f6',
          '#8b5cf6',
          '#f59e0b',
          '#ef4444',
          '#06b6d4',
        ][index % 6],
      }));

    const expenseTotals = new Map<string, number>();
    currentExpenses.forEach((item) => {
      const name = item.expenseCategory?.name || 'Uncategorized';
      expenseTotals.set(name, (expenseTotals.get(name) ?? 0) + item.amount);
    });
    const expenseGrandTotal = [...expenseTotals.values()].reduce(
      (sum, value) => sum + value,
      0,
    );
    const expenseCategoryData = [...expenseTotals.entries()]
      .sort((left, right) => right[1] - left[1])
      .map(([name, value], index) => ({
        name,
        value: expenseGrandTotal
          ? Math.round((value / expenseGrandTotal) * 100)
          : 0,
        color: [
          '#ef4444',
          '#f97316',
          '#f59e0b',
          '#eab308',
          '#06b6d4',
          '#8b5cf6',
        ][index % 6],
      }));

    return {
      period,
      generatedFor:
        period === 'weekly'
          ? `${format(currentRange.start, 'MMM d')} - ${format(currentRange.end, 'MMM d, yyyy')}`
          : format(currentRange.start, 'MMMM yyyy'),
      summary: {
        totalIncome,
        totalExpenses,
        netProfit,
        incomeChange: this.calculateChange(totalIncome, previousIncome),
        expenseChange: this.calculateChange(totalExpenses, previousExpense),
        profitChange: this.calculateChange(
          netProfit,
          previousIncome - previousExpense,
        ),
      },
      previousSummary: {
        totalIncome: previousIncome,
        totalExpenses: previousExpense,
        netProfit: previousIncome - previousExpense,
      },
      rows,
      categoryData,
      expenseCategoryData,
      topIncomeRow:
        [...rows].sort((left, right) => right.income - left.income)[0] ?? null,
      topExpenseRow:
        [...rows].sort((left, right) => right.expense - left.expense)[0] ??
        null,
      topIncomeCategory:
        [...categoryTotals.entries()].sort(
          (left, right) => right[1] - left[1],
        )[0]?.[0] ?? 'None',
      topExpenseCategory:
        [...expenseTotals.entries()].sort(
          (left, right) => right[1] - left[1],
        )[0]?.[0] ?? 'None',
      noteContext: (currentNotes.length ? currentNotes : notes)
        .slice(0, 3)
        .map((note) => `${note.title}: ${note.content}`)
        .join(' | '),
    };
  }

  private createRange(anchor: Date, period: ReportPeriod): Range {
    return period === 'weekly'
      ? {
          start: startOfWeek(anchor, { weekStartsOn: 1 }),
          end: endOfWeek(anchor, { weekStartsOn: 1 }),
        }
      : {
          start: startOfMonth(anchor),
          end: endOfMonth(anchor),
        };
  }

  private findLatestDate(incomes: Income[], expenses: Expense[]) {
    const dates = [
      ...incomes.map((item) => new Date(item.date).getTime()),
      ...expenses.map((item) => new Date(item.date).getTime()),
    ].filter((value) => !Number.isNaN(value));

    return dates.length ? new Date(Math.max(...dates)) : new Date();
  }

  private resolveAnchorDate(
    incomes: Income[],
    expenses: Expense[],
    period: ReportPeriod,
  ) {
    const records = [...incomes, ...expenses].map((item) => new Date(item.date));
    const today = new Date();
    const hasDataInCurrentWeek = records.some((date) =>
      isWithinInterval(date, {
        start: startOfWeek(today, { weekStartsOn: 1 }),
        end: endOfWeek(today, { weekStartsOn: 1 }),
      }),
    );
    const hasDataInCurrentMonth = records.some((date) =>
      isWithinInterval(date, {
        start: startOfMonth(today),
        end: endOfMonth(today),
      }),
    );

    if (
      (period === 'weekly' && hasDataInCurrentWeek) ||
      (period === 'monthly' && hasDataInCurrentMonth)
    ) {
      return today;
    }

    const latestNonFuture = records
      .filter((date) => !Number.isNaN(date.getTime()) && date.getTime() <= today.getTime())
      .sort((left, right) => right.getTime() - left.getTime())[0];

    return latestNonFuture ?? this.findLatestDate(incomes, expenses);
  }

  private findTopCategory(dayIncomes: Income[], dayExpenses: Expense[]) {
    const totals = new Map<string, number>();

    dayIncomes.forEach((item) => {
      const name = item.incomeCategory?.name || 'Income';
      totals.set(name, (totals.get(name) ?? 0) + item.amount);
    });

    dayExpenses.forEach((item) => {
      const name = item.expenseCategory?.name || 'Expense';
      totals.set(name, (totals.get(name) ?? 0) + item.amount);
    });

    return (
      [...totals.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ||
      'No activity'
    );
  }

  private calculateChange(current: number, previous: number) {
    if (previous === 0) {
      return current === 0 ? 0 : null;
    }

    return ((current - previous) / previous) * 100;
  }

  private buildFallbackSummary(
    report: Awaited<ReturnType<ReportsService['buildReport']>>,
  ) {
    const totalIncome = report.summary.totalIncome;
    const totalExpenses = report.summary.totalExpenses;
    const netProfit = report.summary.netProfit;
    const direction = netProfit >= 0 ? 'profit' : 'loss';
    const positive =
      totalIncome >= totalExpenses
        ? `Income is ahead of expenses in ${report.generatedFor}, led by ${report.topIncomeCategory || 'the strongest income category'}.`
        : `There is still a revenue base in ${report.topIncomeCategory || 'your top income category'} that can be reinforced.`;
    const watchOut =
      report.summary.expenseChange !== null && report.summary.expenseChange > 0
        ? `Expenses are rising, especially around ${report.topExpenseCategory}.`
        : `Watch the ${report.topExpenseCategory} category to keep margin stable next period.`;

    return {
      summary: [
        `SUMMARY: For ${report.generatedFor}, total income is ${totalIncome.toFixed(2)}, total expenses are ${totalExpenses.toFixed(2)}, and net ${direction} is ${Math.abs(netProfit).toFixed(2)}.`,
        `POSITIVE: ${positive}`,
        `WATCHOUT: ${watchOut}`,
      ].join('\n'),
    };
  }

  private buildFallbackAdvice(
    report: Awaited<ReturnType<ReportsService['buildReport']>>,
    period: ReportPeriod,
  ): ReportAdvicePayload {
    const profitDirection = report.summary.netProfit >= 0 ? 'profit' : 'loss';
    const topIncomeRow = report.topIncomeRow;
    const topExpenseRow = report.topExpenseRow;
    const noteSnippet = report.noteContext
      ? `Recent notes mention: ${report.noteContext}.`
      : '';
    const highExpenseRatio =
      report.summary.totalIncome > 0 &&
      report.summary.totalExpenses / report.summary.totalIncome >= 0.75;
    const incomeSoftening =
      typeof report.summary.incomeChange === 'number' &&
      report.summary.incomeChange < 0;
    const expensesRising =
      typeof report.summary.expenseChange === 'number' &&
      report.summary.expenseChange > 0;

    const insights = [
      `${report.generatedFor} closed with a net ${profitDirection} of ${Math.abs(report.summary.netProfit).toFixed(2)} from income ${report.summary.totalIncome.toFixed(2)} and expenses ${report.summary.totalExpenses.toFixed(2)}.`,
      topIncomeRow
        ? `The strongest income day was ${topIncomeRow.day} with ${topIncomeRow.income.toFixed(2)}.`
        : `The strongest income category in this period was ${report.topIncomeCategory}.`,
      topExpenseRow
        ? `The heaviest expense day was ${topExpenseRow.day} with ${topExpenseRow.expense.toFixed(2)}, mainly influenced by ${report.topExpenseCategory}.`
        : `The largest expense pressure came from ${report.topExpenseCategory}.`,
    ];

    if (noteSnippet) {
      insights.push(noteSnippet);
    }

    const advice = [
      incomeSoftening
        ? `Strengthen activity around ${report.topIncomeCategory} and focus promotions before the next ${period} closes.`
        : `Repeat the actions behind ${report.topIncomeCategory}, especially around high-performing days.`,
      expensesRising
        ? `Review the ${report.topExpenseCategory} category first and cut non-essential spending before the next ${period}.`
        : `Keep the current expense controls in place and monitor ${report.topExpenseCategory} for drift.`,
    ];

    if (noteSnippet) {
      advice.push(
        'Use the recent note reminders as part of the next-period action plan so financial follow-ups are not missed.',
      );
    } else {
      advice.push(
        'Document planned follow-ups and payment reminders so next-period execution stays consistent.',
      );
    }

    const predictions = [
      incomeSoftening
        ? `If the current income slowdown continues, the next ${period} may close with lower revenue unless ${report.topIncomeCategory} improves.`
        : `If current income momentum holds, the next ${period} should keep revenue at a similar or better level.`,
      highExpenseRatio || expensesRising
        ? `If expense pressure in ${report.topExpenseCategory} is not reduced, net margin is likely to tighten next ${period}.`
        : `If expense discipline holds, profit margin should remain more stable in the next ${period}.`,
    ];

    if (noteSnippet) {
      predictions.push(
        `If the note-related follow-ups are completed on time, operational risks should stay lower in the next ${period}.`,
      );
    }

    return {
      period,
      generated_for: report.generatedFor,
      insights,
      advice,
      predictions,
    };
  }
}
