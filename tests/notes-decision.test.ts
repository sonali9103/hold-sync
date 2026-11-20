import assert from 'node:assert/strict';
import test from 'node:test';

import {
    decideNotesAction,
    fitsSapphireLimit,
    normalizeNotes,
} from '../src/notes-decision';

test('normalizes line endings and only trims trailing spaces, tabs, and newlines', () => {
    assert.equal(normalizeNotes('  opening\r\ninner  text\rfinal\t \n\n'), '  opening\ninner  text\nfinal');
    assert.equal(normalizeNotes(null), '');
    assert.equal(normalizeNotes(undefined), '');
});

test('uses a baseline when notes have never been synced', () => {
    assert.deepEqual(
        decideNotesAction({ sapphire: 'S\r\n', salesforce: 'ignored', base: null }),
        { action: 'baseline', newBase: 'S' }
    );
});

test('distinguishes a never-synced null base from an empty synced base', () => {
    assert.deepEqual(
        decideNotesAction({ sapphire: '', salesforce: 'Salesforce note', base: null }),
        { action: 'baseline', newBase: '' }
    );
    assert.deepEqual(
        decideNotesAction({ sapphire: '', salesforce: 'Salesforce note', base: '' }),
        {
            action: 'push',
            newSapphireNotes: 'Salesforce note',
            newDescription: 'Salesforce note',
            newBase: 'Salesforce note',
            expectedSapphireNotes: '',
        }
    );
});

test('does nothing when both current notes equal the base', () => {
    assert.deepEqual(
        decideNotesAction({ sapphire: 'same', salesforce: 'same', base: 'same' }),
        { action: 'noop' }
    );
});

test('sets the base when Salesforce and Sapphire agree but it differs from the base', () => {
    assert.deepEqual(
        decideNotesAction({ sapphire: 'current', salesforce: 'current', base: 'older' }),
        { action: 'setBase', newBase: 'current' }
    );
});

test('treats CRLF/LF and trailing whitespace differences as no edit', () => {
    assert.deepEqual(
        decideNotesAction({
            sapphire: 'entry\r\nnext\t \r\n',
            salesforce: 'entry\nnext',
            base: 'entry\rnext\n',
        }),
        { action: 'noop' }
    );
});

test('pulls a Sapphire-only change, including an edit to earlier text', () => {
    assert.deepEqual(
        decideNotesAction({ sapphire: 'revised original', salesforce: 'original', base: 'original' }),
        {
            action: 'pull',
            newDescription: 'revised original',
            newBase: 'revised original',
        }
    );
});

test('pushes an append-only Salesforce change and preserves the normalized Sapphire value for its guard', () => {
    assert.deepEqual(
        decideNotesAction({ sapphire: 'base\r\n', salesforce: 'base\nnew item\n', base: 'base' }),
        {
            action: 'push',
            newSapphireNotes: 'base\nnew item',
            newDescription: 'base\nnew item',
            newBase: 'base\nnew item',
            expectedSapphireNotes: 'base',
        }
    );
});

test('reports a Salesforce earlier-text edit as a conflict', () => {
    assert.deepEqual(
        decideNotesAction({ sapphire: 'base', salesforce: 'changed', base: 'base' }),
        { action: 'conflict', reason: 'salesforce-edited-earlier-text' }
    );
});

test('reports a Sapphire earlier-text edit as a conflict when both sides changed', () => {
    assert.deepEqual(
        decideNotesAction({ sapphire: 'changed in sapphire', salesforce: 'base\nnew in salesforce', base: 'base' }),
        { action: 'conflict', reason: 'sapphire-edited-earlier-text' }
    );
});

test('merges Sapphire additions before Salesforce additions and separates run-together entries', () => {
    assert.deepEqual(
        decideNotesAction({ sapphire: 'baseS', salesforce: 'baseF', base: 'base' }),
        {
            action: 'merge',
            newSapphireNotes: 'base\nS\nF',
            newDescription: 'base\nS\nF',
            newBase: 'base\nS\nF',
            expectedSapphireNotes: 'baseS',
        }
    );
});

test('does not double an existing newline while merging additions', () => {
    assert.deepEqual(
        decideNotesAction({ sapphire: 'base\nS', salesforce: 'base\nF', base: 'base' }),
        {
            action: 'merge',
            newSapphireNotes: 'base\nS\nF',
            newDescription: 'base\nS\nF',
            newBase: 'base\nS\nF',
            expectedSapphireNotes: 'base\nS',
        }
    );
});

test('accepts a 2000-character Salesforce append and rejects a 2001-character append', () => {
    const withinLimit = 'a'.repeat(2000);
    const beyondLimit = 'a'.repeat(2001);

    assert.equal(fitsSapphireLimit(withinLimit), true);
    assert.deepEqual(
        decideNotesAction({ sapphire: '', salesforce: withinLimit, base: '' }),
        {
            action: 'push',
            newSapphireNotes: withinLimit,
            newDescription: withinLimit,
            newBase: withinLimit,
            expectedSapphireNotes: '',
        }
    );
    assert.deepEqual(
        decideNotesAction({ sapphire: '', salesforce: beyondLimit, base: '' }),
        { action: 'tooLong', length: 2001, bytes: 2001 }
    );
});

test('rejects text that fits the character limit but exceeds the conservative UTF-8 byte limit', () => {
    const euroNotes = '€'.repeat(700);

    assert.equal(euroNotes.length, 700);
    assert.deepEqual(
        decideNotesAction({ sapphire: '', salesforce: euroNotes, base: '' }),
        { action: 'tooLong', length: 700, bytes: 2100 }
    );
});

test('reports an oversized merge using the merged text measurements', () => {
    const base = 'a'.repeat(1999);
    assert.deepEqual(
        decideNotesAction({ sapphire: `${base}S`, salesforce: `${base}F`, base }),
        { action: 'tooLong', length: 2003, bytes: 2003 }
    );
});

test('does not mutate its input', () => {
    const input = Object.freeze({ sapphire: 'base\r\nS\n', salesforce: 'base\nF\t', base: 'base\r\n' });
    const before = { ...input };

    decideNotesAction(input);

    assert.deepEqual(input, before);
});
