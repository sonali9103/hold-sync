import assert from 'node:assert/strict';
import test from 'node:test';

import {
    NotesSyncOptions,
    NotesSyncSubmissionSummary,
    descriptionUpdateIfChanged,
    loadedNotesBase,
    parseNotesSyncOptions,
    runNotesSync,
    SalesforceNotesSyncClient,
    SapphireNotesSource,
} from '../src/notes-sync';
import {
    SapphireNotesClient,
    SapphireNotesResponse,
    SapphireNotesUpdate,
} from '../src/services/sapphire-notes-client';
import { NotesSyncCase, NotesSyncCaseUpdate } from '../src/services/salesforce-client';
import { findMissingNotesSyncFields, NOTES_SYNC_REQUIRED_FIELDS } from '../src/services/salesforce-client';

class FakeSalesforce implements SalesforceNotesSyncClient {
    readonly updates: Array<{ caseId: string; update: NotesSyncCaseUpdate }> = [];
    readonly comments: Array<{ caseId: string; body: string }> = [];
    readonly queries: Array<{ submissionId?: string; limit?: number }> = [];

    constructor(
        private cases: NotesSyncCase[],
        private failCaseIds = new Set<string>()
    ) { }

    async getOpenCasesForNotesSync(options: {
        submissionId?: string;
        limit?: number;
    }): Promise<NotesSyncCase[]> {
        this.queries.push(options);
        let result = this.cases;
        if (options.submissionId) {
            result = result.filter((caseRecord) => caseRecord.submissionId === options.submissionId);
        }
        return options.limit ? result.slice(0, options.limit) : result;
    }

    async updateNotesSyncCase(caseId: string, update: NotesSyncCaseUpdate): Promise<void> {
        if (this.failCaseIds.has(caseId)) throw new Error(`Salesforce write failed for ${caseId}`);
        this.updates.push({ caseId, update });
    }

    async addNotesSyncComment(caseId: string, body: string): Promise<void> {
        if (this.failCaseIds.has(caseId)) throw new Error(`Salesforce comment failed for ${caseId}`);
        this.comments.push({ caseId, body });
    }
}

class FakeSapphireSource implements SapphireNotesSource {
    readonly submissionIdBatches: string[][] = [];

    constructor(private notes: Record<string, string | null>) { }

    async fetchSubmissionNotes(submissionIds: string[]) {
        this.submissionIdBatches.push(submissionIds);
        return submissionIds.flatMap((submissionId) => {
            if (!Object.prototype.hasOwnProperty.call(this.notes, submissionId)) return [];
            return [{
                SUBMISSIONID: submissionId,
                NOTES: this.notes[submissionId],
                MODDT: null,
                MODBY: null,
                MODTOOL: null,
            }];
        });
    }
}

class FakeSapphireNotes implements SapphireNotesClient {
    readonly calls: Array<{ updates: SapphireNotesUpdate[]; dryRun: boolean }> = [];

    constructor(
        private responses: Array<SapphireNotesResponse | Error>
    ) { }

    async appendNotesChunk(updates: SapphireNotesUpdate[], dryRun: boolean): Promise<SapphireNotesResponse> {
        this.calls.push({ updates, dryRun });
        const response = this.responses.shift();
        if (response instanceof Error) throw response;
        if (!response) throw new Error('No fake Sapphire response was queued.');
        return response;
    }
}

function caseRecord(
    caseId: string,
    submissionId: string,
    description: string | null,
    base: string | null,
    syncedAt: string | null = base === '' ? '2026-11-18T12:00:00.000Z' : null,
    status: string | null = null,
    message: string | null = null
): NotesSyncCase {
    return {
        caseId,
        caseNumber: `000${caseId}`,
        submissionId,
        description,
        base,
        syncedAt,
        status,
        message,
    };
}

function response(...Results: SapphireNotesResponse['Results']): SapphireNotesResponse {
    return { DryRun: false, Results, ErrorMessages: [] };
}

const applyOptions: NotesSyncOptions = {
    apply: true,
    apiDryRun: false,
    submissionId: 'sub-1',
    allLocal: false,
};

async function run(
    cases: NotesSyncCase[],
    notes: Record<string, string | null>,
    options: NotesSyncOptions,
    sapphireResponses: Array<SapphireNotesResponse | Error> = []
): Promise<{
    salesforce: FakeSalesforce;
    source: FakeSapphireSource;
    sapphire: FakeSapphireNotes;
    summaries: NotesSyncSubmissionSummary[];
    logs: string[];
}> {
    const salesforce = new FakeSalesforce(cases);
    const source = new FakeSapphireSource(notes);
    const sapphire = new FakeSapphireNotes(sapphireResponses);
    const logs: string[] = [];
    const result = await runNotesSync(options, {
        salesforce,
        sapphireSource: source,
        sapphireNotes: sapphire,
        now: () => new Date('2026-11-19T12:00:00.000Z'),
        logger: { log: (message) => logs.push(message) },
    });
    return { salesforce, source, sapphire, summaries: result.submissions, logs };
}

test('never-baselined Case stays baseline and stores the timestamp marker without a Sapphire write', async () => {
    const result = await run(
        [caseRecord('1', 'sub-1', 'Salesforce text is ignored for the first baseline', null)],
        { 'sub-1': 'Sapphire text' },
        applyOptions
    );

    assert.deepEqual(result.salesforce.updates, [{
        caseId: '1',
        update: { base: 'Sapphire text', syncedAt: new Date('2026-11-19T12:00:00.000Z') },
    }]);
    assert.equal(result.sapphire.calls.length, 0);
    assert.equal(result.summaries[0].outcome, 'baseline');
});

test('a null Sapphire NOTES value is distinct from a missing submission-notes row', async () => {
    const found = await run(
        [caseRecord('1', 'sub-1', 'Salesforce text', null)],
        { 'sub-1': null },
        applyOptions
    );
    assert.equal(found.summaries[0].outcome, 'baseline');
    assert.deepEqual(found.salesforce.updates, [{
        caseId: '1',
        update: { base: '', syncedAt: new Date('2026-11-19T12:00:00.000Z') },
    }]);

    const missing = await run(
        [caseRecord('1', 'sub-1', 'base\nSalesforce addition', 'base')],
        {},
        applyOptions
    );
    assert.equal(missing.summaries[0].outcome, 'Error');
    assert.match(missing.summaries[0].message, /absent from the Sapphire submission-notes response/);
    assert.deepEqual(missing.sapphire.calls, []);
    assert.deepEqual(missing.salesforce.updates, [{
        caseId: '1',
        update: {
            status: 'Error',
            message: 'Submission was absent from the Sapphire submission-notes response.',
        },
    }]);
});

test('baseline fills an empty Description only when Sapphire notes differ after normalization', async () => {
    const result = await run(
        [caseRecord('1', 'sub-1', '', null)],
        { 'sub-1': 'Sapphire text\r\n' },
        applyOptions
    );

    assert.deepEqual(result.salesforce.updates, [{
        caseId: '1',
        update: {
            description: 'Sapphire text',
            base: 'Sapphire text',
            syncedAt: new Date('2026-11-19T12:00:00.000Z'),
        },
    }]);
});

test('a null stored base with Notes_Synced_At set is an empty baseline and pushes a new Salesforce note', async () => {
    const result = await run(
        [caseRecord('1', 'sub-1', 'Salesforce note', null, '2026-11-18T12:00:00.000Z')],
        { 'sub-1': '' },
        applyOptions,
        [response({ SubmissionId: 'sub-1', Outcome: 'Updated', Message: null })]
    );

    assert.deepEqual(result.sapphire.calls[0].updates, [{
        SubmissionId: 'sub-1',
        ExpectedNotes: '',
        AppendText: 'Salesforce note',
    }]);
    assert.equal(result.summaries[0].decisions[0].action, 'push');
});

test('derives a null or empty decision base from the base marker exactly once at load time', () => {
    assert.equal(loadedNotesBase(null, null), null);
    assert.equal(loadedNotesBase('', null), null);
    assert.equal(loadedNotesBase(null, '2026-11-18T12:00:00.000Z'), '');
    assert.equal(loadedNotesBase('\r\n\t', '2026-11-18T12:00:00.000Z'), '');
    assert.equal(loadedNotesBase('existing base', null), 'existing base');
});

test('already Synced no-op runs make no Salesforce update calls', async () => {
    const result = await run(
        [caseRecord('1', 'sub-1', 'same', 'same', null, 'Synced')],
        { 'sub-1': 'same' },
        applyOptions
    );

    assert.deepEqual(result.salesforce.updates, []);
    assert.equal(result.sapphire.calls.length, 0);
    assert.equal(result.summaries[0].outcome, 'noop');
});

test('Conflict to noop clears stale status and stamps the Case as Synced', async () => {
    const result = await run(
        [caseRecord('1', 'sub-1', 'same', 'same', null, 'Conflict', 'earlier conflict')],
        { 'sub-1': 'same' },
        applyOptions
    );

    assert.deepEqual(result.salesforce.updates, [{
        caseId: '1',
        update: {
            status: 'Synced',
            message: null,
            syncedAt: new Date('2026-11-19T12:00:00.000Z'),
        },
    }]);
});

test('TooLong to noop clears stale status and stamps the Case as Synced', async () => {
    const result = await run(
        [caseRecord('1', 'sub-1', 'same', 'same', null, 'TooLong', 'earlier length error')],
        { 'sub-1': 'same' },
        applyOptions
    );

    assert.deepEqual(result.salesforce.updates, [{
        caseId: '1',
        update: {
            status: 'Synced',
            message: null,
            syncedAt: new Date('2026-11-19T12:00:00.000Z'),
        },
    }]);
});

test('sets only the base when Salesforce and Sapphire agree', async () => {
    const result = await run(
        [caseRecord('1', 'sub-1', 'current', 'old base', null, 'Synced')],
        { 'sub-1': 'current' },
        applyOptions
    );

    assert.deepEqual(result.salesforce.updates, [{ caseId: '1', update: { base: 'current' } }]);
    assert.equal(result.sapphire.calls.length, 0);
    assert.equal(result.summaries[0].outcome, 'setBase');
});

test('pulls Sapphire edits into Salesforce without a Sapphire write', async () => {
    const result = await run(
        [caseRecord('1', 'sub-1', 'old text', 'old text', null, 'Synced')],
        { 'sub-1': 'Sapphire edited earlier text' },
        applyOptions
    );

    assert.deepEqual(result.salesforce.updates, [{
        caseId: '1',
        update: { description: 'Sapphire edited earlier text', base: 'Sapphire edited earlier text' },
    }]);
    assert.equal(result.sapphire.calls.length, 0);
    assert.equal(result.summaries[0].outcome, 'pull');
});

test('pushes only the addition, leaves Description untouched, and comments after Updated', async () => {
    const result = await run(
        [caseRecord('1', 'sub-1', 'base\nSalesforce addition', 'base')],
        { 'sub-1': 'base' },
        applyOptions,
        [response({ SubmissionId: 'sub-1', Outcome: 'Updated', Message: null })]
    );

    assert.deepEqual(result.sapphire.calls, [{
        dryRun: false,
        updates: [{
            SubmissionId: 'sub-1',
            ExpectedNotes: 'base',
            AppendText: '\nSalesforce addition',
        }],
    }]);
    assert.notEqual(result.sapphire.calls[0].updates[0].AppendText, 'base\nSalesforce addition');
    assert.deepEqual(result.salesforce.updates, [{
        caseId: '1',
        update: {
            base: 'base\nSalesforce addition',
            status: 'Synced',
            syncedAt: new Date('2026-11-19T12:00:00.000Z'),
        },
    }]);
    assert.deepEqual(result.salesforce.comments, [{ caseId: '1', body: 'Salesforce addition' }]);
    assert.equal(result.summaries[0].outcome, 'Updated');
});

test('Locked to a successful push clears stale status after Sapphire confirms Updated', async () => {
    const result = await run(
        [caseRecord('1', 'sub-1', 'base\nSalesforce addition', 'base', null, 'Locked', 'remote lock')],
        { 'sub-1': 'base' },
        applyOptions,
        [response({ SubmissionId: 'sub-1', Outcome: 'Updated', Message: null })]
    );

    assert.deepEqual(result.salesforce.updates, [{
        caseId: '1',
        update: {
            base: 'base\nSalesforce addition',
            status: 'Synced',
            message: null,
            syncedAt: new Date('2026-11-19T12:00:00.000Z'),
        },
    }]);
});

test('merges Sapphire and Salesforce appends with an addition-only Sapphire request', async () => {
    const result = await run(
        [caseRecord('1', 'sub-1', 'base\nSalesforce addition', 'base')],
        { 'sub-1': 'base\nSapphire addition' },
        applyOptions,
        [response({ SubmissionId: 'sub-1', Outcome: 'Updated', Message: 'merged' })]
    );

    assert.deepEqual(result.sapphire.calls[0].updates, [{
        SubmissionId: 'sub-1',
        ExpectedNotes: 'base\nSapphire addition',
        AppendText: '\nSalesforce addition',
    }]);
    assert.equal(result.salesforce.updates[0].update.description, 'base\nSapphire addition\nSalesforce addition');
    assert.deepEqual(result.salesforce.comments, [{ caseId: '1', body: 'Salesforce addition' }]);
});

test('pull skips a Description update when the current and target values normalize equally', () => {
    const currentCase = caseRecord('1', 'sub-1', 'same\r\n', 'old base');

    assert.deepEqual(descriptionUpdateIfChanged(currentCase, 'same'), {});
});

test('maps both decision conflicts and too-long notes to Salesforce statuses without Sapphire writes', async () => {
    const conflict = await run(
        [caseRecord('1', 'sub-1', 'edited instead', 'base')],
        { 'sub-1': 'base' },
        applyOptions
    );
    assert.deepEqual(conflict.salesforce.updates, [{
        caseId: '1',
        update: { status: 'Conflict', message: 'salesforce-edited-earlier-text' },
    }]);

    const sapphireConflict = await run(
        [caseRecord('1', 'sub-1', 'base\nSalesforce addition', 'base')],
        { 'sub-1': 'Sapphire edited instead' },
        applyOptions
    );
    assert.deepEqual(sapphireConflict.salesforce.updates, [{
        caseId: '1',
        update: { status: 'Conflict', message: 'sapphire-edited-earlier-text' },
    }]);

    const tooLong = await run(
        [caseRecord('1', 'sub-1', 'a'.repeat(2001), '')],
        { 'sub-1': '' },
        applyOptions
    );
    assert.deepEqual(tooLong.salesforce.updates, [{
        caseId: '1',
        update: { status: 'TooLong', message: 'Notes are 2001 characters and 2001 UTF-8 bytes.' },
    }]);
    assert.equal(tooLong.sapphire.calls.length, 0);
});

test('a still-conflicting Case keeps its Conflict status and message', async () => {
    const result = await run(
        [caseRecord('1', 'sub-1', 'edited instead', 'base', null, 'Conflict', 'salesforce-edited-earlier-text')],
        { 'sub-1': 'base' },
        applyOptions
    );

    assert.deepEqual(result.salesforce.updates, []);
    assert.equal(result.summaries[0].outcome, 'Conflict');
});

test('combines two sibling Cases into one append and updates every sibling after Updated', async () => {
    const result = await run(
        [
            caseRecord('a', 'sub-1', 'base\nfirst sibling addition', 'base'),
            caseRecord('b', 'sub-1', 'base\nsecond sibling addition', 'base'),
        ],
        { 'sub-1': 'base' },
        applyOptions,
        [response({ SubmissionId: 'sub-1', Outcome: 'Updated', Message: null })]
    );

    assert.equal(result.sapphire.calls.length, 1);
    assert.deepEqual(result.sapphire.calls[0].updates, [{
        SubmissionId: 'sub-1',
        ExpectedNotes: 'base',
        AppendText: '\nfirst sibling addition\nsecond sibling addition',
    }]);
    assert.equal(result.salesforce.updates.length, 2);
    assert.equal(result.salesforce.updates[0].update.description, undefined);
    assert.equal(result.salesforce.updates[1].update.description, undefined);
    assert.equal(result.salesforce.updates[0].update.base, 'base\nfirst sibling addition\nsecond sibling addition');
    assert.equal(result.salesforce.updates[1].update.base, 'base\nfirst sibling addition\nsecond sibling addition');
    assert.deepEqual(result.salesforce.comments, [
        { caseId: 'a', body: 'first sibling addition\nsecond sibling addition' },
        { caseId: 'b', body: 'first sibling addition\nsecond sibling addition' },
    ]);
});

test('combines siblings when one has an empty baseline marker and the other has never been baselined', async () => {
    const result = await run(
        [
            caseRecord('a', 'sub-1', 'new local note', null, '2026-11-18T12:00:00.000Z'),
            caseRecord('b', 'sub-1', 'ignored until baseline', null, null),
        ],
        { 'sub-1': '' },
        applyOptions,
        [response({ SubmissionId: 'sub-1', Outcome: 'Updated', Message: null })]
    );

    assert.deepEqual(result.sapphire.calls[0].updates, [{
        SubmissionId: 'sub-1',
        ExpectedNotes: '',
        AppendText: 'new local note',
    }]);
    assert.deepEqual(result.summaries[0].decisions.map((decision) => decision.action), [
        'push',
        'baseline',
    ]);
    assert.equal(result.salesforce.updates.length, 2);
});

test('maps Changed to Pending and succeeds on a later retry', async () => {
    const cases = [caseRecord('1', 'sub-1', 'base\nretry me', 'base')];
    const changed = await run(
        cases,
        { 'sub-1': 'base' },
        applyOptions,
        [response({ SubmissionId: 'sub-1', Outcome: 'Changed', Message: 'notes changed remotely' })]
    );
    assert.deepEqual(changed.salesforce.updates, [{
        caseId: '1',
        update: { status: 'Pending', message: 'notes changed remotely' },
    }]);
    assert.deepEqual(changed.salesforce.comments, []);

    const retried = await run(
        cases,
        { 'sub-1': 'base' },
        applyOptions,
        [response({ SubmissionId: 'sub-1', Outcome: 'Updated', Message: null })]
    );
    assert.equal(retried.salesforce.updates[0].update.status, 'Synced');
    assert.deepEqual(retried.salesforce.comments, [{ caseId: '1', body: 'retry me' }]);
});

test('maps Locked to Locked and does not apply the planned Case content', async () => {
    const result = await run(
        [caseRecord('1', 'sub-1', 'base\nlocked addition', 'base')],
        { 'sub-1': 'base' },
        applyOptions,
        [response({ SubmissionId: 'sub-1', Outcome: 'Locked', Message: 'currently locked' })]
    );

    assert.deepEqual(result.salesforce.updates, [{
        caseId: '1',
        update: { status: 'Locked', message: 'currently locked' },
    }]);
    assert.deepEqual(result.salesforce.comments, []);
});

test('maps Sapphire TooLong to TooLong and other returned outcomes to Error', async () => {
    const tooLong = await run(
        [caseRecord('1', 'sub-1', 'base\nremote length check', 'base')],
        { 'sub-1': 'base' },
        applyOptions,
        [response({ SubmissionId: 'sub-1', Outcome: 'TooLong', Message: 'database byte limit' })]
    );
    assert.deepEqual(tooLong.salesforce.updates, [{
        caseId: '1',
        update: { status: 'TooLong', message: 'database byte limit' },
    }]);

    const rejected = await run(
        [caseRecord('1', 'sub-1', 'base\nrejected remotely', 'base')],
        { 'sub-1': 'base' },
        applyOptions,
        [response({ SubmissionId: 'sub-1', Outcome: 'Rejected', Message: 'service rejected note' })]
    );
    assert.deepEqual(rejected.salesforce.updates, [{
        caseId: '1',
        update: { status: 'Error', message: 'service rejected note' },
    }]);
});

test('continues after a partial Sapphire batch failure', async () => {
    const result = await run(
        [
            caseRecord('1', 'sub-1', 'base\nfirst', 'base'),
            caseRecord('2', 'sub-2', 'base\nsecond', 'base'),
        ],
        { 'sub-1': 'base', 'sub-2': 'base' },
        { apply: true, apiDryRun: false },
        [response(
            { SubmissionId: 'sub-1', Outcome: 'Updated', Message: null },
            { SubmissionId: 'sub-2', Outcome: 'Error', Message: 'rejected by service' }
        )]
    );

    assert.equal(result.sapphire.calls.length, 1);
    assert.equal(result.salesforce.updates[0].caseId, '1');
    assert.deepEqual(result.salesforce.updates[1], {
        caseId: '2',
        update: { status: 'Error', message: 'rejected by service' },
    });
    assert.deepEqual(result.summaries.map((summary) => summary.outcome), ['Updated', 'Error']);
});

test('dry run makes no Salesforce or Sapphire writes and prints the planned append', async () => {
    const cases = [caseRecord('1', 'sub-1', 'base\npreview', 'base')];
    const salesforce = new FakeSalesforce(cases);
    const source = new FakeSapphireSource({ 'sub-1': 'base' });
    const logs: string[] = [];

    const result = await runNotesSync(
        { apply: false, apiDryRun: false },
        { salesforce, sapphireSource: source, logger: { log: (message) => logs.push(message) } }
    );

    assert.deepEqual(salesforce.updates, []);
    assert.deepEqual(salesforce.comments, []);
    assert.equal(result.submissions[0].outcome, 'WouldSend');
    assert.match(result.submissions[0].message, /\\npreview/);
    assert.equal(logs.filter((line) => line.startsWith('Submission ')).length, 1);
    assert.match(logs[0], /1 Case\(s\); Case 0001 \(1\): push/);
});

test('skips a Case whose submission ID property is absent instead of grouping it as undefined', async () => {
    const salesforce = new FakeSalesforce([
        {
            caseId: 'missing-submission',
            caseNumber: '000missing',
            description: 'not processed',
            base: null,
            status: null,
        },
    ]);
    const source = new FakeSapphireSource({});
    const logs: string[] = [];

    const result = await runNotesSync(
        { apply: false, apiDryRun: false },
        { salesforce, sapphireSource: source, logger: { log: (message) => logs.push(message) } }
    );

    assert.deepEqual(result.submissions, []);
    assert.deepEqual(result.totals, { 'Skipped: no submission ID': 1 });
    assert.deepEqual(source.submissionIdBatches, []);
    assert.deepEqual(salesforce.updates, []);
    assert.ok(logs.includes('  Skipped: no submission ID: 1'));
});

test('API dry run sends bDryRun true but never writes Salesforce', async () => {
    const result = await run(
        [caseRecord('1', 'sub-1', 'base\npreview', 'base')],
        { 'sub-1': 'base' },
        { apply: false, apiDryRun: true },
        [response({ SubmissionId: 'sub-1', Outcome: 'WouldUpdate', Message: 'validated' })]
    );

    assert.equal(result.sapphire.calls[0].dryRun, true);
    assert.deepEqual(result.salesforce.updates, []);
    assert.deepEqual(result.salesforce.comments, []);
    assert.equal(result.summaries[0].outcome, 'WouldUpdate');
});

test('--apply --all-local updates all local-only decisions without a Sapphire write', async () => {
    const result = await run(
        [
            caseRecord('1', 'sub-1', 'untrusted first Description', null),
            caseRecord('2', 'sub-2', 'same', 'same', null, 'Synced'),
        ],
        { 'sub-1': 'Sapphire one', 'sub-2': 'same' },
        { apply: true, apiDryRun: false, allLocal: true }
    );

    assert.equal(result.sapphire.calls.length, 0);
    assert.deepEqual(result.salesforce.updates, [{
        caseId: '1',
        update: { base: 'Sapphire one', syncedAt: new Date('2026-11-19T12:00:00.000Z') },
    }]);
    assert.deepEqual(result.summaries.map((summary) => summary.outcome), ['baseline', 'noop']);
});

test('--apply --all-local refuses every write when a submission needs a Sapphire append', async () => {
    const result = await run(
        [
            caseRecord('1', 'needs-sapphire', 'base\nnew note', 'base'),
            caseRecord('2', 'local-only', 'first value', null),
        ],
        { 'needs-sapphire': 'base', 'local-only': 'Sapphire local' },
        { apply: true, apiDryRun: false, allLocal: true }
    );

    assert.equal(result.sapphire.calls.length, 0);
    assert.deepEqual(result.salesforce.updates, []);
    assert.deepEqual(result.summaries.map((summary) => summary.outcome), [
        'AllLocalRefused',
        'AllLocalRefused',
    ]);
    assert.match(result.summaries[0].message, /needs-sapphire/);
    assert.match(result.summaries[0].message, /--submission <id>/);
});

test('stops Sapphire note writes at the configured per-run cap', async () => {
    const result = await run(
        [
            caseRecord('1', 'sub-1', 'base\nfirst', 'base'),
            caseRecord('2', 'sub-2', 'base\nsecond', 'base'),
        ],
        { 'sub-1': 'base', 'sub-2': 'base' },
        { apply: true, apiDryRun: false, maxWrites: 1 },
        [response({ SubmissionId: 'sub-1', Outcome: 'Updated', Message: null })]
    );

    assert.deepEqual(result.sapphire.calls[0].updates.map((update) => update.SubmissionId), ['sub-1']);
    assert.deepEqual(result.summaries.map((summary) => summary.outcome), ['Updated', 'WriteCapReached']);
    assert.match(result.summaries[1].message, /write cap of 1 reached/);
});

test('CLI parsing defaults to dry run and requires a Dev-only target for apply', () => {
    assert.deepEqual(parseNotesSyncOptions([]), {
        apply: false,
        apiDryRun: false,
        submissionId: undefined,
        allLocal: false,
        limit: undefined,
    });
    assert.deepEqual(parseNotesSyncOptions(['--apply', '--submission', '123', '--limit', '2']), {
        apply: true,
        apiDryRun: false,
        submissionId: '123',
        allLocal: false,
        limit: 2,
    });
    assert.throws(
        () => parseNotesSyncOptions(['--apply']),
        /--apply requires --submission <id> or --all-local/
    );
    assert.deepEqual(parseNotesSyncOptions(['--apply', '--all-local']), {
        apply: true,
        apiDryRun: false,
        submissionId: undefined,
        allLocal: true,
        limit: undefined,
    });
    assert.throws(() => parseNotesSyncOptions(['--all-local']), /--all-local requires --apply/);
});

test('names every missing Salesforce notes-sync field before querying Cases', () => {
    assert.deepEqual(findMissingNotesSyncFields([]), [...NOTES_SYNC_REQUIRED_FIELDS]);
    assert.deepEqual(findMissingNotesSyncFields(NOTES_SYNC_REQUIRED_FIELDS), []);
});
