# Terms of use

These terms cover the hosted dietary-supplement-analysis service: the demo endpoint `https://agents.trackmysupplement.com` (REST and MCP), the Pocket Network service `dietary-supplement-analysis`, and any supplier running this code under these terms. They are provided by Chariot Ventures ("we"). By calling the service, or by building an app or agent that calls it, you agree to them. The source code is separately licensed under the [MIT License](LICENSE).

## 1. Information, not medical advice

The service returns information: what supplement labels declare, totals of those amounts, and how they compare with reference values, interactions and safety statements published by the U.S. National Institutes of Health (NIH) and the U.S. Food and Drug Administration (FDA).

- It is **not medical advice**, a diagnosis, or a treatment recommendation, and it is not a substitute for a doctor, pharmacist, dietitian or other qualified health professional.
- It is **not intended to diagnose, treat, cure or prevent any disease**, and it is not a medical device.
- Using it creates no doctor-patient, pharmacist-patient or other professional relationship.
- **Before starting, stopping or changing a supplement or medication**, and for any result that is flagged, check with a health professional. This matters most in pregnancy or breastfeeding, for children, for people with a serious illness, and for anyone taking prescription medication.
- **It is not for emergencies.** For a suspected overdose, a reaction or any other emergency, call local emergency services (911 in the US) or Poison Control (1-800-222-1222 in the US) immediately.

## 2. What the results can and can't tell you

- **Labels can be wrong or out of date.** Amounts come from the NIH Dietary Supplement Label Database as manufacturers declared them. Products change, labels contain errors (the service flags the ones it detects as `DATA_SUSPECT`), and actual contents can differ from the label.
- **Matching can be wrong.** Product names and barcodes are matched to labels automatically; each match is reported with a confidence level and alternatives so it can be checked.
- **Coverage is limited.** Medication interactions are only those named in the NIH fact sheets; that list is not exhaustive, and no finding does not mean no interaction. Supplement-to-supplement interactions are not evaluated. Food is counted only when requested, and then as an estimate.
- **No flag is not an all-clear.** The service never says a routine is safe. A result with nothing flagged means only that nothing in its scope was found to report.
- Reference values and fact sheets change; the service reports the editions it used in `sources` and `GET /v1/provenance`.

## 3. If you build an app or agent on the service

If your product shows results to people, you agree to:

- show them that the results are information, not medical advice, and relay `agent_summary` in full, including its last sentence;
- never present a result as a diagnosis, a treatment plan, or a statement that a routine is safe or risk-free;
- direct people to a health professional for flagged results and to emergency services for emergencies;
- not use the service as the only basis for clinical decisions, dispensing decisions or anything a licensed professional is required to decide;
- send no names, contact details or other identifying information (the service needs only age, sex and what a person takes), and comply with the health-privacy and consumer-protection laws that apply to your product;
- not misrepresent the service, NIH, FDA or any product brand as endorsing your product.

## 4. No endorsement

The service uses public data from NIH (DSLD, Office of Dietary Supplements, NCCIH, RxNorm), FDA (openFDA) and USDA. Those agencies do not endorse, sponsor or review this service. Product and brand names belong to their owners and are used only to identify products; no affiliation or endorsement is implied, and a product's appearance in a result is not a recommendation for or against it.

## 5. Privacy

Request bodies, including product and medication names, are never logged; the service's logs record only the method, path, status and duration of each request. The server's network components may briefly keep standard connection data, such as IP addresses, for security and rate limiting. Free-trial counters store salted hashes of network addresses and connection IDs, kept for two days. Requests relayed through Pocket Network are handled by the supplier that serves them; other suppliers may have their own practices.

## 6. No warranty

The service is provided "as is" and "as available", without warranties of any kind, express or implied, including accuracy, completeness, availability, merchantability, fitness for a particular purpose and non-infringement. It may change, be rate-limited or stop at any time.

## 7. Limitation of liability

To the fullest extent the law allows, Chariot Ventures and the contributors to this project are not liable for any injury, loss or damage arising from use of, or reliance on, the service or its results, including direct, indirect, incidental, consequential or punitive damages, even if advised of the possibility. Where liability cannot be excluded, it is limited to the amount you paid for the service in the 12 months before the claim (zero for the free demo). Some jurisdictions do not allow certain exclusions, so some of these may not apply to you.

## 8. Indemnity

If you build an app or agent on the service and fail to follow section 3, you agree to indemnify Chariot Ventures against claims that arise from that failure.

## 9. Changes and contact

These terms may be updated; the version in this repository's `main` branch applies, and changes are recorded in its history. Questions: mb@chariot.ventures.

Last updated: 2026-10-11.
