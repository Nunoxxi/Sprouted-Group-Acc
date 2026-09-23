'use client';

/**
 * Mobile money and farmer payments: the wallets, the statements imported
 * into them, the batches that pay many farmers at once, the farmers
 * themselves with what they owe and are owed, and one farmer's history.
 * Every change goes through src/app/actions/momo.ts.
 */

import { useMemo, useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Money } from '@/components/ui/money';
import { MaskedDetail, revealForEditing } from '@/components/app/reveal';
import {
  addDefaultStatementMappings,
  createPaymentBatch,
  createWallet,
  exportPaymentBatch,
  farmerHistoryReport,
  importStatement,
  markBatchPaid,
  matchStatementLine,
  noteStatementLine,
  recordFarmerAdvance,
  saveFarmer,
  type FarmerHistoryReport,
} from '@/app/actions/momo';
import type { Permission } from '@/lib/authz';
import type {
  AgentPurchaseRecord,
  BankAccountRecord,
  BuyingAgentRecord,
  EntityRecord,
  FarmerAdvanceRecord,
  FarmerRecord,
  ItemRecord,
  PaymentBatchRecord,
  StatementImportRecord,
  StatementMappingRecord,
} from '@/lib/data/types';
import { formatKg } from '@/lib/inventory';
import { bankAccountKindLabels } from '@/lib/momo';
import { holdsStock } from '@/lib/trading';

type Props = {
  entity: EntityRecord;
  bankAccounts: BankAccountRecord[];
  farmers: FarmerRecord[];
  advances: FarmerAdvanceRecord[];
  batches: PaymentBatchRecord[];
  mappings: StatementMappingRecord[];
  statements: StatementImportRecord[];
  purchases: AgentPurchaseRecord[];
  agents: BuyingAgentRecord[];
  items: ItemRecord[];
  allowed: (permission: Permission) => boolean;
};

type Tab = 'Statements' | 'Batches' | 'Farmers' | 'Wallets';
const allTabs: Tab[] = ['Statements', 'Batches', 'Farmers', 'Wallets'];
const selectClass = 'min-h-[44px] w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:bg-slate-50';
const label = 'mb-1.5 block text-sm font-medium text-slate-700';
const todayIso = () => new Date().toISOString().slice(0, 10);
const toMinor = (text: string) => Math.round(Number(text.replace(/,/g, '')) * 100);

export function PaymentsPanel({ entity, bankAccounts, farmers, advances, batches, mappings, statements, purchases, agents, items, allowed }: Props) {
  const trader = holdsStock(entity.type);
  const tabs = trader ? allTabs : (['Statements', 'Wallets'] as Tab[]);
  const [tab, setTab] = useState<Tab>('Statements');
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const today = todayIso();

  const wallets = bankAccounts.filter((account) => account.kind === 'mobile-money');
  const farmerById = useMemo(() => new Map(farmers.map((f) => [f.id, f])), [farmers]);
  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const batchById = useMemo(() => new Map(batches.map((b) => [b.id, b])), [batches]);

  /** Posted purchases left payable, with nothing paid on them yet. */
  const unpaid = purchases.filter((p) => p.status === 'posted' && p.settlement === 'payable' && p.paidMinor < p.payableMinor);

  function run(okText: string, action: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) {
    setMessage(null);
    startTransition(async () => {
      const result = await action();
      if (result.ok) {
        setMessage({ tone: 'ok', text: okText });
        after?.();
      } else setMessage({ tone: 'error', text: result.error ?? 'Something went wrong.' });
    });
  }

  // --- forms -------------------------------------------------------------------

  const [walletForm, setWalletForm] = useState({ name: '', provider: 'MTN MoMo', number: '' });
  const [farmerForm, setFarmerForm] = useState({ id: '', name: '', phone: '', community: '', district: '', walletNumber: '' });
  const [advanceForm, setAdvanceForm] = useState({ farmerId: '', date: today, amount: '', bankAccountId: bankAccounts[0]?.id ?? '', note: '' });
  const [batchForm, setBatchForm] = useState({ date: today, bankAccountId: wallets[0]?.id ?? bankAccounts[0]?.id ?? '', note: '' });
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [importForm, setImportForm] = useState({ bankAccountId: wallets[0]?.id ?? bankAccounts[0]?.id ?? '', mappingId: mappings[0]?.id ?? '', fileName: '', csv: '' });
  const [importErrors, setImportErrors] = useState<{ row: number; message: string }[]>([]);
  const [matching, setMatching] = useState<Record<string, string>>({});
  const [paying, setPaying] = useState<{ id: string; date: string; fee: string } | null>(null);
  const [history, setHistory] = useState<FarmerHistoryReport | null>(null);

  function toggle(id: string) {
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function download(fileName: string, csv: string) {
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  const chosenTotal = unpaid.filter((p) => chosen.has(p.id)).reduce((s, p) => s + p.payableMinor - p.paidMinor, 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{entity.name}</p>
          <h2 className="mt-1 text-2xl font-semibold text-slate-900">Mobile money &amp; farmer payments</h2>
          <p className="mt-1 text-sm text-slate-600">
            Wallets reconcile like any bank account. Fees and levies post to charges, so nothing is left as an unexplained difference.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {tabs.map((name) => (
            <Button key={name} size="sm" variant={tab === name ? 'primary' : 'secondary'} onClick={() => setTab(name)}>
              {name}
            </Button>
          ))}
        </div>
      </div>

      {message ? (
        <div className={['rounded-xl border px-4 py-3 text-sm', message.tone === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-rose-200 bg-rose-50 text-rose-900'].join(' ')}>
          {message.text}
        </div>
      ) : null}

      {/* --- statements ------------------------------------------------------- */}
      {tab === 'Statements' ? (
        <div className="space-y-6">
          <Card className="rounded-2xl">
            <h3 className="text-lg font-semibold text-slate-900">Import a statement</h3>
            <p className="mt-1 text-sm text-slate-600">
              The fee and levy come off each line, so a line still matches the payment it settled; all of it posts to Mobile Money Charges &amp; Levies in one go.
            </p>
            {mappings.length === 0 ? (
              <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                No statement mappings yet.{' '}
                {allowed('rates:manage') ? (
                  <Button size="sm" variant="secondary" disabled={pending} onClick={() => run('Provider mappings added.', () => addDefaultStatementMappings(entity.id))}>
                    Add the provider mappings
                  </Button>
                ) : (
                  'Ask an Accountant to add them.'
                )}
              </div>
            ) : (
              <div className="mt-4 grid gap-4 md:grid-cols-3">
                <div>
                  <label className={label}>Wallet or bank account</label>
                  <select className={selectClass} value={importForm.bankAccountId} onChange={(e) => setImportForm((f) => ({ ...f, bankAccountId: e.target.value }))}>
                    {bankAccounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.name} — {bankAccountKindLabels[account.kind]}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={label}>Statement format</label>
                  <select className={selectClass} value={importForm.mappingId} onChange={(e) => setImportForm((f) => ({ ...f, mappingId: e.target.value }))}>
                    {mappings.map((mapping) => (
                      <option key={mapping.id} value={mapping.id}>
                        {mapping.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={label}>CSV file</label>
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    className="min-h-[44px] w-full text-sm text-slate-700 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm"
                    onChange={async (event) => {
                      const file = event.target.files?.[0];
                      if (!file) return;
                      const csv = await file.text();
                      setImportForm((f) => ({ ...f, fileName: file.name, csv }));
                    }}
                  />
                </div>
              </div>
            )}
            {importForm.csv ? (
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <span className="text-sm text-slate-600">{importForm.fileName}</span>
                <Button
                  size="sm"
                  disabled={pending || !allowed('document:post')}
                  onClick={() => {
                    setImportErrors([]);
                    setMessage(null);
                    startTransition(async () => {
                      const result = await importStatement(entity.id, importForm);
                      if (result.ok) {
                        setImportErrors(result.value.errors);
                        setMessage({ tone: 'ok', text: `${result.value.statement.lineCount} lines imported, ${result.value.matched} batch${result.value.matched === 1 ? '' : 'es'} matched.` });
                        setImportForm((f) => ({ ...f, fileName: '', csv: '' }));
                      } else setMessage({ tone: 'error', text: result.error });
                    });
                  }}
                >
                  Import
                </Button>
              </div>
            ) : null}
            {importErrors.length ? (
              <ul className="mt-4 space-y-1 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                {importErrors.map((error) => (
                  <li key={`${error.row}-${error.message}`}>
                    Row {error.row}: {error.message}
                  </li>
                ))}
              </ul>
            ) : null}
          </Card>

          {statements.map((statement) => (
            <Card key={statement.id} className="rounded-2xl">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <div>
                  <h3 className="text-lg font-semibold text-slate-900">{statement.fileName}</h3>
                  <p className="text-sm text-slate-600">
                    {statement.bankAccountName} · {statement.fromDate} to {statement.toDate} · {statement.lineCount} lines · imported by {statement.createdByName}
                  </p>
                </div>
                <div className="text-sm text-slate-600">
                  Charges posted: <Money value={statement.feeMinor} />
                </div>
              </div>
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-[11px] uppercase tracking-[0.12em] text-slate-500">
                    <tr>
                      <th className="py-2">Date</th>
                      <th className="py-2">Description</th>
                      <th className="py-2 text-right">Amount</th>
                      <th className="py-2 text-right">Fee + levy</th>
                      <th className="py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {statement.lines.map((line) => (
                      <tr key={line.id}>
                        <td className="py-2 whitespace-nowrap text-slate-600">{line.date}</td>
                        <td className="py-2">
                          <span className="text-slate-900">{line.description}</span>
                          {line.reference ? <span className="ml-2 font-mono text-xs text-slate-500">{line.reference}</span> : null}
                          {line.note ? <span className="ml-2 text-xs text-slate-500">— {line.note}</span> : null}
                        </td>
                        <td className="py-2 text-right">
                          <Money value={line.amountMinor} />
                        </td>
                        <td className="py-2 text-right text-slate-600">
                          <Money value={line.feeMinor + line.levyMinor} />
                        </td>
                        <td className="py-2">
                          {line.status === 'matched' ? (
                            <span className="text-emerald-700">Matched to {batchById.get(line.matchedBatchId ?? '')?.reference ?? 'a batch'}</span>
                          ) : line.status === 'charge' ? (
                            <span className="text-slate-500">Charge — posted</span>
                          ) : (
                            <div className="flex flex-wrap items-center gap-2">
                              <select className="min-h-[36px] rounded-lg border border-slate-200 bg-white px-2 text-xs" value={matching[line.id] ?? ''} onChange={(e) => setMatching((m) => ({ ...m, [line.id]: e.target.value }))}>
                                <option value="">Match to a batch…</option>
                                {batches
                                  .filter((batch) => batch.status !== 'paid' && batch.bankAccountId === statement.bankAccountId)
                                  .map((batch) => (
                                    <option key={batch.id} value={batch.id}>
                                      {batch.reference} — {(batch.totalMinor / 100).toFixed(2)}
                                    </option>
                                  ))}
                              </select>
                              <Button
                                size="sm"
                                variant="secondary"
                                disabled={pending || !matching[line.id] || !allowed('document:post')}
                                onClick={() => run('Batch matched and settled.', () => matchStatementLine(entity.id, line.id, matching[line.id]))}
                              >
                                Match
                              </Button>
                              <Button size="sm" variant="ghost" disabled={pending || !allowed('document:post')} onClick={() => {
                                const note = window.prompt('What is this line?');
                                if (note !== null) run('Line noted.', () => noteStatementLine(entity.id, line.id, note));
                              }}>
                                Note
                              </Button>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ))}
        </div>
      ) : null}

      {/* --- batches ---------------------------------------------------------- */}
      {tab === 'Batches' && trader ? (
        <div className="space-y-6">
          <Card className="rounded-2xl">
            <h3 className="text-lg font-semibold text-slate-900">Pay many farmers at once</h3>
            <p className="mt-1 text-sm text-slate-600">
              Purchases the agent left for us to pay. Any advance was already recovered when the purchase was posted, so these are net amounts.
            </p>
            {unpaid.length === 0 ? (
              <p className="mt-4 text-sm text-slate-500">Nothing is waiting to be paid.</p>
            ) : (
              <>
                <div className="mt-4 grid gap-4 md:grid-cols-3">
                  <div>
                    <label className={label}>Pay on</label>
                    <Input type="date" value={batchForm.date} onChange={(e) => setBatchForm((f) => ({ ...f, date: e.target.value }))} />
                  </div>
                  <div>
                    <label className={label}>From</label>
                    <select className={selectClass} value={batchForm.bankAccountId} onChange={(e) => setBatchForm((f) => ({ ...f, bankAccountId: e.target.value }))}>
                      {bankAccounts.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.name} — {bankAccountKindLabels[account.kind]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className={label}>Note</label>
                    <Input value={batchForm.note} onChange={(e) => setBatchForm((f) => ({ ...f, note: e.target.value }))} placeholder="Week 12 cashew" />
                  </div>
                </div>
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-left text-[11px] uppercase tracking-[0.12em] text-slate-500">
                      <tr>
                        <th className="py-2 w-10" />
                        <th className="py-2">Farmer</th>
                        <th className="py-2">Delivery</th>
                        <th className="py-2 text-right">Gross</th>
                        <th className="py-2 text-right">Advance recovered</th>
                        <th className="py-2 text-right">To pay</th>
                        <th className="py-2">Wallet</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {unpaid.map((purchase) => {
                        const farmer = purchase.farmerId ? farmerById.get(purchase.farmerId) : undefined;
                        return (
                          <tr key={purchase.id}>
                            <td className="py-2">
                              <input type="checkbox" checked={chosen.has(purchase.id)} onChange={() => toggle(purchase.id)} className="h-4 w-4" />
                            </td>
                            <td className="py-2 text-slate-900">
                              {purchase.farmerName}
                              {purchase.advanceRemainingMinor > 0 ? (
                                <span className="ml-2 text-xs text-amber-700">
                                  still owes <Money value={purchase.advanceRemainingMinor} />
                                </span>
                              ) : null}
                            </td>
                            <td className="py-2 text-slate-600">
                              {purchase.date} · {formatKg(purchase.grams)} {itemById.get(purchase.itemId)?.name ?? ''} · {agentById.get(purchase.agentId)?.name ?? ''}
                            </td>
                            <td className="py-2 text-right">
                              <Money value={purchase.priceMinor} />
                            </td>
                            <td className="py-2 text-right text-slate-600">
                              <Money value={purchase.recoveredMinor} />
                            </td>
                            <td className="py-2 text-right font-semibold">
                              <Money value={purchase.payableMinor - purchase.paidMinor} />
                            </td>
                            <td className="py-2 font-mono text-xs text-slate-600">
                              {farmer?.walletNumber ? (
                                <MaskedDetail entityId={entity.id} subjectKind="farmer" subjectId={farmer.id} field="Farmer.walletNumber" masked={farmer.walletNumber} allowed={allowed} />
                              ) : (
                                <span className="text-rose-600">no wallet</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <span className="text-sm text-slate-700">
                    {chosen.size} chosen, <Money value={chosenTotal} />
                  </span>
                  <Button
                    size="sm"
                    disabled={pending || chosen.size === 0 || !allowed('document:draft')}
                    onClick={() =>
                      run('Batch created.', () => createPaymentBatch(entity.id, { ...batchForm, purchaseIds: [...chosen] }), () => setChosen(new Set()))
                    }
                  >
                    Create batch
                  </Button>
                </div>
              </>
            )}
          </Card>

          {batches.map((batch) => (
            <Card key={batch.id} className="rounded-2xl">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <div>
                  <h3 className="text-lg font-semibold text-slate-900">
                    {batch.reference}
                    <span className="ml-3 text-sm font-normal text-slate-500">
                      {batch.date} · {batch.bankAccountName} · {batch.payments.length} farmer{batch.payments.length === 1 ? '' : 's'}
                    </span>
                  </h3>
                  {batch.note ? <p className="text-sm text-slate-600">{batch.note}</p> : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={[
                      'rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em]',
                      batch.status === 'paid' ? 'bg-emerald-100 text-emerald-800' : batch.status === 'exported' ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-700',
                    ].join(' ')}
                  >
                    {batch.status}
                  </span>
                  <Money value={batch.totalMinor} className="text-base font-semibold" />
                </div>
              </div>

              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-[11px] uppercase tracking-[0.12em] text-slate-500">
                    <tr>
                      <th className="py-2">Farmer</th>
                      <th className="py-2">Wallet</th>
                      <th className="py-2 text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {batch.payments.map((payment) => (
                      <tr key={payment.id}>
                        <td className="py-2 text-slate-900">{payment.farmerName}</td>
                        <td className="py-2 font-mono text-xs text-slate-600">
                          <MaskedDetail entityId={entity.id} subjectKind="farmer" subjectId={payment.farmerId} field="Farmer.walletNumber" masked={payment.walletNumber} allowed={allowed} empty="no wallet" />
                        </td>
                        <td className="py-2 text-right">
                          <Money value={payment.amountMinor} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {batch.status !== 'paid' ? (
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={pending || !allowed('document:post')}
                    onClick={() => {
                      setMessage(null);
                      startTransition(async () => {
                        const result = await exportPaymentBatch(entity.id, batch.id);
                        if (result.ok) {
                          download(result.value.fileName, result.value.csv);
                          setMessage({ tone: 'ok', text: `${batch.reference} exported for disbursement.` });
                        } else setMessage({ tone: 'error', text: result.error });
                      });
                    }}
                  >
                    Export for disbursement
                  </Button>
                  {paying?.id === batch.id ? (
                    <div className="flex flex-wrap items-end gap-2">
                      <div>
                        <label className={label}>Paid on</label>
                        <Input type="date" value={paying.date} onChange={(e) => setPaying({ ...paying, date: e.target.value })} />
                      </div>
                      <div>
                        <label className={label}>Fee charged</label>
                        <Input inputMode="decimal" value={paying.fee} onChange={(e) => setPaying({ ...paying, fee: e.target.value })} placeholder="0.00" />
                      </div>
                      <Button
                        size="sm"
                        disabled={pending}
                        onClick={() =>
                          run(`${batch.reference} settled.`, () => markBatchPaid(entity.id, batch.id, { date: paying.date, feeMinor: paying.fee ? toMinor(paying.fee) : 0 }), () => setPaying(null))
                        }
                      >
                        Confirm
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setPaying(null)}>
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <Button size="sm" variant="ghost" disabled={pending || !allowed('document:post')} onClick={() => setPaying({ id: batch.id, date: today, fee: '' })}>
                      Mark paid by hand
                    </Button>
                  )}
                  <span className="text-xs text-slate-500">If the statement is coming, import it instead — it matches and settles in one step.</span>
                </div>
              ) : null}
            </Card>
          ))}
        </div>
      ) : null}

      {/* --- farmers ---------------------------------------------------------- */}
      {tab === 'Farmers' && trader ? (
        <div className="space-y-6">
          <Card className="rounded-2xl">
            <h3 className="text-lg font-semibold text-slate-900">{farmerForm.id ? 'Edit farmer' : 'Add a farmer'}</h3>
            <div className="mt-4 grid gap-4 md:grid-cols-3">
              <div>
                <label className={label}>Name</label>
                <Input value={farmerForm.name} onChange={(e) => setFarmerForm((f) => ({ ...f, name: e.target.value }))} />
              </div>
              <div>
                <label className={label}>Phone</label>
                <Input value={farmerForm.phone} onChange={(e) => setFarmerForm((f) => ({ ...f, phone: e.target.value }))} />
              </div>
              <div>
                <label className={label}>Wallet number</label>
                <Input value={farmerForm.walletNumber} onChange={(e) => setFarmerForm((f) => ({ ...f, walletNumber: e.target.value }))} placeholder="0244000111" />
              </div>
              <div>
                <label className={label}>Community</label>
                <Input value={farmerForm.community} onChange={(e) => setFarmerForm((f) => ({ ...f, community: e.target.value }))} />
              </div>
              <div>
                <label className={label}>District</label>
                <Input value={farmerForm.district} onChange={(e) => setFarmerForm((f) => ({ ...f, district: e.target.value }))} />
              </div>
            </div>
            <div className="mt-4 flex gap-2">
              <Button
                size="sm"
                disabled={pending || !farmerForm.name.trim() || !allowed('stock:enter')}
                onClick={() =>
                  run('Farmer saved.', () => saveFarmer(entity.id, { ...farmerForm, id: farmerForm.id || undefined }), () => setFarmerForm({ id: '', name: '', phone: '', community: '', district: '', walletNumber: '' }))
                }
              >
                Save
              </Button>
              {farmerForm.id ? (
                <Button size="sm" variant="ghost" onClick={() => setFarmerForm({ id: '', name: '', phone: '', community: '', district: '', walletNumber: '' })}>
                  Cancel
                </Button>
              ) : null}
            </div>
          </Card>

          <Card className="rounded-2xl">
            <h3 className="text-lg font-semibold text-slate-900">Pre-season advance</h3>
            <p className="mt-1 text-sm text-slate-600">Recovered automatically from what we owe the farmer for their next deliveries.</p>
            <div className="mt-4 grid gap-4 md:grid-cols-4">
              <div>
                <label className={label}>Farmer</label>
                <select className={selectClass} value={advanceForm.farmerId} onChange={(e) => setAdvanceForm((f) => ({ ...f, farmerId: e.target.value }))}>
                  <option value="">Choose…</option>
                  {farmers.filter((f) => f.isActive).map((farmer) => (
                    <option key={farmer.id} value={farmer.id}>
                      {farmer.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className={label}>Date</label>
                <Input type="date" value={advanceForm.date} onChange={(e) => setAdvanceForm((f) => ({ ...f, date: e.target.value }))} />
              </div>
              <div>
                <label className={label}>Amount</label>
                <Input inputMode="decimal" value={advanceForm.amount} onChange={(e) => setAdvanceForm((f) => ({ ...f, amount: e.target.value }))} placeholder="500.00" />
              </div>
              <div>
                <label className={label}>From</label>
                <select className={selectClass} value={advanceForm.bankAccountId} onChange={(e) => setAdvanceForm((f) => ({ ...f, bankAccountId: e.target.value }))}>
                  {bankAccounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="mt-4">
              <Button
                size="sm"
                disabled={pending || !advanceForm.farmerId || !advanceForm.amount || !allowed('document:post')}
                onClick={() =>
                  run('Advance recorded.', () => recordFarmerAdvance(entity.id, { farmerId: advanceForm.farmerId, date: advanceForm.date, amountMinor: toMinor(advanceForm.amount), bankAccountId: advanceForm.bankAccountId, note: advanceForm.note }), () =>
                    setAdvanceForm((f) => ({ ...f, farmerId: '', amount: '' })),
                  )
                }
              >
                Record advance
              </Button>
            </div>
          </Card>

          <Card className="rounded-2xl">
            <h3 className="text-lg font-semibold text-slate-900">Farmers</h3>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-[11px] uppercase tracking-[0.12em] text-slate-500">
                  <tr>
                    <th className="py-2">Farmer</th>
                    <th className="py-2">Community</th>
                    <th className="py-2 text-right">Deliveries</th>
                    <th className="py-2 text-right">Weight</th>
                    <th className="py-2 text-right">Owes us</th>
                    <th className="py-2 text-right">We owe</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {farmers.map((farmer) => (
                    <tr key={farmer.id}>
                      <td className="py-2 text-slate-900">
                        {farmer.name}
                        {farmer.walletNumber ? (
                          <MaskedDetail entityId={entity.id} subjectKind="farmer" subjectId={farmer.id} field="Farmer.walletNumber" masked={farmer.walletNumber} allowed={allowed} className="ml-2 font-mono text-xs text-slate-500" />
                        ) : null}
                      </td>
                      <td className="py-2 text-slate-600">{[farmer.community, farmer.district].filter(Boolean).join(', ')}</td>
                      <td className="py-2 text-right text-slate-600">{farmer.deliveries}</td>
                      <td className="py-2 text-right text-slate-600">{formatKg(farmer.gramsTotal)}</td>
                      <td className="py-2 text-right">
                        <Money value={farmer.advanceOutstandingMinor} className={farmer.advanceOutstandingMinor > 0 ? 'text-amber-700' : ''} />
                      </td>
                      <td className="py-2 text-right">
                        <Money value={farmer.payableOutstandingMinor} className={farmer.payableOutstandingMinor > 0 ? 'text-rose-700' : ''} />
                      </td>
                      <td className="py-2 text-right">
                        <Button size="sm" variant="ghost" disabled={pending} onClick={() => {
                          setMessage(null);
                          startTransition(async () => {
                            const result = await farmerHistoryReport(entity.id, farmer.id);
                            if (result.ok) setHistory(result.value);
                            else setMessage({ tone: 'error', text: result.error });
                          });
                        }}>
                          History
                        </Button>
                        <Button size="sm" variant="ghost" disabled={pending} onClick={() => {
                          setMessage(null);
                          startTransition(async () => {
                            // The form holds real numbers, not dots, or saving
                            // it would write the mask back over the number.
                            const revealed = await revealForEditing(entity.id, 'farmer', farmer.id, ['Farmer.phone', 'Farmer.walletNumber']);
                            if (typeof revealed === 'string') { setMessage({ tone: 'error', text: revealed }); return; }
                            setFarmerForm({ id: farmer.id, name: farmer.name, phone: revealed['Farmer.phone'] ?? '', community: farmer.community, district: farmer.district, walletNumber: revealed['Farmer.walletNumber'] ?? '' });
                          });
                        }}>
                          Edit
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {history ? (
            <Card className="rounded-2xl">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <div>
                  <h3 className="text-lg font-semibold text-slate-900">{history.farmer.name}</h3>
                  <p className="text-sm text-slate-600">
                    {history.farmer.deliveries} deliveries · {formatKg(history.farmer.gramsTotal)} · gross <Money value={history.farmer.grossMinor} />
                  </p>
                </div>
                <Button size="sm" variant="ghost" onClick={() => setHistory(null)}>
                  Close
                </Button>
              </div>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
                  <p className="text-xs uppercase tracking-[0.12em] text-amber-800">Advances still to recover</p>
                  <Money value={history.farmer.advanceOutstandingMinor} className="text-lg font-semibold" />
                </div>
                <div className="rounded-xl border border-slate-200 px-4 py-3">
                  <p className="text-xs uppercase tracking-[0.12em] text-slate-600">Still to pay them</p>
                  <Money value={history.farmer.payableOutstandingMinor} className="text-lg font-semibold" />
                </div>
              </div>
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-[11px] uppercase tracking-[0.12em] text-slate-500">
                    <tr>
                      <th className="py-2">Date</th>
                      <th className="py-2">What happened</th>
                      <th className="py-2 text-right">Value</th>
                      <th className="py-2 text-right">Recovered</th>
                      <th className="py-2 text-right">Paid</th>
                      <th className="py-2">Evidence</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {history.events.map((event, index) => (
                      <tr key={`${event.date}-${index}`}>
                        <td className="py-2 whitespace-nowrap text-slate-600">{event.date}</td>
                        <td className="py-2 text-slate-900">
                          {event.kind === 'delivery' ? 'Delivered ' : event.kind === 'advance' ? 'Advance — ' : ''}
                          {event.description}
                        </td>
                        <td className="py-2 text-right">{event.grossMinor ? <Money value={event.grossMinor} /> : ''}</td>
                        <td className="py-2 text-right text-slate-600">{event.recoveredMinor ? <Money value={event.recoveredMinor} /> : ''}</td>
                        <td className="py-2 text-right">{event.paidMinor ? <Money value={event.paidMinor} /> : ''}</td>
                        <td className="py-2 text-xs text-slate-500">
                          {event.evidence}
                          {event.reference ? <span className="ml-2 font-mono">{event.reference}</span> : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ) : null}

          {advances.length ? (
            <Card className="rounded-2xl">
              <h3 className="text-lg font-semibold text-slate-900">Advances</h3>
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-[11px] uppercase tracking-[0.12em] text-slate-500">
                    <tr>
                      <th className="py-2">Date</th>
                      <th className="py-2">Farmer</th>
                      <th className="py-2 text-right">Advanced</th>
                      <th className="py-2 text-right">Recovered</th>
                      <th className="py-2 text-right">Outstanding</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {advances.map((advance) => (
                      <tr key={advance.id}>
                        <td className="py-2 whitespace-nowrap text-slate-600">{advance.date}</td>
                        <td className="py-2 text-slate-900">{advance.farmerName}</td>
                        <td className="py-2 text-right">
                          <Money value={advance.amountMinor} />
                        </td>
                        <td className="py-2 text-right text-slate-600">
                          <Money value={advance.settledMinor} />
                        </td>
                        <td className="py-2 text-right">
                          <Money value={advance.amountMinor - advance.settledMinor} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ) : null}
        </div>
      ) : null}

      {/* --- wallets ---------------------------------------------------------- */}
      {tab === 'Wallets' ? (
        <div className="space-y-6">
          <Card className="rounded-2xl">
            <h3 className="text-lg font-semibold text-slate-900">Add a mobile money wallet</h3>
            <p className="mt-1 text-sm text-slate-600">It becomes a bank account in {entity.functionalCurrency} with its own ledger account, and reconciles the same way.</p>
            <div className="mt-4 grid gap-4 md:grid-cols-3">
              <div>
                <label className={label}>Name</label>
                <Input value={walletForm.name} onChange={(e) => setWalletForm((f) => ({ ...f, name: e.target.value }))} placeholder="Field buying wallet" />
              </div>
              <div>
                <label className={label}>Provider</label>
                <select className={selectClass} value={walletForm.provider} onChange={(e) => setWalletForm((f) => ({ ...f, provider: e.target.value }))}>
                  {['MTN MoMo', 'Telecel Cash', 'AT Money'].map((provider) => (
                    <option key={provider} value={provider}>
                      {provider}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className={label}>Wallet number</label>
                <Input value={walletForm.number} onChange={(e) => setWalletForm((f) => ({ ...f, number: e.target.value }))} placeholder="0244000111" />
              </div>
            </div>
            <div className="mt-4">
              <Button
                size="sm"
                disabled={pending || !walletForm.name.trim() || !walletForm.number.trim() || !allowed('rates:manage')}
                onClick={() =>
                  run('Wallet added.', () => createWallet(entity.id, { ...walletForm, currency: entity.functionalCurrency }), () => setWalletForm({ name: '', provider: 'MTN MoMo', number: '' }))
                }
              >
                Add wallet
              </Button>
            </div>
          </Card>

          <Card className="rounded-2xl">
            <h3 className="text-lg font-semibold text-slate-900">Accounts money moves through</h3>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-[11px] uppercase tracking-[0.12em] text-slate-500">
                  <tr>
                    <th className="py-2">Name</th>
                    <th className="py-2">Kind</th>
                    <th className="py-2">Number</th>
                    <th className="py-2">Currency</th>
                    <th className="py-2">Ledger account</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {bankAccounts.map((account) => (
                    <tr key={account.id}>
                      <td className="py-2 text-slate-900">{account.name}</td>
                      <td className="py-2 text-slate-600">{bankAccountKindLabels[account.kind]}{account.provider ? ` — ${account.provider}` : ''}</td>
                      <td className="py-2 font-mono text-xs text-slate-600">{account.number}</td>
                      <td className="py-2 text-slate-600">{account.currency}</td>
                      <td className="py-2 text-slate-600">
                        {account.accountCode} {account.accountName}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card className="rounded-2xl">
            <h3 className="text-lg font-semibold text-slate-900">Statement formats</h3>
            <p className="mt-1 text-sm text-slate-600">Which column in the provider&apos;s file holds what.</p>
            <div className="mt-4 space-y-2 text-sm">
              {mappings.length === 0 ? (
                <p className="text-slate-500">None yet.</p>
              ) : (
                mappings.map((mapping) => (
                  <div key={mapping.id} className="rounded-xl border border-slate-200 px-4 py-3">
                    <p className="font-medium text-slate-900">{mapping.name}</p>
                    <p className="text-xs text-slate-600">
                      Date &ldquo;{mapping.dateColumn}&rdquo; ({mapping.dateFormat}) · description &ldquo;{mapping.descriptionColumn}&rdquo;
                      {mapping.amountColumn ? ` · amount “${mapping.amountColumn}”` : ` · in “${mapping.moneyInColumn}” / out “${mapping.moneyOutColumn}”`}
                      {mapping.feeColumn ? ` · fee “${mapping.feeColumn}”` : ''}
                      {mapping.levyColumn ? ` · levy “${mapping.levyColumn}”` : ''}
                    </p>
                  </div>
                ))
              )}
              {allowed('rates:manage') ? (
                <Button size="sm" variant="secondary" disabled={pending} onClick={() => run('Provider mappings added.', () => addDefaultStatementMappings(entity.id))}>
                  Add the provider mappings
                </Button>
              ) : null}
            </div>
          </Card>
        </div>
      ) : null}

      {tab === 'Farmers' && !trader ? <Card className="rounded-2xl"><p className="text-sm text-slate-600">{entity.name} buys no produce from farmers.</p></Card> : null}
    </div>
  );
}
