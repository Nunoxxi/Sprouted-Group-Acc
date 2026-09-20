import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Input } from '../ui/input';
import { Money } from '../ui/money';

const transactions = [
  { description: 'Cashew export sale', type: 'money in', amount: 185000 },
  { description: 'Farm inputs purchase', type: 'money out', amount: -92000 },
  { description: 'Staff salaries', type: 'money out', amount: -48000 },
  { description: 'Donor grant received', type: 'money in', amount: 250000 },
];

export function DesignSystemDemo() {
  return (
    <main className="min-h-screen bg-sand-50 px-4 py-8 text-slate-900 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl space-y-8">
        <header className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-6 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-brand-700">Sprouted Group</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">Design system</h1>
          </div>
          <div className="flex items-center gap-3">
            <Button variant="secondary">Secondary</Button>
            <Button>Primary action</Button>
          </div>
        </header>

        <section className="grid gap-6 lg:grid-cols-3">
          <Card>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Brand</p>
            <div className="mt-4 h-16 rounded-lg bg-brand-700" />
            <div className="mt-4 flex gap-2">
              <div className="h-10 w-10 rounded-md bg-brand-700" />
              <div className="h-10 w-10 rounded-md bg-brand-600" />
              <div className="h-10 w-10 rounded-md bg-brand-500" />
            </div>
          </Card>

          <Card>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Status</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Badge>Neutral</Badge>
              <Badge tone="success">Money in</Badge>
              <Badge tone="danger">Money out</Badge>
            </div>
          </Card>

          <Card>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Controls</p>
            <div className="mt-4 space-y-3">
              <Input defaultValue="Sprouted Crafts" aria-label="Example input" />
              <div className="flex gap-3">
                <Button size="sm" variant="secondary">Cancel</Button>
                <Button size="sm">Save</Button>
              </div>
            </div>
          </Card>
        </section>

        <section className="grid gap-6 xl:grid-cols-[1.4fr_0.8fr]">
          <Card as="section">
            <div className="flex items-center justify-between pb-4">
              <h2 className="text-lg font-semibold">Transactions</h2>
              <Button variant="secondary" size="sm">Filter</Button>
            </div>

            <div className="overflow-hidden rounded-lg border border-slate-200">
              <div className="hidden grid-cols-[2fr_1fr_1fr] gap-4 bg-slate-50 px-4 py-3 text-xs font-semibold uppercase tracking-[0.12em] text-slate-500 md:grid">
                <span>Description</span>
                <span className="text-right">Type</span>
                <span className="text-right">Amount</span>
              </div>

              {transactions.map((row) => (
                <div
                  key={row.description}
                  className="grid gap-3 border-t border-slate-200 px-4 py-3 md:grid-cols-[2fr_1fr_1fr] md:items-center"
                >
                  <div>
                    <div className="text-sm font-medium text-slate-900">{row.description}</div>
                    <div className="mt-1 text-xs text-slate-500 md:hidden">{row.type}</div>
                  </div>
                  <div className="text-sm text-slate-600 md:text-right">
                    <span className="md:hidden">Type: </span>
                    <Badge tone={row.amount > 0 ? 'success' : 'danger'}>{row.type}</Badge>
                  </div>
                  <div className="text-sm md:text-right">
                    <Money value={row.amount} className={row.amount > 0 ? 'text-emerald-700' : 'text-red-700'} />
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card as="aside">
            <h2 className="text-lg font-semibold">Bank matching</h2>
            <div className="mt-4 space-y-3">
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-slate-600">GCB 2841</span>
                  <Badge tone="success">Matched</Badge>
                </div>
                <div className="mt-3 text-right font-mono text-lg tabular-nums text-slate-900">
                  GHS 1,850.00
                </div>
              </div>

              <Button className="w-full">Confirm match</Button>
            </div>
          </Card>
        </section>

        <section className="grid gap-6 md:grid-cols-2 xl:grid-cols-4">
          <Card>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Current</p>
            <div className="mt-3 font-mono text-3xl tabular-nums text-slate-900">GHS 2,458,120.00</div>
          </Card>
          <Card>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Money in</p>
            <div className="mt-3 font-mono text-3xl tabular-nums text-emerald-700">GHS 3,240,400.00</div>
          </Card>
          <Card>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Money out</p>
            <div className="mt-3 font-mono text-3xl tabular-nums text-red-700">GHS (1,782,280.00)</div>
          </Card>
          <Card>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Net</p>
            <div className="mt-3 font-mono text-3xl tabular-nums text-slate-900">GHS 1,458,120.00</div>
          </Card>
        </section>
      </div>
    </main>
  );
}
