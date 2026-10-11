/**
 * The accounts payroll posts to, by number. These are the group's own chart,
 * not statutory figures. The chart refuses to renumber or delete any of them
 * (src/lib/chart-edit.ts), so the payroll journal always finds them.
 *
 * Gross pay goes to each employee's expense account, split by project where
 * they are allocated, so it is not here.
 */

export const payrollAccounts = {
  paye: '2040',
  /** Employee SSNIT and the employer's tier 1, as separate lines. */
  ssnitTier1: '2045',
  ssnitTier2: '2046',
  netPay: '2047',
  /** Voluntary tier 3, owed to the provider. */
  tier3: '2049',
  /** Loans and advances to staff, repaid from pay: a receivable. */
  staffLoans: '1080',
  /** Employer SSNIT and tier 2: a cost to the company. */
  employerContributions: '6065',
  /** Casual and seasonal labour paid by a buying agent out of their float. Not payroll. */
  casualLabour: '6070',
} as const;
