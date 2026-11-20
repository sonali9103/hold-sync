export type NotesDecision =
    | { action: 'baseline'; newBase: string }
    | { action: 'noop' }
    | { action: 'setBase'; newBase: string }
    | { action: 'pull'; newDescription: string; newBase: string }
    | {
        action: 'push';
        newSapphireNotes: string;
        newDescription: string;
        newBase: string;
        expectedSapphireNotes: string;
    }
    | {
        action: 'merge';
        newSapphireNotes: string;
        newDescription: string;
        newBase: string;
        expectedSapphireNotes: string;
    }
    | { action: 'conflict'; reason: 'salesforce-edited-earlier-text' | 'sapphire-edited-earlier-text' }
    | { action: 'tooLong'; length: number; bytes: number };

export interface NotesDecisionInput {
    sapphire: string | null;
    salesforce: string | null;
    base: string | null;
}

export function normalizeNotes(text: string | null | undefined): string {
    if (text == null) return '';

    return text
        .replace(/\r\n|\r/g, '\n')
        .replace(/[ \t\n]+$/, '');
}

export function fitsSapphireLimit(text: string): boolean {
    // VARCHAR2(2000) is a byte limit and the Sapphire charset is unconfirmed, so be conservative.
    return text.length <= 2000 && Buffer.byteLength(text, 'utf8') <= 2000;
}

function tooLong(text: string): NotesDecision {
    return {
        action: 'tooLong',
        length: text.length,
        bytes: Buffer.byteLength(text, 'utf8'),
    };
}

function appendAddition(merged: string, addition: string): string {
    if (addition === '') return merged;
    if (merged !== '' && !addition.startsWith('\n')) return `${merged}\n${addition}`;
    return `${merged}${addition}`;
}

export function decideNotesAction(input: NotesDecisionInput): NotesDecision {
    const sapphire = normalizeNotes(input.sapphire);
    const salesforce = normalizeNotes(input.salesforce);
    const base = input.base === null ? null : normalizeNotes(input.base);

    if (base === null) {
        return { action: 'baseline', newBase: sapphire };
    }

    if (salesforce === sapphire) {
        return base === sapphire
            ? { action: 'noop' }
            : { action: 'setBase', newBase: sapphire };
    }

    if (salesforce === base) {
        return {
            action: 'pull',
            newDescription: sapphire,
            newBase: sapphire,
        };
    }

    if (sapphire === base) {
        if (!salesforce.startsWith(base)) {
            return { action: 'conflict', reason: 'salesforce-edited-earlier-text' };
        }
        if (!fitsSapphireLimit(salesforce)) return tooLong(salesforce);

        return {
            action: 'push',
            newSapphireNotes: salesforce,
            newDescription: salesforce,
            newBase: salesforce,
            expectedSapphireNotes: sapphire,
        };
    }

    if (!sapphire.startsWith(base)) {
        return { action: 'conflict', reason: 'sapphire-edited-earlier-text' };
    }
    if (!salesforce.startsWith(base)) {
        return { action: 'conflict', reason: 'salesforce-edited-earlier-text' };
    }

    const sapphireAddition = sapphire.slice(base.length);
    const salesforceAddition = salesforce.slice(base.length);
    const merged = appendAddition(
        appendAddition(base, sapphireAddition),
        salesforceAddition
    );

    if (!fitsSapphireLimit(merged)) return tooLong(merged);

    return {
        action: 'merge',
        newSapphireNotes: merged,
        newDescription: merged,
        newBase: merged,
        expectedSapphireNotes: sapphire,
    };
}
