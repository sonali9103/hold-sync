import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type CopiaStaffMap = ReadonlyMap<string, string>;

/** Canonical form of the Salesforce Resolved_By__c value (normally a CS username once read-sync Cases are marked). */
export function normalizeCopiaStaffMapKey(value: string | null | undefined): string | null {
    const normalized = value?.trim().toUpperCase() || '';
    return normalized || null;
}

/**
 * Validates map entries rather than making a heuristic Staff.ID lookup.  A missing entry must be
 * handled as a per-Case rejection by the release workflow.
 */
export function createCopiaStaffMap(value: unknown): CopiaStaffMap {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Copia staff map must be a JSON object of Resolved By keys to Copia Staff.ID values.');
    }

    const entries = new Map<string, string>();
    for (const [rawKey, rawStaffId] of Object.entries(value)) {
        const key = normalizeCopiaStaffMapKey(rawKey);
        if (!key || rawKey !== key) {
            throw new Error(`Copia staff map key "${rawKey}" must be trimmed and uppercase.`);
        }
        if (typeof rawStaffId !== 'string' || !rawStaffId.trim()) {
            throw new Error(`Copia staff map value for ${key} must be a non-empty Copia Staff.ID.`);
        }
        if (entries.has(key)) {
            throw new Error(`Copia staff map has duplicate key ${key}.`);
        }
        entries.set(key, rawStaffId.trim());
    }
    return entries;
}

export function loadCopiaStaffMap(filePath = resolve(process.cwd(), 'copia-staff-map.json')): CopiaStaffMap {
    let text: string;
    try {
        text = readFileSync(filePath, 'utf8');
    } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(
            `Could not read Copia staff map at ${filePath}: ${detail}. ` +
            'Copy copia-staff-map.json.example to copia-staff-map.json and fill the mappings.'
        );
    }

    try {
        return createCopiaStaffMap(JSON.parse(text));
    } catch (err) {
        if (err instanceof SyntaxError) {
            throw new Error(`Copia staff map at ${filePath} is not valid JSON: ${err.message}`);
        }
        throw err;
    }
}

export function findCopiaStaffId(
    staffMap: CopiaStaffMap,
    resolvedBy: string | null | undefined
): { key: string | null; staffId: string | null } {
    const key = normalizeCopiaStaffMapKey(resolvedBy);
    return { key, staffId: key ? staffMap.get(key) || null : null };
}
