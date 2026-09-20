from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Iterable, Optional
from uuid import uuid4


ACCOUNT_TYPES = {"asset", "liability", "equity", "revenue", "expense"}


@dataclass
class Account:
    name: str
    account_type: str
    company_id: str
    debit_total: float = 0.0
    credit_total: float = 0.0

    def __post_init__(self) -> None:
        if self.account_type not in ACCOUNT_TYPES:
            raise ValueError(f"Unsupported account type: {self.account_type}")

    @property
    def balance(self) -> float:
        if self.account_type in {"asset", "expense"}:
            return self.debit_total - self.credit_total
        return self.credit_total - self.debit_total

    def debit(self, amount: float) -> None:
        self.debit_total += amount

    def credit(self, amount: float) -> None:
        self.credit_total += amount


@dataclass
class JournalEntry:
    entry_id: str
    transaction_date: date
    description: str
    company_id: str
    lines: list[dict[str, object]] = field(default_factory=list)


@dataclass
class Company:
    name: str
    company_type: str
    code: str
    accounts: list[Account] = field(default_factory=list)
    entries: list[JournalEntry] = field(default_factory=list)
    id: str = field(default_factory=lambda: uuid4().hex[:8])

    def add_account(self, account: Account) -> None:
        self.accounts.append(account)

    def account(self, account_name: str) -> Account:
        for account in self.accounts:
            if account.name == account_name:
                return account
        raise ValueError(f"Account '{account_name}' not found for company '{self.name}'")


@dataclass
class Group:
    name: str
    companies: list[Company] = field(default_factory=list)

    def add_company(self, company: Company) -> None:
        self.companies.append(company)

    def summary(self) -> dict[str, object]:
        return {
            "name": self.name,
            "company_count": len(self.companies),
            "company_names": [company.name for company in self.companies],
            "types": {company.name: company.company_type for company in self.companies},
        }


class AccountingSystem:
    def __init__(self, name: str = "Sprouted Group of Companies") -> None:
        self.group = Group(name)

    def add_company(self, name: str, company_type: str, code: str, seed_accounts: bool = True) -> Company:
        company = Company(name=name, company_type=company_type, code=code)
        self.group.add_company(company)
        if seed_accounts:
            self.seed_company(company)
        return company

    def seed_company(self, company: Company, initial_funding: float = 25000.0) -> Company:
        normalized_type = (company.company_type or "").strip().lower()
        if normalized_type in {"charity", "non-profit", "non_profit", "nonprofit", "nfp"}:
            company.company_type = "NFP"
            company.accounts = [
                Account("Cash", "asset", company.id),
                Account("Donations Received", "revenue", company.id),
                Account("Program Expenses", "expense", company.id),
                Account("Restricted Funds", "equity", company.id),
            ]
            equity_name = "Restricted Funds"
            revenue_name = "Donations Received"
            expense_name = "Program Expenses"
        else:
            company.company_type = "LLC"
            company.accounts = [
                Account("Cash", "asset", company.id),
                Account("Accounts Receivable", "asset", company.id),
                Account("Revenue", "revenue", company.id),
                Account("Operating Expenses", "expense", company.id),
                Account("Owner Equity", "equity", company.id),
            ]
            equity_name = "Owner Equity"
            revenue_name = "Revenue"
            expense_name = "Operating Expenses"

        post_entry(
            company,
            date(2026, 1, 5),
            "Initial funding",
            [
                (company.account("Cash"), initial_funding, None),
                (company.account(equity_name), None, initial_funding),
            ],
        )

        post_entry(
            company,
            date(2026, 1, 10),
            "Operational activity",
            [
                (company.account(expense_name), 1200, None),
                (company.account("Cash"), None, 1200),
            ],
        )

        post_entry(
            company,
            date(2026, 1, 15),
            "Sales or donations",
            [
                (company.account("Cash"), 5400, None),
                (company.account(revenue_name), None, 5400),
            ],
        )

        return company

    def seed_group(self) -> Group:
        self.group = build_default_group()
        for company in self.group.companies:
            self.seed_company(company)
        return self.group


def _get_account(company: Company, account_name: str) -> Account:
    return company.account(account_name)


def post_entry(
    company: Company,
    transaction_date: date,
    description: str,
    entries: Iterable[tuple[Account, Optional[float], Optional[float]]],
) -> JournalEntry:
    valid_entries: list[dict[str, object]] = []
    debit_total = 0.0
    credit_total = 0.0

    for account, debit, credit in entries:
        if account.company_id != company.id:
            raise ValueError(f"Account '{account.name}' does not belong to company '{company.name}'")
        if (debit is None) == (credit is None):
            raise ValueError(f"Each journal line must have exactly one of debit or credit for {account.name}")
        if debit is not None:
            debit_total += float(debit)
            account.debit(float(debit))
        else:
            credit_total += float(credit)
            account.credit(float(credit))
        valid_entries.append({"account": account.name, "debit": debit, "credit": credit})

    if round(debit_total, 2) != round(credit_total, 2):
        raise ValueError("Journal entry is not balanced")

    entry = JournalEntry(
        entry_id=uuid4().hex[:10],
        transaction_date=transaction_date,
        description=description,
        company_id=company.id,
        lines=valid_entries,
    )
    company.entries.append(entry)
    return entry


def trial_balance(company: Company) -> dict[str, float]:
    return {account.name: account.balance for account in company.accounts}


def income_statement(company: Company) -> dict[str, float]:
    revenue = sum(account.balance for account in company.accounts if account.account_type == "revenue")
    expenses = sum(account.balance for account in company.accounts if account.account_type == "expense")
    net_profit = revenue - expenses
    return {"Revenue": revenue, "Expenses": expenses, "Net Profit": net_profit}


def balance_sheet(company: Company) -> dict[str, float]:
    assets = sum(account.balance for account in company.accounts if account.account_type == "asset")
    liabilities = sum(account.balance for account in company.accounts if account.account_type == "liability")
    equity = sum(account.balance for account in company.accounts if account.account_type == "equity")
    retained_earnings = income_statement(company)["Net Profit"]
    return {
        "Assets": assets,
        "Liabilities": liabilities,
        "Equity": equity,
        "Retained Earnings": retained_earnings,
    }


def build_default_group() -> Group:
    group = Group("Sprouted Group of Companies")

    charity = Company("Sprouted Roots", "NFP", "SG001")
    craft_company = Company("Sprouted Crafts", "LLC", "SG002")
    oikazi_company = Company("Oikazi", "LLC", "SG003")

    group.add_company(charity)
    group.add_company(craft_company)
    group.add_company(oikazi_company)

    return group
