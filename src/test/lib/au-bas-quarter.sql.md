# AU BAS Quarter Mapping Reference

This document defines the canonical Australian financial-year quarter boundaries
used by BAS reporting. Future SQL tests and edge-function tests should reference
this table to ensure quarter-bucketing logic stays consistent with ATO rules.

## Financial Year Structure

The Australian financial year runs from **1 July** to **30 June**.

| BAS Quarter | Label   | Calendar months             | FY example (2024-25)     |
| ----------- | ------- | --------------------------- | ------------------------ |
| Q1          | Jul–Sep | July, August, September     | 1 Jul 2024 – 30 Sep 2024 |
| Q2          | Oct–Dec | October, November, December | 1 Oct 2024 – 31 Dec 2024 |
| Q3          | Jan–Mar | January, February, March    | 1 Jan 2025 – 31 Mar 2025 |
| Q4          | Apr–Jun | April, May, June            | 1 Apr 2025 – 30 Jun 2025 |

## SQL Quarter Expression

Use the following expression to derive BAS quarter (1-4) from a `timestamptz` column:

```sql
-- Returns 1 for Jul-Sep, 2 for Oct-Dec, 3 for Jan-Mar, 4 for Apr-Jun.
-- Shift the month back by 6 so July becomes month 1.
CASE
  WHEN EXTRACT(MONTH FROM invoice_date) IN (7, 8, 9)   THEN 1
  WHEN EXTRACT(MONTH FROM invoice_date) IN (10, 11, 12) THEN 2
  WHEN EXTRACT(MONTH FROM invoice_date) IN (1, 2, 3)   THEN 3
  WHEN EXTRACT(MONTH FROM invoice_date) IN (4, 5, 6)   THEN 4
END AS bas_quarter
```

Or equivalently using modular arithmetic:

```sql
-- ((month + 5) % 12) / 3 + 1  maps:
--   Jul(7)  → 1,  Aug(8)  → 1,  Sep(9)  → 1
--   Oct(10) → 2,  Nov(11) → 2,  Dec(12) → 2
--   Jan(1)  → 3,  Feb(2)  → 3,  Mar(3)  → 3
--   Apr(4)  → 4,  May(5)  → 4,  Jun(6)  → 4
(EXTRACT(MONTH FROM invoice_date)::int + 5) % 12 / 3 + 1 AS bas_quarter
```

## AU Financial Year Number

To get the FY label (e.g. "FY2025" = the year ending 30 June 2025):

```sql
-- For months Jul-Dec the FY year is calendar year + 1.
-- For months Jan-Jun the FY year equals the calendar year.
CASE
  WHEN EXTRACT(MONTH FROM invoice_date) >= 7
    THEN EXTRACT(YEAR FROM invoice_date)::int + 1
  ELSE
    EXTRACT(YEAR FROM invoice_date)::int
END AS fy_year
```

## Edge Cases for Future Tests

| Scenario                                         | Expected behaviour                                                     |
| ------------------------------------------------ | ---------------------------------------------------------------------- |
| Exactly midnight 1 Jul (UTC+10 AEST)             | Quarter 1 — store timestamps in UTC, convert in AU tz before bucketing |
| 30 Jun 23:59:59 UTC+10                           | Quarter 4 (same FY)                                                    |
| UTC timestamp for a Jun date that is Jul in AEST | Must convert `AT TIME ZONE 'Australia/Brisbane'` before bucketing      |
| Leap year 29 Feb                                 | Quarter 3 (Jan-Mar)                                                    |
| NULL invoice_date                                | CASE returns NULL — aggregate separately as "unclassified"             |

## Timezone Note

All timestamps in Supabase are stored as `timestamptz` in UTC. BAS quarters
must be calculated **after** converting to the tenant's local timezone:

```sql
-- Convert to AEST (UTC+10, no DST) before extracting month
EXTRACT(MONTH FROM invoice_date AT TIME ZONE 'Australia/Brisbane')
```

Queensland does not observe daylight saving. For tenants in other states
(VIC, NSW, SA, ACT, TAS) use `'Australia/Sydney'` or store timezone per-org.
