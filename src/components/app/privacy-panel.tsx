'use client';

/**
 * Data protection: what personal data this company holds, who may see it,
 * answering a person who asks what is held about them, and erasing a person
 * who asks to be erased.
 *
 * Nothing here shows a hidden number without recording that it was shown.
 * The record of who looked is on this page too, so it is not something a
 * person has to go looking for.
 */

import { useMemo, useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { encryptStoredPersonalData, erasePerson, findSubjects, subjectAccessReport, type SubjectMatch } from '@/app/actions/privacy';
import type { Permission } from '@/lib/authz';
import type { AuditEventRecord, DataRequestRecord, EntityRecord, PersonalDataCount } from '@/lib/data/types';
import { dataMapBySubject, purposeLabels, subjectKindLabels, subjectRights, type SubjectReport } from '@/lib/privacy';

const label = 'mb-1.5 block text-sm font-medium text-slate-700';

const subjectHeadings: Record<string, string> = {
  farmer: 'Farmers',
  agent: 'Buying agents',
  staff: 'Staff',
  'donor-or-supplier': 'Customers, suppliers and donors',
  'app-user': 'People who use the app',
};

type Props = {
  entity: EntityRecord;
  counts: PersonalDataCount[];
  requests: DataRequestRecord[];
  access: AuditEventRecord[];
  allowed: (permission: Permission) => boolean;
};

export function PrivacyPanel({ entity, counts, requests, access, allowed }: Props) {
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<SubjectMatch[] | null>(null);
  const [chosen, setChosen] = useState<SubjectMatch | null>(null);
  const [requestedBy, setRequestedBy] = useState('');
  const [note, setNote] = useState('');
  const [report, setReport] = useState<SubjectReport | null>(null);
  const [confirmErasure, setConfirmErasure] = useState('');

  const register = useMemo(() => dataMapBySubject(), []);
  const outstanding = counts.reduce((total, row) => total + row.pendingValues, 0);
  const canManage = allowed('privacy:manage');

  function search() {
    setMessage(null);
    setReport(null);
    startTransition(async () => {
      const result = await findSubjects(entity.id, query);
      if (result.ok) {
        setMatches(result.value);
        if (result.value.length === 0) setMessage({ tone: 'error', text: 'Nobody of that name on this company.' });
      } else setMessage({ tone: 'error', text: result.error });
    });
  }

  function produceReport() {
    if (!chosen) return;
    setMessage(null);
    startTransition(async () => {
      const result = await subjectAccessReport(entity.id, { subjectKind: chosen.kind, subjectId: chosen.id, requestedBy, note });
      if (result.ok) {
        setReport(result.value.report);
        setMessage({ tone: 'ok', text: 'Report produced. It is recorded in the audit log.' });
      } else setMessage({ tone: 'error', text: result.error });
    });
  }

  function erase() {
    if (!chosen) return;
    setMessage(null);
    startTransition(async () => {
      const result = await erasePerson(entity.id, { subjectKind: chosen.kind, subjectId: chosen.id, requestedBy, note });
      if (result.ok) {
        setMessage({ tone: 'ok', text: `Erased. They are now ${result.value.pseudonym}. Every amount, date and journal is untouched.` });
        setChosen(null);
        setMatches(null);
        setReport(null);
        setConfirmErasure('');
        setQuery('');
      } else setMessage({ tone: 'error', text: result.error });
    });
  }

  function printReport() {
    if (!report) return;
    const html = [
      `<h1>What ${report.entityName} holds about ${report.subjectLabel}</h1>`,
      `<p>Produced ${report.producedAt.slice(0, 10)}</p>`,
      ...report.groups.map(
        (group) =>
          `<h2>${group.title}</h2><p>${group.explanation}</p>${
            group.rows.length ? `<table border="1" cellpadding="6" cellspacing="0">${group.rows.map((row) => `<tr><td>${row.label}</td><td>${row.value}</td></tr>`).join('')}</table>` : '<p>Nothing held.</p>'
          }`,
      ),
      `<h2>What you can ask for</h2><ul>${report.rights.map((right) => `<li>${right}</li>`).join('')}</ul>`,
    ].join('');
    const blob = new Blob([`<!doctype html><meta charset="utf-8"><title>Data held about ${report.subjectLabel}</title><body style="font-family:system-ui;max-width:48rem;margin:2rem auto">${html}</body>`], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener,noreferrer');
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{entity.name}</p>
          <h2 className="mt-1 text-2xl font-semibold text-slate-900">Personal data</h2>
          <p className="mt-1 text-sm text-slate-600">
            What this company holds about farmers, agents, staff and the people it trades with — and how to answer somebody who asks what is held about them.
          </p>
        </div>
        {canManage && outstanding > 0 ? (
          <Button
            size="sm"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await encryptStoredPersonalData(entity.id);
                if (result.ok) setMessage({ tone: 'ok', text: `Encrypted ${result.value.encrypted} value${result.value.encrypted === 1 ? '' : 's'} that were still in plain text.` });
                else setMessage({ tone: 'error', text: result.error });
              })
            }
          >
            {pending ? 'Working…' : `Encrypt ${outstanding} remaining`}
          </Button>
        ) : null}
      </div>

      {message ? (
        <div className={['rounded-xl border px-4 py-3 text-sm', message.tone === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-rose-200 bg-rose-50 text-rose-900'].join(' ')}>{message.text}</div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {counts.map((row) => (
          <Card key={row.subject} className="rounded-2xl">
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="text-lg font-semibold text-slate-900">{row.label}</h3>
              <span className="text-2xl font-semibold text-slate-900">{row.people}</span>
            </div>
            <p className="mt-2 text-sm text-slate-600">{row.holds}</p>
            <p className="mt-3 text-xs text-slate-500">
              {row.encryptedValues > 0 || row.pendingValues > 0 ? (
                <>
                  {row.encryptedValues} value{row.encryptedValues === 1 ? '' : 's'} encrypted
                  {row.pendingValues > 0 ? <span className="font-semibold text-amber-700"> · {row.pendingValues} still in plain text</span> : ' · none left in plain text'}
                </>
              ) : (
                'Nothing here needs encrypting: names and references, not contact details.'
              )}
            </p>
          </Card>
        ))}
      </div>

      {canManage ? (
        <Card className="rounded-2xl">
          <h3 className="text-lg font-semibold text-slate-900">Somebody has asked about their data</h3>
          <p className="mt-1 text-sm text-slate-600">
            Find them by name. Numbers cannot be searched on, because they are encrypted — which is the point of them.
          </p>

          <div className="mt-4 flex flex-wrap items-end gap-3">
            <div className="min-w-[16rem] flex-1">
              <label className={label} htmlFor="privacy-search">Name</label>
              <Input id="privacy-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Akosua Mensah" onKeyDown={(event) => { if (event.key === 'Enter') search(); }} />
            </div>
            <Button size="sm" variant="secondary" disabled={pending} onClick={search}>Find</Button>
          </div>

          {matches && matches.length > 0 ? (
            <ul className="mt-4 divide-y divide-slate-100 rounded-xl border border-slate-200">
              {matches.map((match) => (
                <li key={`${match.kind}:${match.id}`} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <div>
                    <p className="font-medium text-slate-900">{match.name}</p>
                    <p className="text-xs text-slate-500">{subjectKindLabels[match.kind]} · {match.detail}</p>
                  </div>
                  <Button size="sm" variant={chosen?.id === match.id && chosen.kind === match.kind ? 'primary' : 'secondary'} onClick={() => { setChosen(match); setReport(null); setConfirmErasure(''); }}>
                    {chosen?.id === match.id && chosen.kind === match.kind ? 'Selected' : 'Select'}
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}

          {chosen ? (
            <div className="mt-5 rounded-xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-sm font-medium text-slate-900">{chosen.name} — {subjectKindLabels[chosen.kind]}</p>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div>
                  <label className={label} htmlFor="privacy-requested-by">Who asked</label>
                  <Input id="privacy-requested-by" value={requestedBy} onChange={(event) => setRequestedBy(event.target.value)} placeholder="The farmer, in person at the buying centre" />
                </div>
                <div>
                  <label className={label} htmlFor="privacy-note">Anything they said</label>
                  <Input id="privacy-note" value={note} onChange={(event) => setNote(event.target.value)} placeholder="Optional" />
                </div>
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                <Button size="sm" disabled={pending || !requestedBy.trim()} onClick={produceReport}>Show me everything held about them</Button>
                {report ? <Button size="sm" variant="secondary" onClick={printReport}>Open as a page to print or send</Button> : null}
              </div>

              <div className="mt-5 border-t border-slate-200 pt-4">
                <p className="text-sm font-medium text-slate-900">They have asked to be erased</p>
                <p className="mt-1 text-sm text-slate-600">
                  Their name becomes a reference and their telephone number, mobile money number and any signature are deleted. Every amount, date and journal stays
                  exactly as it is, because the law requires the accounting records to be kept. This cannot be undone.
                </p>
                <div className="mt-3 flex flex-wrap items-end gap-3">
                  <div className="min-w-[14rem]">
                    <label className={label} htmlFor="privacy-confirm">Type ERASE to confirm</label>
                    <Input id="privacy-confirm" value={confirmErasure} onChange={(event) => setConfirmErasure(event.target.value)} placeholder="ERASE" />
                  </div>
                  <Button size="sm" variant="danger" disabled={pending || confirmErasure !== 'ERASE' || !requestedBy.trim()} onClick={erase}>
                    Erase {chosen.name}
                  </Button>
                </div>
              </div>
            </div>
          ) : null}

          {report ? (
            <div className="mt-6 space-y-4 rounded-xl border border-slate-200 p-4">
              <h4 className="text-base font-semibold text-slate-900">What {report.entityName} holds about {report.subjectLabel}</h4>
              {report.groups.map((group) => (
                <div key={group.title}>
                  <p className="text-sm font-medium text-slate-900">{group.title}</p>
                  <p className="text-xs text-slate-500">{group.explanation}</p>
                  {group.rows.length === 0 ? (
                    <p className="mt-2 text-sm text-slate-500">Nothing held.</p>
                  ) : (
                    <dl className="mt-2 divide-y divide-slate-100 text-sm">
                      {group.rows.map((row, index) => (
                        <div key={`${group.title}-${index}`} className="flex flex-wrap justify-between gap-3 py-1.5">
                          <dt className="text-slate-600">{row.label}</dt>
                          <dd className="text-slate-900">{row.value}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </div>
              ))}
              <div>
                <p className="text-sm font-medium text-slate-900">What they can ask for</p>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-600">
                  {subjectRights.map((right) => <li key={right}>{right}</li>)}
                </ul>
              </div>
            </div>
          ) : null}
        </Card>
      ) : null}

      <Card className="rounded-2xl">
        <h3 className="text-lg font-semibold text-slate-900">Every time somebody looked</h3>
        <p className="mt-1 text-sm text-slate-600">
          Showing a hidden number, producing a report and erasing a person are all recorded in the audit chain, which cannot be edited afterwards.
        </p>
        {access.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">Nobody has looked at a hidden number on this company yet.</p>
        ) : (
          <ul className="mt-4 divide-y divide-slate-100 text-sm">
            {access.slice(0, 40).map((event) => (
              <li key={event.id} className="flex flex-wrap justify-between gap-3 py-2">
                <span className="text-slate-900">{event.summary}</span>
                <span className="text-xs text-slate-500">{event.userName} · {event.createdAt.slice(0, 16).replace('T', ' ')}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {canManage && requests.length > 0 ? (
        <Card className="rounded-2xl">
          <h3 className="text-lg font-semibold text-slate-900">Requests people have made</h3>
          <ul className="mt-4 divide-y divide-slate-100 text-sm">
            {requests.map((request) => (
              <li key={request.id} className="py-2">
                <div className="flex flex-wrap justify-between gap-3">
                  <span className="text-slate-900">
                    {request.kind === 'erasure' ? 'Erased' : 'Report produced for'} {request.subjectRef}
                    {request.pseudonym ? ` — now ${request.pseudonym}` : ''}
                  </span>
                  <span className="text-xs text-slate-500">{request.handledByName} · {request.createdAt.slice(0, 10)}</span>
                </div>
                <p className="text-xs text-slate-500">
                  Asked by {request.requestedBy}
                  {request.fieldsChanged ? ` · ${request.fieldsChanged} stored value${request.fieldsChanged === 1 ? '' : 's'} changed` : ''}
                  {request.note ? ` · ${request.note}` : ''}
                </p>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card className="rounded-2xl">
        <h3 className="text-lg font-semibold text-slate-900">The register</h3>
        <p className="mt-1 text-sm text-slate-600">
          Every field in the app that is about an identifiable person, why it is held, and what happens to it when somebody asks to be erased. This is what goes on
          the registration with the Data Protection Commission.
        </p>
        <div className="mt-4 space-y-5">
          {register.map((group) => (
            <div key={group.subject}>
              <p className="text-sm font-semibold text-slate-900">{subjectHeadings[group.subject] ?? group.subject}</p>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full min-w-[40rem] text-left text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                      <th className="py-2 pr-3 font-medium">What</th>
                      <th className="py-2 pr-3 font-medium">Why we hold it</th>
                      <th className="py-2 pr-3 font-medium">Kept</th>
                      <th className="py-2 font-medium">If they ask to be erased</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {group.fields.map((field) => (
                      <tr key={`${field.model}.${field.field}`}>
                        <td className="py-2 pr-3 text-slate-900">{field.describes}</td>
                        <td className="py-2 pr-3 text-slate-600">{purposeLabels[field.purpose]}</td>
                        <td className="py-2 pr-3 text-slate-600">
                          {field.encrypted ? 'Encrypted' : 'As written'}
                          {field.masked ? ', hidden on screen' : ''}
                        </td>
                        <td className="py-2 text-slate-600">
                          {field.onErasure === 'removed' ? 'Deleted' : field.onErasure === 'replaced-with-a-pseudonym' ? 'Replaced with a reference' : 'Kept — part of the accounts'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
