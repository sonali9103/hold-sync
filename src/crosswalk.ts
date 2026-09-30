// Canonical mapping from Sapphire's U_HOLDCODEID to your Salesforce
// Hold Type picklist. Text values must match the Hold_Type__c
// picklist EXACTLY (Salesforce restricted picklists reject anything
// not on the list) — these are copied verbatim from U_HOLDREASON.
//
// v1 scope: CS hold codes only (35 of 39). Billing (IDs 1, 25, 41, 45
// — ABN, Medicare, PECOS, Credit Hold) is filtered out at the Oracle
// query level in oracle-client.ts, so those 4 IDs deliberately have
// no entry here. Add them back (and remove the query-level filter)
// once Billing has Salesforce access.
export const HOLD_TYPE_MAP: Record<number, string> = {
    3: 'Credit Card Info Missing/Incorrect',
    4: 'Diagnosis Code',
    5: 'Hrs Collected not marked',
    6: 'Insurance Info. Missing',
    7: 'More than one sample received',
    8: 'Doctor Info. Missing',
    9: 'Patient Info. Missing',
    10: 'No Serum received',
    12: 'No/Questionable Volume',
    13: 'Prompt Payment vs.List Price',
    15: 'Patient Name not match',
    17: 'Sample needs to be Cancelled',
    19: 'Verify Billing and/or Price',
    20: 'Verify Doctor and/or Address',
    21: 'Verify Test Type',
    22: 'Sample does not Match test ordered',
    24: 'Declined Credit Card',
    26: 'No Sample Received',
    27: 'Single Element/Add-on Element',
    28: 'Missing Patient Age/DOB',
    29: 'No or Questionable Sample Date',
    30: 'No or Incorrect Submittal',
    31: 'Hair Sample Mixed',
    32: 'Verify Urine Iodide Dosage',
    33: 'QUICK FIX',
    34: 'SOILED/DAMAGED CHECK',
    35: 'GRACE',
    36: 'NY CANCEL',
    37: 'Iodine Volume Hold',
    38: 'Expired Vial',
    40: 'Consent Signature',
    43: 'LAB Hold',
    44: 'Foreign Subaccount',
    46: 'Questionable Payment Amount',
    47: 'Signf Result:Patient State Missing',
};

export function canonicalHoldType(holdCodeId: number, fallbackText: string): string {
    return HOLD_TYPE_MAP[holdCodeId] ?? fallbackText;
}