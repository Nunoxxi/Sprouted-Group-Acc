from sprouted_accounting import AccountingSystem, balance_sheet, income_statement, trial_balance


def show_company_report(company) -> None:
    print(f"\n=== {company.name} ({company.company_type.upper()}) ===")
    print("Trial balance:", trial_balance(company))
    print("Income statement:", income_statement(company))
    print("Balance sheet:", balance_sheet(company))


def main() -> None:
    system = AccountingSystem()
    group = system.seed_group()

    print(f"Group: {group.name}")
    print(f"Companies: {', '.join(company.name for company in group.companies)}")

    for company in group.companies:
        show_company_report(company)

    new_company = system.add_company("Sprouted Digital", "llc", "SD")
    print(f"\nNew company added at runtime: {new_company.name} ({new_company.company_type})")
    print("Runtime company accounts:", [account.name for account in new_company.accounts])


if __name__ == "__main__":
    main()
