import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  addDays,
  differenceInCalendarDays,
  eachDayOfInterval,
  endOfDay,
  endOfMonth,
  endOfWeek,
  format,
  isWithinInterval,
  startOfDay,
  startOfMonth,
  startOfWeek,
  subDays,
  subMonths,
  subWeeks,
} from 'date-fns';
import { Repository } from 'typeorm';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { Expense } from '../expenses/entities/expense.entity';
import { Income } from '../income/entities/income.entity';
import { Note } from '../notes/entities/note.entity';
import type { ReportPeriod } from './dto/report-query.dto';
import { ReportQueryDto } from './dto/report-query.dto';

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

type ParsedSelectedNoteEntry = {
  id: number;
  type: 'income' | 'expense';
  amount: number;
  date: Date;
  category: string;
};

type DetailedIncomeItem = {
  id: number;
  amount: number;
  date: string;
  note: string;
  category: string;
  source: 'table' | 'selected_note';
};

type DetailedExpenseItem = {
  id: number;
  amount: number;
  date: string;
  note: string;
  category: string;
  source: 'table' | 'selected_note';
};

type DetailedNoteItem = {
  id: number;
  title: string;
  content: string;
  created_at: string;
};

type HealthMetric = {
  label: string;
  value: string;
  status: 'healthy' | 'warning' | 'risk';
  formula: string;
};

type HealthRisk = {
  title: string;
  level: 'low' | 'medium' | 'high';
  score: number;
  detail: string;
};

type BotHealthPayload = {
  generatedFor?: string;
  healthScore?: number;
  overallRiskScore?: number;
  status?: string;
  metrics?: HealthMetric[];
  risks?: HealthRisk[];
  strengths?: string[];
  warnings?: string[];
  focus_areas?: string[];
  noteContext?: string;
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

  async buildReport(user: AuthenticatedUser, query: ReportQueryDto) {
    const [incomes, expenses, selectedNotes] = await Promise.all([
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
        where: {
          company: { id: user.company_id },
          created_user_id: user.id,
          is_selected_for_ai: true,
        },
        relations: ['color_tag'],
        order: { updated_at: 'DESC' },
      }),
    ]);

    return this.composeReportPayload({
      query,
      incomes,
      expenses,
      notes: selectedNotes,
    });
  }

  async buildBusinessSummary(user: AuthenticatedUser, query: ReportQueryDto) {
    const report = await this.buildReport(user, query);
    const botBaseUrl = process.env.BOT_BASE_URL ?? 'http://localhost:5005';
    const fallback = this.buildFallbackSummary(report);

    if (!report.noteContext?.trim()) {
      return fallback;
    }

    try {
      const response = await fetch(`${botBaseUrl}/bot/report-summary`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          company_id: user.company_id,
          user_id: user.id,
          period: report.period,
          generated_for: report.generatedFor,
          report,
        }),
      });

      const payload = (await response.json()) as {
        reply?: string;
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

  async buildBusinessAdvice(user: AuthenticatedUser, query: ReportQueryDto) {
    const report = await this.buildReport(user, query);
    const botBaseUrl = process.env.BOT_BASE_URL ?? 'http://localhost:5005';
    const fallback = this.buildFallbackAdvice(report, report.period);

    if (!report.noteContext?.trim()) {
      return fallback;
    }

    try {
      const response = await fetch(`${botBaseUrl}/bot/report-advice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          company_id: user.company_id,
          user_id: user.id,
          period: report.period,
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
        period: report.period,
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

  async buildHealthCheck(user: AuthenticatedUser, query: ReportQueryDto) {
    const report = await this.buildReport(user, query);
    const botBaseUrl = process.env.BOT_BASE_URL ?? 'http://localhost:5005';
    const totalIncome = report.summary.totalIncome;
    const totalExpenses = report.summary.totalExpenses;
    const netProfit = report.summary.netProfit;
    const noteContext = report.noteContext?.toLowerCase() ?? '';
    const expenseRatio =
      totalIncome > 0 ? report.summary.totalExpenses / report.summary.totalIncome : 1;
    const netMargin =
      totalIncome > 0 ? report.summary.netProfit / report.summary.totalIncome : 0;
    const currentRatio =
      totalExpenses > 0 ? report.summary.totalIncome / report.summary.totalExpenses : null;
    const quickRatio = currentRatio;
    const debtToEquity =
      netProfit > 0 ? report.summary.totalExpenses / report.summary.netProfit : null;
    const noteRiskHits = [
      'debt',
      'late',
      'overdue',
      'loss',
      'cash out',
      'marketing',
      'bill',
      'bills',
      'expense',
    ].filter((keyword) => noteContext.includes(keyword)).length;

    const executionRiskScore =
      (expenseRatio >= 0.85 ? 5 : expenseRatio >= 0.7 ? 3 : 1) + noteRiskHits;
    const liquidityRiskScore =
      currentRatio === null ? 1 : currentRatio < 1 ? 5 : currentRatio < 1.25 ? 3 : 1;
    const profitabilityRiskScore =
      netMargin <= 0 ? 5 : netMargin < 0.1 ? 3 : 1;

    const overallRiskScore = Math.min(
      25,
      executionRiskScore + liquidityRiskScore + profitabilityRiskScore,
    );
    const healthScore = Math.max(
      0,
      Math.min(
        100,
        Math.round(100 - overallRiskScore * 3 - Math.max(0, noteRiskHits - 1) * 4),
      ),
    );

    const metrics: HealthMetric[] = [
      {
        label: 'Net Profit Margin',
        value: `${(netMargin * 100).toFixed(1)}%`,
        status: netMargin >= 0.2 ? 'healthy' : netMargin >= 0.1 ? 'warning' : 'risk',
        formula: 'Net Profit / Total Income',
      },
      {
        label: 'Gross Profit Margin',
        value: `${(netMargin * 100).toFixed(1)}%`,
        status: netMargin >= 0.2 ? 'healthy' : netMargin >= 0.1 ? 'warning' : 'risk',
        formula: '(Income - Expenses) / Income',
      },
      {
        label: 'EBITDA %',
        value: `${(netMargin * 100).toFixed(1)}%`,
        status: netMargin >= 0.15 ? 'healthy' : netMargin >= 0.05 ? 'warning' : 'risk',
        formula: 'Operating Profit Proxy / Income',
      },
      {
        label: 'Current Ratio',
        value: currentRatio === null ? 'N/A' : currentRatio.toFixed(2),
        status:
          currentRatio === null
            ? 'warning'
            : currentRatio >= 1.5
              ? 'healthy'
              : currentRatio >= 1
                ? 'warning'
                : 'risk',
        formula: 'Income Coverage / Expenses',
      },
      {
        label: 'Quick Ratio',
        value: quickRatio === null ? 'N/A' : quickRatio.toFixed(2),
        status:
          quickRatio === null
            ? 'warning'
            : quickRatio >= 1
              ? 'healthy'
              : quickRatio >= 0.8
                ? 'warning'
                : 'risk',
        formula: 'Immediate Cashflow Coverage / Expenses',
      },
      {
        label: 'Debt-to-Equity',
        value: debtToEquity === null ? 'N/A' : debtToEquity.toFixed(2),
        status:
          debtToEquity === null
            ? 'warning'
            : debtToEquity <= 1
              ? 'healthy'
              : debtToEquity <= 2
                ? 'warning'
                : 'risk',
        formula: 'Expense Load / Net Profit',
      },
    ];

    const risks: HealthRisk[] = [
      {
        title: 'Profitability Risk',
        level:
          profitabilityRiskScore >= 5
            ? 'high'
            : profitabilityRiskScore >= 3
              ? 'medium'
              : 'low',
        score: profitabilityRiskScore,
        detail:
          netMargin <= 0
            ? 'Profit has been fully diluted by expenses in the selected period.'
            : netMargin < 0.1
              ? 'Profit margin is thin and can erode quickly with small cost increases.'
              : 'Profit margin is stable relative to current expense load.',
      },
      {
        title: 'Liquidity Risk',
        level:
          liquidityRiskScore >= 5
            ? 'high'
            : liquidityRiskScore >= 3
              ? 'medium'
              : 'low',
        score: liquidityRiskScore,
        detail:
          currentRatio !== null && currentRatio < 1
            ? 'Income coverage is below expense pressure, creating cash fragility.'
            : currentRatio !== null && currentRatio < 1.25
              ? 'Short-term coverage is present but tight.'
              : 'Short-term coverage looks stable based on current income and expense flow.',
      },
      {
        title: 'Execution Risk',
        level:
          executionRiskScore >= 6
            ? 'high'
            : executionRiskScore >= 3
              ? 'medium'
              : 'low',
        score: executionRiskScore,
        detail:
          noteRiskHits > 0
            ? `Selected notes indicate operational pressure: ${report.noteContext || 'recent note warnings detected'}.`
            : 'No major operational warning signals were detected in selected notes.',
      },
    ];

    const strengths = [
      netMargin > 0.15
        ? 'Profit generation is healthy relative to the current expense base.'
        : 'Income is still covering core expense activity in the current period.',
      currentRatio !== null && currentRatio >= 1.25
        ? 'Short-term cashflow coverage is stable.'
        : 'The business still has active income flow to support near-term operations.',
      report.topIncomeCategory && report.topIncomeCategory !== 'None'
        ? `${report.topIncomeCategory} remains the strongest income driver.`
        : 'Income sources remain active across the selected range.',
    ];

    const warnings = [
      expenseRatio >= 0.75
        ? 'Expense pressure is high relative to income and can compress margins quickly.'
        : 'Expense growth should still be watched to protect margin.',
      noteRiskHits > 0
        ? 'Selected notes contain risk-related wording that suggests follow-up is needed.'
        : 'Operational notes do not currently show major flagged risk patterns.',
      report.topExpenseCategory !== 'None'
        ? `${report.topExpenseCategory} is the key category to monitor for leakage.`
        : 'Expense distribution should be monitored as volume grows.',
    ];

    const focusAreas = [
      'Operational Efficiency',
      'Customer / Client Engagement',
      'Management & Strategy',
      'Compliance & Financial Discipline',
    ];

    const healthCheck = {
      generatedFor: report.generatedFor,
      healthScore,
      overallRiskScore,
      status:
        healthScore >= 75 ? 'Strong' : healthScore >= 50 ? 'Stable with Risk' : 'Fragile',
      metrics,
      risks,
      strengths,
      warnings,
      focusAreas,
      noteContext: report.noteContext,
    };

    try {
      const response = await fetch(`${botBaseUrl}/bot/report-health`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          company_id: user.company_id,
          user_id: user.id,
          period: report.period,
          generated_for: report.generatedFor,
          start_date: query.start_date,
          end_date: query.end_date,
          report,
          health_check: healthCheck,
        }),
      });

      const payload = (await response.json()) as BotHealthPayload & {
        error?: string;
      };

      if (!response.ok) {
        return healthCheck;
      }

      return {
        ...healthCheck,
        generatedFor: payload.generatedFor ?? healthCheck.generatedFor,
        healthScore: typeof payload.healthScore === 'number' ? payload.healthScore : healthCheck.healthScore,
        overallRiskScore:
          typeof payload.overallRiskScore === 'number'
            ? payload.overallRiskScore
            : healthCheck.overallRiskScore,
        status: payload.status ?? healthCheck.status,
        metrics: payload.metrics?.length ? payload.metrics : healthCheck.metrics,
        risks: payload.risks?.length ? payload.risks : healthCheck.risks,
        strengths: payload.strengths?.length ? payload.strengths : healthCheck.strengths,
        warnings: payload.warnings?.length ? payload.warnings : healthCheck.warnings,
        focusAreas: payload.focus_areas?.length ? payload.focus_areas : healthCheck.focusAreas,
        noteContext: payload.noteContext ?? healthCheck.noteContext,
      };
    } catch {
      return healthCheck;
    }
  }

  async buildExcelExport(user: AuthenticatedUser, query: ReportQueryDto) {
    const report = await this.buildReport(user, query);
    const header = ['Date', 'Day', 'Category', 'Income', 'Expenses', 'Profit', 'Margin'];
    const rows = report.rows.map((row) => [
      row.date,
      row.day,
      row.category,
      row.income.toFixed(2),
      row.expense.toFixed(2),
      row.profit.toFixed(2),
      `${row.margin.toFixed(1)}%`,
    ]);

    const notes = report.notes.map((note) => [
      note.created_at,
      note.title,
      note.content.replace(/\s+/g, ' ').trim(),
    ]);

    const sections = [
      ['Generated For', report.generatedFor],
      ['Total Income', report.summary.totalIncome.toFixed(2)],
      ['Total Expenses', report.summary.totalExpenses.toFixed(2)],
      ['Net Profit', report.summary.netProfit.toFixed(2)],
      [],
      header,
      ...rows,
      [],
      ['Selected AI Notes'],
      ['Created At', 'Title', 'Content'],
      ...notes,
    ];

    const content = sections
      .map((line) => line.map((value) => `${value ?? ''}`).join('\t'))
      .join('\n');

    return {
      filename: `report-${this.buildFileSuffix(query)}.xls`,
      content,
    };
  }

  async buildPdfExport(user: AuthenticatedUser, query: ReportQueryDto) {
    const report = await this.buildReport(user, query);
    const lines = [
      `Report`,
      `Generated For: ${report.generatedFor}`,
      `Total Income: ${report.summary.totalIncome.toFixed(2)}`,
      `Total Expenses: ${report.summary.totalExpenses.toFixed(2)}`,
      `Net Profit: ${report.summary.netProfit.toFixed(2)}`,
      '',
      'Rows:',
      ...report.rows.map(
        (row) =>
          `${row.date} | ${row.day} | ${row.category} | Income ${row.income.toFixed(2)} | Expenses ${row.expense.toFixed(2)} | Profit ${row.profit.toFixed(2)}`,
      ),
      '',
      'Selected AI Notes:',
      ...report.notes.map(
        (note) =>
          `${note.created_at} | ${note.title} | ${note.content.replace(/\s+/g, ' ').trim()}`,
      ),
    ];

    return {
      filename: `report-${this.buildFileSuffix(query)}.pdf`,
      content: this.buildSimplePdf(lines),
    };
  }

  private composeReportPayload({
    query,
    incomes,
    expenses,
    notes,
  }: {
    query: ReportQueryDto;
    incomes: Income[];
    expenses: Expense[];
    notes: Note[];
  }) {
    const period = query.period ?? 'weekly';
    const parsedNoteEntries = this.parseSelectedNoteEntries(notes);
    const currentRange = this.resolveCurrentRange({
      query,
      incomes,
      expenses,
      noteEntries: parsedNoteEntries,
      period,
    });
    const previousRange = this.resolvePreviousRange(currentRange, query, period);

    const currentIncomes = incomes.filter((item) =>
      isWithinInterval(new Date(item.date), currentRange),
    );
    const currentExpenses = expenses.filter((item) =>
      isWithinInterval(new Date(item.date), currentRange),
    );
    const currentNoteEntries = parsedNoteEntries.filter((item) =>
      isWithinInterval(item.date, currentRange),
    );
    const currentNotes = notes.filter((note) =>
      isWithinInterval(new Date(note.created_at), currentRange),
    );

    const rows = eachDayOfInterval(currentRange).map((date, index) => {
      const key = format(date, 'yyyy-MM-dd');
      const dayIncomes = currentIncomes.filter(
        (item) => format(new Date(item.date), 'yyyy-MM-dd') === key,
      );
      const dayExpenses = currentExpenses.filter(
        (item) => format(new Date(item.date), 'yyyy-MM-dd') === key,
      );
      const dayNoteEntries = currentNoteEntries.filter(
        (item) => format(item.date, 'yyyy-MM-dd') === key,
      );

      const income =
        dayIncomes.reduce((sum, item) => sum + item.amount, 0) +
        dayNoteEntries
          .filter((item) => item.type === 'income')
          .reduce((sum, item) => sum + item.amount, 0);
      const expense =
        dayExpenses.reduce((sum, item) => sum + item.amount, 0) +
        dayNoteEntries
          .filter((item) => item.type === 'expense')
          .reduce((sum, item) => sum + item.amount, 0);
      const profit = income - expense;
      const margin = income > 0 ? (profit / income) * 100 : 0;

      return {
        id: index + 1,
        day:
          query.start_date && query.end_date
            ? format(date, 'MMM d')
            : period === 'weekly'
              ? format(date, 'EEE')
              : format(date, 'MMM d'),
        date: key,
        category: this.findTopCategory(dayIncomes, dayExpenses, dayNoteEntries),
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
    const previousNoteEntries = parsedNoteEntries.filter((item) =>
      isWithinInterval(item.date, previousRange),
    );
    const previousNoteIncome = previousNoteEntries
      .filter((item) => item.type === 'income')
      .reduce((sum, item) => sum + item.amount, 0);
    const previousNoteExpense = previousNoteEntries
      .filter((item) => item.type === 'expense')
      .reduce((sum, item) => sum + item.amount, 0);

    const totalIncome = rows.reduce((sum, row) => sum + row.income, 0);
    const totalExpenses = rows.reduce((sum, row) => sum + row.expense, 0);
    const netProfit = totalIncome - totalExpenses;

    const incomeCategoryTotals = new Map<string, number>();
    currentIncomes.forEach((item) => {
      const category = item.incomeCategory?.name || 'Uncategorized';
      incomeCategoryTotals.set(
        category,
        (incomeCategoryTotals.get(category) ?? 0) + item.amount,
      );
    });
    currentNoteEntries
      .filter((item) => item.type === 'income')
      .forEach((item) => {
        incomeCategoryTotals.set(
          item.category,
          (incomeCategoryTotals.get(item.category) ?? 0) + item.amount,
        );
      });

    const expenseCategoryTotals = new Map<string, number>();
    currentExpenses.forEach((item) => {
      const category = item.expenseCategory?.name || 'Uncategorized';
      expenseCategoryTotals.set(
        category,
        (expenseCategoryTotals.get(category) ?? 0) + item.amount,
      );
    });
    currentNoteEntries
      .filter((item) => item.type === 'expense')
      .forEach((item) => {
        expenseCategoryTotals.set(
          item.category,
          (expenseCategoryTotals.get(item.category) ?? 0) + item.amount,
        );
      });

    return {
      period,
      generatedFor: this.formatGeneratedFor(currentRange, query, period),
      summary: {
        totalIncome,
        totalExpenses,
        netProfit,
        incomeChange: this.calculateChange(
          totalIncome,
          previousIncome + previousNoteIncome,
        ),
        expenseChange: this.calculateChange(
          totalExpenses,
          previousExpense + previousNoteExpense,
        ),
        profitChange: this.calculateChange(
          netProfit,
          previousIncome +
            previousNoteIncome -
            previousExpense -
            previousNoteExpense,
        ),
      },
      previousSummary: {
        totalIncome: previousIncome + previousNoteIncome,
        totalExpenses: previousExpense + previousNoteExpense,
        netProfit:
          previousIncome +
          previousNoteIncome -
          previousExpense -
          previousNoteExpense,
      },
      rows,
      categoryData: this.mapCategorySlices(incomeCategoryTotals, [
        '#10b981',
        '#3b82f6',
        '#8b5cf6',
        '#f59e0b',
        '#ef4444',
        '#06b6d4',
      ]),
      expenseCategoryData: this.mapCategorySlices(expenseCategoryTotals, [
        '#ef4444',
        '#f97316',
        '#f59e0b',
        '#eab308',
        '#06b6d4',
        '#8b5cf6',
      ]),
      topIncomeRow:
        [...rows].sort((left, right) => right.income - left.income)[0] ?? null,
      topExpenseRow:
        [...rows].sort((left, right) => right.expense - left.expense)[0] ??
        null,
      topIncomeCategory:
        [...incomeCategoryTotals.entries()].sort(
          (left, right) => right[1] - left[1],
        )[0]?.[0] ?? 'None',
      topExpenseCategory:
        [...expenseCategoryTotals.entries()].sort(
          (left, right) => right[1] - left[1],
        )[0]?.[0] ?? 'None',
      noteContext: this.buildRelevantNoteContext(currentNotes, currentNoteEntries),
      income: [
        ...currentIncomes.map((item) => ({
          id: item.id,
          amount: item.amount,
          date: format(new Date(item.date), 'yyyy-MM-dd'),
          note: item.note,
          category: item.incomeCategory?.name || 'Uncategorized',
          source: 'table' as const,
        })),
        ...currentNoteEntries
          .filter((item) => item.type === 'income')
          .map((item) => ({
            id: item.id,
            amount: item.amount,
            date: format(item.date, 'yyyy-MM-dd'),
            note: `Selected note income from ${item.category}`,
            category: item.category,
            source: 'selected_note' as const,
          })),
      ] satisfies DetailedIncomeItem[],
      expenses: [
        ...currentExpenses.map((item) => ({
          id: item.id,
          amount: item.amount,
          date: format(new Date(item.date), 'yyyy-MM-dd'),
          note: item.note,
          category: item.expenseCategory?.name || 'Uncategorized',
          source: 'table' as const,
        })),
        ...currentNoteEntries
          .filter((item) => item.type === 'expense')
          .map((item) => ({
            id: item.id,
            amount: item.amount,
            date: format(item.date, 'yyyy-MM-dd'),
            note: `Selected note expense from ${item.category}`,
            category: item.category,
            source: 'selected_note' as const,
          })),
      ] satisfies DetailedExpenseItem[],
      notes: currentNotes.map((note) => ({
        id: note.id,
        title: note.title,
        content: note.content,
        created_at: format(new Date(note.created_at), 'yyyy-MM-dd'),
      })) satisfies DetailedNoteItem[],
    };
  }

  private resolveCurrentRange({
    query,
    incomes,
    expenses,
    noteEntries,
    period,
  }: {
    query: ReportQueryDto;
    incomes: Income[];
    expenses: Expense[];
    noteEntries: ParsedSelectedNoteEntry[];
    period: ReportPeriod;
  }) {
    if (query.start_date && query.end_date) {
      return {
        start: startOfDay(new Date(query.start_date)),
        end: endOfDay(new Date(query.end_date)),
      };
    }

    const anchorDate = this.resolveAnchorDate(
      incomes,
      expenses,
      noteEntries,
      period,
    );

    return period === 'weekly'
      ? {
          start: startOfWeek(anchorDate, { weekStartsOn: 1 }),
          end: endOfWeek(anchorDate, { weekStartsOn: 1 }),
        }
      : {
          start: startOfMonth(anchorDate),
          end: endOfMonth(anchorDate),
        };
  }

  private resolvePreviousRange(
    currentRange: Range,
    query: ReportQueryDto,
    period: ReportPeriod,
  ) {
    if (query.start_date && query.end_date) {
      const dayCount = differenceInCalendarDays(
        startOfDay(currentRange.end),
        startOfDay(currentRange.start),
      );
      const previousEnd = endOfDay(subDays(currentRange.start, 1));
      const previousStart = startOfDay(subDays(currentRange.start, dayCount + 1));
      return {
        start: previousStart,
        end: previousEnd,
      };
    }

    const anchor = currentRange.start;
    return period === 'weekly'
      ? {
          start: startOfWeek(subWeeks(anchor, 1), { weekStartsOn: 1 }),
          end: endOfWeek(subWeeks(anchor, 1), { weekStartsOn: 1 }),
        }
      : {
          start: startOfMonth(subMonths(anchor, 1)),
          end: endOfMonth(subMonths(anchor, 1)),
        };
  }

  private resolveAnchorDate(
    incomes: Income[],
    expenses: Expense[],
    noteEntries: ParsedSelectedNoteEntry[],
    period: ReportPeriod,
  ) {
    const records = [
      ...incomes.map((item) => new Date(item.date)),
      ...expenses.map((item) => new Date(item.date)),
      ...noteEntries.map((item) => item.date),
    ];
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
      .filter(
        (date) =>
          !Number.isNaN(date.getTime()) && date.getTime() <= today.getTime(),
      )
      .sort((left, right) => right.getTime() - left.getTime())[0];

    return latestNonFuture ?? today;
  }

  private formatGeneratedFor(
    range: Range,
    query: ReportQueryDto,
    period: ReportPeriod,
  ) {
    if (query.start_date && query.end_date) {
      return `${format(range.start, 'MMM d, yyyy')} - ${format(range.end, 'MMM d, yyyy')}`;
    }

    return period === 'weekly'
      ? `${format(range.start, 'MMM d')} - ${format(range.end, 'MMM d, yyyy')}`
      : format(range.start, 'MMMM yyyy');
  }

  private findTopCategory(
    dayIncomes: Income[],
    dayExpenses: Expense[],
    dayNoteEntries: ParsedSelectedNoteEntry[],
  ) {
    const totals = new Map<string, number>();

    dayIncomes.forEach((item) => {
      const name = item.incomeCategory?.name || 'Income';
      totals.set(name, (totals.get(name) ?? 0) + item.amount);
    });

    dayExpenses.forEach((item) => {
      const name = item.expenseCategory?.name || 'Expense';
      totals.set(name, (totals.get(name) ?? 0) + item.amount);
    });

    dayNoteEntries.forEach((item) => {
      totals.set(item.category, (totals.get(item.category) ?? 0) + item.amount);
    });

    return (
      [...totals.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ||
      'No activity'
    );
  }

  private mapCategorySlices(totals: Map<string, number>, colors: string[]) {
    const grandTotal = [...totals.values()].reduce((sum, value) => sum + value, 0);

    return [...totals.entries()]
      .sort((left, right) => right[1] - left[1])
      .map(([name, value], index) => ({
        name,
        value: grandTotal ? Math.round((value / grandTotal) * 100) : 0,
        color: colors[index % colors.length],
      }));
  }

  private calculateChange(current: number, previous: number) {
    if (previous === 0) {
      return current === 0 ? 0 : null;
    }

    return ((current - previous) / previous) * 100;
  }

  private buildRelevantNoteContext(
    notes: Note[],
    parsedNoteEntries: ParsedSelectedNoteEntry[],
  ) {
    const entryMap = new Map(parsedNoteEntries.map((item) => [item.id, item]));

    return notes
      .filter((note) => entryMap.has(note.id))
      .slice(0, 3)
      .map((note) => {
        const entry = entryMap.get(note.id);
        if (!entry) {
          return `${note.title}: ${note.content}`;
        }

        return `${format(entry.date, 'MMM d, yyyy')} ${entry.type} ${entry.amount.toFixed(2)} from ${entry.category}`;
      })
      .join(' | ');
  }

  private parseSelectedNoteEntries(notes: Note[]) {
    return notes
      .map((note) => {
        const combinedText = `${note.title ?? ''} ${note.content ?? ''}`.trim();
        const normalizedText = combinedText.toLowerCase();
        const type = this.detectNoteEntryType(normalizedText);
        const amount = this.extractAmountFromNote(combinedText);
        const date = new Date(note.updated_at ?? note.created_at);

        if (!type || amount === null || Number.isNaN(date.getTime())) {
          return null;
        }

        return {
          id: note.id,
          type,
          amount,
          date,
          category: note.title?.trim() || (type === 'income' ? 'Income' : 'Expense'),
        } satisfies ParsedSelectedNoteEntry;
      })
      .filter((item): item is ParsedSelectedNoteEntry => Boolean(item));
  }

  private detectNoteEntryType(value: string): 'income' | 'expense' | null {
    const incomeKeywords = [
      'income',
      'revenue',
      'sale',
      'sales',
      'payment received',
      'paid by client',
      'received',
      'earning',
      'earnings',
      'cash in',
      'profit',
    ];
    const expenseKeywords = [
      'expense',
      'expenses',
      'cost',
      'costs',
      'bill',
      'bills',
      'paid for',
      'spent',
      'spend',
      'marketing',
      'debt',
      'cash out',
    ];

    const hasIncomeKeyword = incomeKeywords.some((keyword) =>
      value.includes(keyword),
    );
    const hasExpenseKeyword = expenseKeywords.some((keyword) =>
      value.includes(keyword),
    );

    if (hasIncomeKeyword && !hasExpenseKeyword) {
      return 'income';
    }

    if (hasExpenseKeyword && !hasIncomeKeyword) {
      return 'expense';
    }

    if (value.includes('income')) {
      return 'income';
    }

    if (value.includes('expense')) {
      return 'expense';
    }

    return null;
  }

  private extractAmountFromNote(value: string): number | null {
    const matches = value.match(
      /(?:rs\.?|lkr|\$)?\s*([0-9]+(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)/gi,
    );

    if (!matches?.length) {
      return null;
    }

    const parsedAmounts = matches
      .map((item) =>
        Number.parseFloat(item.replace(/[^0-9.,]/g, '').replace(/,/g, '')),
      )
      .filter(
        (item) =>
          Number.isFinite(item) &&
          item > 0 &&
          item < 100000000 &&
          !(Number.isInteger(item) && item >= 1900 && item <= 2100),
      );

    return parsedAmounts.length ? parsedAmounts[0] : null;
  }

  private buildFallbackSummary(
    report: Awaited<ReturnType<ReportsService['buildReport']>>,
  ) {
    const totalIncome = report.summary.totalIncome;
    const totalExpenses = report.summary.totalExpenses;
    const netProfit = report.summary.netProfit;
    const direction = netProfit >= 0 ? 'profit' : 'loss';
    const noteContext = report.noteContext?.trim() ?? '';
    const noteContextLower = noteContext.toLowerCase();
    const positive =
      totalIncome >= totalExpenses
        ? `Income is ahead of expenses in ${report.generatedFor}, led by ${report.topIncomeCategory || 'the strongest income category'}.`
        : `There is still a revenue base in ${report.topIncomeCategory || 'your top income category'} that can be reinforced.`;
    const watchOut =
      report.summary.expenseChange !== null && report.summary.expenseChange > 0
        ? `Expenses are rising, especially around ${report.topExpenseCategory}.`
        : `Watch the ${report.topExpenseCategory} category to keep margin stable next period.`;
    const positiveWithNotes =
      noteContext &&
      ['income', 'sale', 'sales', 'revenue', 'payment', 'cash', 'client'].some(
        (keyword) => noteContextLower.includes(keyword),
      )
        ? `${positive} Selected notes also mention: ${noteContext}.`
        : positive;
    const watchOutWithNotes =
      noteContext &&
      [
        'expense',
        'expenses',
        'cost',
        'costs',
        'bill',
        'bills',
        'debt',
        'marketing',
      ].some((keyword) => noteContextLower.includes(keyword))
        ? `${watchOut} Selected notes mention: ${noteContext}.`
        : watchOut;

    return {
      summary: [
        `SUMMARY: For ${report.generatedFor}, total income is ${totalIncome.toFixed(2)}, total expenses are ${totalExpenses.toFixed(2)}, and net ${direction} is ${Math.abs(netProfit).toFixed(2)}.`,
        `POSITIVE: ${positiveWithNotes}`,
        `WATCHOUT: ${watchOutWithNotes}`,
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

  private buildFileSuffix(query: ReportQueryDto) {
    if (query.start_date && query.end_date) {
      return `${query.start_date}_to_${query.end_date}`;
    }

    return query.period ?? 'weekly';
  }

  private buildSimplePdf(lines: string[]) {
    const sanitizedLines = lines.map((line) =>
      line
        .replace(/\\/g, '\\\\')
        .replace(/\(/g, '\\(')
        .replace(/\)/g, '\\)'),
    );

    const contentStream = [
      'BT',
      '/F1 12 Tf',
      '50 780 Td',
      ...sanitizedLines.flatMap((line, index) =>
        index === 0
          ? [`(${line}) Tj`]
          : ['0 -16 Td', `(${line}) Tj`],
      ),
      'ET',
    ].join('\n');

    const objects = [
      '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
      '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
      '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj',
      '4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj',
      `5 0 obj << /Length ${Buffer.byteLength(contentStream, 'utf8')} >> stream\n${contentStream}\nendstream endobj`,
    ];

    let pdf = '%PDF-1.4\n';
    const offsets: number[] = [0];
    objects.forEach((object) => {
      offsets.push(Buffer.byteLength(pdf, 'utf8'));
      pdf += `${object}\n`;
    });

    const xrefPosition = Buffer.byteLength(pdf, 'utf8');
    pdf += `xref\n0 ${objects.length + 1}\n`;
    pdf += '0000000000 65535 f \n';
    offsets.slice(1).forEach((offset) => {
      pdf += `${offset.toString().padStart(10, '0')} 00000 n \n`;
    });
    pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPosition}\n%%EOF`;

    return Buffer.from(pdf, 'utf8');
  }
}
