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

    print("\nThe Group currently contains the three registered entities described in the source document.")


if __name__ == "__main__":
    main()
