'use client';

/**
 * Payroll → Reports. Each report is the same table on screen as in the Excel
 * file (src/lib/payroll-report-tables.ts). On screen, TINs and SSNIT numbers
 * show their last digits only; the exported schedules carry them in full,
 * and every export is recorded.
 */

import { useMemo, useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Money } from '@/components/ui/money';
import { exportGroupPayrollReport, exportPayrollReport } from '@/app/actions/payroll';
import { Banner, download, fieldLabel, selectClass, todayIso } from '@/components/app/payroll-ui';
import type { CasualLabourFact, PayRunRecord, RemittanceRecord, StaffLoanRecord } from '@/lib/data/payroll';
import type { EntityRecord, ProjectRecord } from '@/lib/data/types';
import { entityReportTable, entityReports, groupReportTable, groupReports, reportLabels, type EntityReport, type GroupReport, type ReportTable } from '@/lib/payroll-report-tables';
import type { PayLineFact } from '@/lib/payroll-reports';

type Props = {
  entity: EntityRecord;
  entities: EntityRecord[];
  factsByEntity: Record<string, PayLineFact[]>;
  casualByEntity: Record<string, CasualLabourFact[]>;
  remittances: RemittanceRecord[];
  ledger: Record<string, number>;
  loans: StaffLoanRecord[];
  projects: ProjectRecord[];
  runs: PayRunRecord[];
};

const xlsx = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export function PayrollReports({ entity, entities, factsByEntity, casualByEntity, remittances, ledger, loans, projects, runs }: Props) {
  const latestPosted = runs.find((r) => r.status === 'posted')?.period ?? todayIso().slice(0, 7);
  const [report, setReport] = useState<EntityReport | GroupReport>('paye');
  const [period, setPeriod] = useState(latestPosted);
  const [from, setFrom] = useState(`${latestPosted.slice(0, 4)}-01`);
  const [to, setTo] = useState(latestPosted);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const isGroup = (groupReports as readonly string[]).includes(report);

  const table: ReportTable = useMemo(() => {
    if (isGroup) {
      return groupReportTable(report as GroupReport, {
        from,
        to,
        entityNames: Object.fromEntries(entities.map((e) => [e.id, e.name])),
        facts: Object.values(factsByEntity).flat(),
        casual: Object.values(casualByEntity).flat(),
      });
    }
    return entityReportTable(report as EntityReport, {
      entityName: entity.name,
      period,
      facts: factsByEntity[entity.id] ?? [],
      projectNames: Object.fromEntries(projects.map((p) => [p.id, `${p.code} · ${p.name}`])),
      openRemittances: remittances.filter((r) => !r.paidOn && !r.cancelled).map((r) => ({ kind: r.kind, amountMinor: r.amountMinor })),
      ledgerBalances: ledger,
      loansOutstandingMinor: loans.reduce((sum, loan) => sum + loan.outstandingMinor, 0),
    });
  }, [isGroup, report, from, to, period, entities, factsByEntity, casualByEntity, entity, projects, remittances, ledger, loans]);

  function exportIt() {
    setMessage(null);
    startTransition(async () => {
      const result = isGroup ? await exportGroupPayrollReport(report as GroupReport, from, to) : await exportPayrollReport(entity.id, report as EntityReport, period);
      if (!result.ok) return setMessage({ tone: 'error', text: result.error });
      download(result.value.fileName, result.value.base64, xlsx);
      setMessage({ tone: 'ok', text: `${result.value.fileName} downloaded.` });
    });
  }

  return (
    <div className="space-y-5">
      <Card className="rounded-2xl">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[260px]">
            <label className={fieldLabel} htmlFor="rp-kind">Report</label>
            <select id="rp-kind" className={selectClass} value={report} onChange={(e) => setReport(e.target.value as EntityReport | GroupReport)}>
              <optgroup label={`${entity.name} — statutory`}>
                {(['paye', 'ssnit', 'tier3'] as const).map((r) => (
                  <option key={r} value={r}>{reportLabels[r]}</option>
                ))}
              </optgroup>
              <optgroup label={`${entity.name} — management`}>
                {entityReports
                  .filter((r) => !['paye', 'ssnit', 'tier3'].includes(r))
                  .map((r) => (
                    <option key={r} value={r}>{reportLabels[r]}</option>
                  ))}
              </optgroup>
              <optgroup label="Every company you can see">
                {groupReports.map((r) => (
                  <option key={r} value={r}>{reportLabels[r]}</option>
                ))}
              </optgroup>
            </select>
          </div>
          {isGroup ? (
            <>
              <div>
                <label className={fieldLabel} htmlFor="rp-from">From</label>
                <Input id="rp-from" type="month" value={from} onChange={(e) => setFrom(e.target.value)} />
              </div>
              <div>
                <label className={fieldLabel} htmlFor="rp-to">To</label>
                <Input id="rp-to" type="month" value={to} onChange={(e) => setTo(e.target.value)} />
              </div>
            </>
          ) : report !== 'reconciliation' ? (
            <div>
              <label className={fieldLabel} htmlFor="rp-period">{report === 'year-to-date' ? 'Year to the end of' : 'Pay period'}</label>
              <Input id="rp-period" type="month" value={period} onChange={(e) => setPeriod(e.target.value)} />
            </div>
          ) : null}
          <Button variant="secondary" disabled={pending} onClick={exportIt}>Export to Excel</Button>
        </div>
      </Card>

      <Banner message={message} />

      <Card className="rounded-2xl">
        <h4 className="text-base font-semibold text-slate-900">{table.title}</h4>
        {table.notes.map((note) => (
          <p key={note} className="mt-1 text-sm text-slate-600">{note}</p>
        ))}
        {table.warnings.length ? (
          <div className="mt-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            {table.warnings.map((warning) => (
              <p key={warning}>{warning}</p>
            ))}
          </div>
        ) : null}
        <div className="mt-4 overflow-x-auto">
          {table.rows.length === 0 ? (
            <p className="text-sm text-slate-500">Nothing posted for this yet.</p>
          ) : (
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                  {table.columns.map((c) => (
                    <th key={c.key} className={['pb-2 pr-3 font-medium', c.kind === 'text' ? '' : 'text-right'].join(' ')}>{c.header}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {table.rows.map((row, index) => (
                  <tr key={index} className={row.status === 'DIFFERENCE' ? 'bg-rose-50 font-semibold text-rose-900' : ''}>
                    {table.columns.map((c) => (
                      <td key={c.key} className={['py-1.5 pr-3', c.kind === 'text' ? '' : 'text-right tabular-nums'].join(' ')}>
                        {row[c.key] === null || row[c.key] === undefined ? '—' : c.kind === 'money' ? <Money value={Number(row[c.key])} /> : String(row[c.key])}
                      </td>
                    ))}
                  </tr>
                ))}
                {table.totals ? (
                  <tr className="border-t-2 border-slate-300 font-semibold">
                    {table.columns.map((c, index) => (
                      <td key={c.key} className={['py-1.5 pr-3', c.kind === 'text' ? '' : 'text-right tabular-nums'].join(' ')}>
                        {index === 0 ? 'Total' : c.kind === 'money' && table.totals![c.key] !== undefined ? <Money value={table.totals![c.key]} /> : ''}
                      </td>
                    ))}
                  </tr>
                ) : null}
              </tbody>
            </table>
          )}
        </div>
      </Card>
    </div>
  );
}
