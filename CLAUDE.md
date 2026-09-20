# Sprouted Group Accounting App Brief

The app serves Sprouted Group, three Ghanaian companies: Sprouted Roots (farmer programs and raw material aggregation), Sprouted Crafts (cashew processing) and Oikazi (cocoa processing). They trade with each other constantly.

Non-negotiable rules for all code:

- Every record carries an entityId. Every database query is scoped by entity by default. Adding a fourth entity must require no schema change.
- Accounting is double-entry. Every transaction posts balanced debits and credits to a journal. Nothing is ever hard-deleted — corrections are reversing entries.
- Money is stored as integers in pesewas, never as floating-point numbers. Currency is Ghana cedi (GHS).
- Ghana VAT is 20% effective, made up of 15% VAT, 2.5% NHIL and 2.5% GETFund, all charged on the same base and all recoverable as input tax.
- Users are not accountants. The interface says "money in" and "money out", never "debit" and "credit".

The build must be a multi-entity accounting web app for Sprouted Group.
