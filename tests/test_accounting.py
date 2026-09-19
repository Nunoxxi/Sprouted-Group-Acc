from datetime import date

from sprouted_accounting import (
    Account,
    Company,
    Group,
    AccountingSystem,
    balance_sheet,
    build_default_group,
    income_statement,
    post_entry,
    trial_balance,
)


def test_post_entry_and_reports():
    group = Group("Sprouted Group of Companies")
    company = Company("Sprouted Holdings", "llc", "SH")
    group.add_company(company)

    cash = Account("Cash", "asset", company.id)
    revenue = Account("Revenue", "revenue", company.id)
    expenses = Account("Rent Expense", "expense", company.id)
    equity = Account("Owner Equity", "equity", company.id)

    company.accounts = [cash, revenue, expenses, equity]

    post_entry(
        company,
        date(2026, 1, 5),
        "Initial capital",
        [
            (cash, 10000, None),
            (equity, None, 10000),
        ],
    )

    post_entry(
        company,
        date(2026, 1, 10),
        "Office rent",
        [
            (expenses, 1500, None),
            (cash, None, 1500),
        ],
    )

    post_entry(
        company,
        date(2026, 1, 15),
        "Client invoice",
        [
            (cash, 4200, None),
            (revenue, None, 4200),
        ],
    )

    tb = trial_balance(company)
    assert tb["Cash"] == 12700
    assert tb["Owner Equity"] == 10000
    assert tb["Revenue"] == 4200
    assert tb["Rent Expense"] == 1500

    income = income_statement(company)
    assert income["Revenue"] == 4200
    assert income["Expenses"] == 1500
    assert income["Net Profit"] == 2700

    balance = balance_sheet(company)
    assert balance["Assets"] == 12700
    assert balance["Liabilities"] == 0
    assert balance["Equity"] == 10000
    assert balance["Retained Earnings"] == 2700


def test_default_group_has_three_companies_with_correct_types():
    group = build_default_group()

    assert [company.name for company in group.companies] == [
        "Sprouted Roots",
        "Sprouted Assets",
        "Sprouted Services",
    ]
    assert {company.company_type for company in group.companies} == {"charity", "llc"}


def test_accounting_system_seeds_group_and_reports():
    system = AccountingSystem()
    system.seed_group()

    assert len(system.group.companies) == 3
    assert system.group.companies[0].company_type == "charity"
    assert system.group.companies[1].company_type == "llc"
    assert system.group.companies[2].company_type == "llc"

    for company in system.group.companies:
        assert company.accounts
        assert company.entries


def test_accounting_system_can_add_company_anytime():
    system = AccountingSystem()
    company = system.add_company("Green Growth", "llc", "GG")

    assert company in system.group.companies
    assert company.company_type == "llc"
    assert {account.name for account in company.accounts} >= {"Cash", "Accounts Receivable", "Revenue", "Operating Expenses", "Owner Equity"}
    assert company.entries
