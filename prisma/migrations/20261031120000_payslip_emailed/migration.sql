-- When each payslip was emailed, so a posted run's payslips can be sent in one
-- go and sending again reaches only the people not yet sent theirs. Nullable
-- and additive: the code already deployed never reads it.

ALTER TABLE "PayRunLine" ADD COLUMN "payslipEmailedAt" TIMESTAMP(3);
