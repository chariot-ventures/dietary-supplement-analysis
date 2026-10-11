# Accuracy

How do we know the numbers are right? [eval/cases.json](eval/cases.json) holds 53 supplement questions with the answer worked out by hand from the NIH reference tables and fact sheets, independently of the service. Each case says why (for example "5000 IU = 125 mcg; adult UL 100 mcg -> 125%"). The cases cover:

- adult upper limits at, just under, and over each threshold (90% is "near", over 100% is "above")
- age-specific limits for children, older adults, pregnancy and lactation
- the same nutrient from several products, and servings per day
- missing information (no age or sex)
- medication and condition interactions, including a case where none should be reported
- botanicals and dose checks, including a case where nothing should be reported

## The service

`npm run eval` runs every case through the service offline and checks the flags, amounts, severity, interactions, botanicals and data gaps. The same check runs in the test suite, so a release can't ship with a failing case.

<!-- service:start -->
Service 0.9.0: **53 of 53 cases pass.**

| Category | Cases | Pass |
|---|---|---|
| adult UL | 19 | 19 |
| age-specific UL | 2 | 2 |
| children | 5 | 5 |
| pregnancy | 4 | 4 |
| overlap | 4 | 4 |
| servings | 1 | 1 |
| no profile | 1 | 1 |
| medications | 7 | 7 |
| conditions | 4 | 4 |
| botanicals | 6 | 6 |
<!-- service:end -->

## A model with and without the service

`npm run eval:llm` asks the same model each question twice: once alone, and once with this service's `stack_analyze` summary. Both answers are scored against the same expectations (which nutrients are above or near the UL, which interactions involve something in the stack, which herbs NIH warns about). It needs `ANTHROPIC_API_KEY`; `EVAL_MODEL` picks the model and `--limit N` runs a subset. `--write` records the result here.

<!-- llm:start -->
Not run yet for this release.
<!-- llm:end -->

## What the cases don't cover

- Label parsing of real DSLD records is tested separately against 12 recorded labels ([test/fixtures/dsld/real](test/fixtures/dsld/real)) and golden snapshots.
- Name and barcode resolution depends on live DSLD search and is checked against the live service, not here.
- "Hand-checked" means checked against the cited NIH tables by the author; review of the cases by a dietitian or pharmacist would strengthen them.
