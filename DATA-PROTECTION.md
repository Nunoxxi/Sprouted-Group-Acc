# Personal data in the Sprouted Group accounting system

*Written for the registration with Ghana's Data Protection Commission, and for
anyone in the group who is asked what we hold about a person.*

Last reviewed: 23 September 2026.

---

## 1. Who we are

Sprouted Group is three Ghanaian companies that share one accounting system:

- **Sprouted Roots** — farmer programmes and raw material aggregation, funded
  by grants and donations.
- **Sprouted Crafts** — cashew processing.
- **Oikazi** — cocoa processing.

Each company's records are kept separately inside the system. Somebody given
access to one company cannot see another company's data.

## 2. Whose personal data we hold

| Whose | Roughly how many | Why we hold it |
| --- | --- | --- |
| Farmers we buy from | Hundreds, growing through each buying season | To pay them for what they deliver and to reach them about a delivery or a payment |
| Buying agents | Tens | To account for the money advanced to them to buy with |
| Staff | Tens | To put the payroll cost into the accounts, and to report staff costs to the donors who fund them |
| Customers, suppliers and donors | Hundreds | To invoice them, pay them and account for what is owed |
| People who use the system | Fewer than twenty | To let them sign in, and to record what each of them did |

We do not hold health data, religious or political information, criminal
records, or anything else that Ghanaian law treats as special personal data,
with one exception: we hold a **signature or thumbprint** from farmers paid in
cash, as proof the money was handed over. It is treated as the most sensitive
thing in the system — it is encrypted, it is never displayed on any screen,
and it is deleted the moment a farmer asks to be erased.

## 3. What we hold, exactly

This table is generated from the system itself (`src/lib/privacy.ts`), so it
cannot drift away from what the software actually does. A test fails the build
if a field is declared here and the software does not treat it that way.

### Farmers

| What we hold | Why we hold it | How it is kept | If they ask to be erased |
| --- | --- | --- | --- |
| A farmer's name | To pay them what they are owed | As written | Replaced with a reference |
| A farmer's telephone number | To reach them about their money or their delivery | Encrypted, hidden on screen | Deleted |
| A farmer's mobile money number | To pay them what they are owed | Encrypted, hidden on screen | Deleted |
| The community a farmer farms in | To keep the accounting records the law requires | As written | Kept — part of the accounts |
| The district a farmer farms in | To keep the accounting records the law requires | As written | Kept — part of the accounts |
| The name on a delivery record | To show a payment or a delivery actually happened | As written | Replaced with a reference |
| A farmer's signature or thumbprint, captured on a phone | To show a payment or a delivery actually happened | Encrypted, hidden on screen | Deleted |
| The mobile money reference for a payment to a farmer | To show a payment or a delivery actually happened | As written, hidden on screen | Kept — part of the accounts |
| The mobile money number a payment was sent to | To pay them what they are owed | Encrypted, hidden on screen | Deleted |
| The name on an advance | To keep the accounting records the law requires | As written | Replaced with a reference |
| The name of the farmer a lot came from | To show a payment or a delivery actually happened | As written | Replaced with a reference |

### Buying agents

| What we hold | Why we hold it | How it is kept | If they ask to be erased |
| --- | --- | --- | --- |
| A buying agent's name | To keep the accounting records the law requires | As written | Replaced with a reference |
| A buying agent's telephone number | To reach them about their money or their delivery | Encrypted, hidden on screen | Deleted |

### Staff

| What we hold | Why we hold it | How it is kept | If they ask to be erased |
| --- | --- | --- | --- |
| A member of staff on a payroll summary | To keep the accounting records the law requires | As written, hidden on screen | Replaced with a reference |
| Their staff reference | To keep the accounting records the law requires | As written, hidden on screen | Replaced with a reference |
| A member of staff whose cost is split across grants | To report to a donor who funded the work | As written, hidden on screen | Replaced with a reference |
| Whose time was charged to a grant | To report to a donor who funded the work | As written, hidden on screen | Replaced with a reference |
| Who is holding a piece of equipment | To keep the accounting records the law requires | As written, hidden on screen | Replaced with a reference |

Payroll itself is **not** run in this system. It is run in a separate Ghanaian
payroll system, and what is imported here is a monthly summary: name, staff
reference, department, gross pay, PAYE, SSNIT and net pay. No bank details, no
next of kin, no dates of birth, no national identification numbers.

### Customers, suppliers and donors

| What we hold | Why we hold it | How it is kept | If they ask to be erased |
| --- | --- | --- | --- |
| A customer, supplier or donor — sometimes a person, sometimes a company | To keep the accounting records the law requires | As written | Replaced with a reference |
| Their telephone number | To reach them about their money or their delivery | Encrypted, hidden on screen | Deleted |
| Their email address | To reach them about their money or their delivery | Encrypted, hidden on screen | Deleted |
| Their address | To reach them about their money or their delivery | Encrypted, hidden on screen | Deleted |
| Their tax identification number | To keep the accounting records the law requires | As written, hidden on screen | Kept — part of the accounts |

### People who use the app

| What we hold | Why we hold it | How it is kept | If they ask to be erased |
| --- | --- | --- | --- |
| The name of someone who uses the app | To let someone sign in and to record what they did | As written | Kept — part of the accounts |
| Their email address, which is how they sign in | To let someone sign in and to record what they did | As written | Kept — part of the accounts |
| Who did something in the app, kept permanently | To let someone sign in and to record what they did | As written | Kept — part of the accounts |

Somebody who leaves the group has their account **deactivated**, not erased.
They can no longer sign in, and every session is ended. Their name stays in the
audit record of what they did while they worked here, because an accounting
audit trail that does not say who did what is not an audit trail.

## 4. Where it is stored

| What | Where | Who runs it |
| --- | --- | --- |
| The accounting database, including everything in the tables above | Supabase Postgres, hosted on Amazon Web Services | Supabase Inc. |
| Documents attached to transactions — receipts, weighbridge tickets, invoices | Supabase Storage, a private bucket | Supabase Inc. |
| Sign-in sessions | The same database | Supabase Inc. |
| Invitation emails to new users | Resend | Resend Inc. |
| The application itself | A managed Node.js host | — |

This means personal data is **transferred outside Ghana** and held on servers
in the region the Supabase project was created in. Both Supabase and Resend
provide the contractual data-processing terms that this requires.

Nothing personal is stored on an agent's telephone. A signature is captured in
the browser and sent straight to the server; a photograph of a receipt is
reduced in the browser and uploaded. Neither is kept on the device afterwards.

We take an export of each company's ledger on a schedule. Those export files
contain the same personal data as the database and are kept in the same place,
under the same access controls.

## 5. Who can see it

Everybody who uses the system has one of five roles, and the role decides what
they can see. The rules are enforced on the server, before the page is built —
not hidden in the interface, where the data would still be in the page.

| Role | What they can see |
| --- | --- |
| **Owner** | Everything, including the ability to answer a subject access request and to erase a person |
| **Accountant** | Everything about the money, personal details when they ask for them, and the same privacy powers |
| **Bookkeeper** | Farmer and agent details, so they can pay farmers and telephone agents. They enter and post the day's transactions but cannot answer a data request or erase anybody |
| **Data entry** | Farmer and agent details, so they can pay farmers and telephone agents. They cannot answer a data request or erase anybody |
| **Viewer** | The accounting record only. They see that a farmer was paid and how much. They do not see any telephone number, mobile money number, staff name or pay figure |

In addition, and for **every** role including the Owner:

- Telephone numbers and mobile money numbers are shown with only their last
  four digits — `••••••1222`. The rest of the number is not sent to the browser
  at all.
- Seeing a number in full takes a deliberate action: you press *Show*, say why
  you need it, and the system records who asked, for whom, which number and
  why. That record cannot be edited afterwards.
- Opening a farmer's or an agent's record to edit it counts as looking, and is
  recorded the same way.

## 6. How it is protected

- **Encrypted at rest.** Telephone numbers, mobile money numbers, email
  addresses, postal addresses and signatures are encrypted with AES-256-GCM
  before they are written, with the key held outside the database. Somebody who
  obtained a copy of the database would not have those values. Each value is
  bound to the column it belongs in, so one cannot be moved into another and
  still be read.
- **Separately for each company.** Every query is restricted to the companies
  the person has been given, and there is an automated test that fails the
  build if any part of the system can be made to read another company's data.
- **Two-factor sign-in.** Anyone who can post to the ledger — Owner, Accountant
  and Data entry, which is every role that can see a personal detail — must use
  a one-time code as well as a password.
- **Nothing is ever deleted.** The accounting records are corrected by posting
  a reversing entry, never by deleting. Every change is written into a
  tamper-evident chain: each record carries a fingerprint of the one before it,
  so an altered or removed record is detectable.
- **Collected only where it is needed.** The system does not ask for a date of
  birth, a national identification number, a bank account, a next of kin or a
  photograph of a person. A farmer's telephone number is optional; a farmer can
  be recorded, paid in cash and receipted with only a name and a community.

## 7. How long we keep it

Accounting records — what was delivered, what was paid, when, and against which
account — are kept for **six years** after the end of the financial year they
belong to, as Ghanaian tax and companies law requires. This is why erasing a
person does not remove the money: it removes their name from the money.

Personal details that are not accounting records — a telephone number, a mobile
money number, an address, a signature — are deleted as soon as the person asks,
and in any case are reviewed when a farmer has not traded with us for three
seasons.

## 8. If somebody asks what we hold about them

Anybody can ask, in person at a buying centre, by telephone, or in writing.

1. Open **Personal data** in the system, for the company they dealt with.
2. Search for their name.
3. Record who asked and anything they said.
4. Press **Show me everything held about them**.

The system produces a report in plain language: what we hold about them, every
delivery, every payment, every advance, and — for staff — every payroll
summary and how their cost was split between funders. It ends with what they
can ask for next. It can be opened as a page to print or to send.

Producing the report is itself recorded, with who produced it and who asked.

## 9. If somebody asks to be erased

Same page, same search, then **Erase**. What happens:

- Their name is replaced everywhere it appears — on the farmer record, on every
  delivery, on every advance, on every lot — with a reference such as
  `Farmer A1B2C3`. The reference is generated at random and has no connection
  to their name, so nobody can work backwards from it.
- Their telephone number, mobile money number and any signature are deleted.
- **Every amount, every date, every journal entry and every balance stays
  exactly as it was.** Nothing in the accounts moves.

We tell the person this before we do it, because it is the part people are
surprised by: we cannot delete the record that they delivered 80 kilograms on a
particular day and were paid for it. Ghanaian law requires us to keep that. What
we can do, and do, is take their name off it.

The erasure is recorded: who asked, who carried it out, when, which reference
replaced the name, and how many stored values were changed.

## 10. What a person can ask us for

This is the wording the system puts at the end of every report:

- You can ask us to correct anything above that is wrong.
- You can ask us to erase your personal details. We will replace your name with
  a reference and delete your telephone number, mobile money number and any
  signature we hold.
- We cannot delete the financial records — what you delivered, what you were
  paid and when — because Ghanaian law requires us to keep accounting records.
  After erasure those records remain, but they no longer carry your name.
- You can ask who has looked at your details. Every time someone shows a hidden
  telephone or mobile money number, produces one of these reports, or erases a
  person, it is recorded and cannot be altered.
- If you are not satisfied, you can complain to the Data Protection Commission
  of Ghana.

## 11. If personal data is lost or exposed

The audit record shows what was read and by whom, which is what a notification
to the Commission needs. The encryption key is held outside the database, so a
copy of the database alone does not expose telephone numbers, mobile money
numbers, addresses or signatures. If the key itself were exposed, it would be
changed and every encrypted value re-encrypted under the new one; the procedure
for that is the same **Encrypt remaining** action described below.

## 12. For whoever maintains the system

- The register is `src/lib/privacy.ts`. Adding a column that holds personal data
  means adding a line there. `tests/privacy.test.ts` fails if the register and
  the masking code disagree.
- Encryption is `src/lib/pii-crypto.ts`. The key is the `PII_ENCRYPTION_KEY`
  environment variable — 32 random bytes, base64. **Lose it and every encrypted
  value becomes unreadable.** The financial records are unaffected either way.
- Values written before encryption was switched on stay readable and are
  converted by pressing **Encrypt remaining** on the Personal data page, which
  is safe to run again at any time. The page shows how many are outstanding.
- Masking happens in `src/lib/data/redact.ts`, on the server, in one place.
- The server functions that reveal, report and erase are
  `src/app/actions/privacy.ts`. Every one of them writes an audit event.
