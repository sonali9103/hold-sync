import assert from 'node:assert/strict';
import test from 'node:test';

import {
    DEFAULT_MAX_WRITES,
    parseSfToSapphireOptions,
    runSfToSapphire,
} from '../src/sf-to-sapphire';
import { ReleaseSyncRunResult } from '../src/release-sync';
import { NotesSyncRunResult } from '../src/notes-sync';

function releaseResult(overrides: Partial<ReleaseSyncRunResult> = {}): ReleaseSyncRunResult {
    return {
        candidateCount: 0,
        counts: {
            Released: 0,
            WouldRelease: 0,
            AlreadyReleased: 0,
            NotFound: 0,
            Rejected: 0,
            Error: 0,
        },
        failedCaseNumbers: [],
        dryRunRows: [],
        hasError: false,
        errors: [],
        ...overrides,
    };
}

function notesResult(overrides: Partial<NotesSyncRunResult> = {}): NotesSyncRunResult {
    return {
        submissions: [],
        totals: {},
        refused: false,
        writeCapReached: false,
        ...overrides,
    };
}

test('runs release before notes in dry-run mode and forwards dry-run options to both', async () => {
    const calls: string[] = [];
    const logs: string[] = [];
    const options = parseSfToSapphireOptions([]);

    const result = await runSfToSapphire(options, {
        runRelease: async (releaseOptions) => {
            calls.push('release');
            assert.equal(releaseOptions.apply, false);
            assert.equal(releaseOptions.apiDryRun, false);
            assert.equal(releaseOptions.limit, undefined);
            return releaseResult({ counts: { ...releaseResult().counts, WouldRelease: 2 } });
        },
        runNotes: async (notesOptions) => {
            calls.push('notes');
            assert.equal(notesOptions.apply, false);
            assert.equal(notesOptions.apiDryRun, false);
            assert.equal(notesOptions.maxWrites, DEFAULT_MAX_WRITES);
            return notesResult({ totals: { WouldSend: 3 } });
        },
        logger: { log: (line) => logs.push(line) },
    });

    assert.deepEqual(calls, ['release', 'notes']);
    assert.equal(result.hasError, false);
    assert.ok(logs.some((line) => line === 'Salesforce-to-Sapphire summary:'));
});

test('forwards apply, API dry-run, limit, and write cap to the two steps', async () => {
    const options = parseSfToSapphireOptions([
        '--apply',
        '--only-hold-ids', '101,102',
        '--limit', '4',
        '--max-writes', '2',
    ]);

    await runSfToSapphire(options, {
        runRelease: async (releaseOptions) => {
            assert.deepEqual(releaseOptions, {
                apply: true,
                apiDryRun: false,
                onlyHoldIds: ['101', '102'],
                limit: 4,
            });
            return releaseResult({ counts: { ...releaseResult().counts, Released: 1 } });
        },
        runNotes: async (notesOptions) => {
            assert.deepEqual(notesOptions, {
                apply: true,
                apiDryRun: false,
                limit: 4,
                maxWrites: 2,
            });
            return notesResult({ totals: { Updated: 1 } });
        },
        logger: { log: () => undefined },
    });
});

test('forwards --api-dry-run to both steps in dry-run mode', async () => {
    const options = parseSfToSapphireOptions(['--api-dry-run']);

    await runSfToSapphire(options, {
        runRelease: async (releaseOptions) => {
            assert.equal(releaseOptions.apply, false);
            assert.equal(releaseOptions.apiDryRun, true);
            return releaseResult();
        },
        runNotes: async (notesOptions) => {
            assert.equal(notesOptions.apply, false);
            assert.equal(notesOptions.apiDryRun, true);
            return notesResult();
        },
        logger: { log: () => undefined },
    });
});

test('continues with notes when release fails', async () => {
    let notesRan = false;
    const result = await runSfToSapphire(parseSfToSapphireOptions([]), {
        runRelease: async () => { throw new Error('release service unavailable'); },
        runNotes: async () => {
            notesRan = true;
            return notesResult({ totals: { noop: 1 } });
        },
        logger: { log: () => undefined },
    });

    assert.equal(notesRan, true);
    assert.equal(result.releaseError, 'release service unavailable');
    assert.equal(result.hasError, true);
});

test('reports a reached notes write cap without treating non-error outcomes as an error', async () => {
    const logs: string[] = [];
    const result = await runSfToSapphire(parseSfToSapphireOptions([]), {
        runRelease: async () => releaseResult({
            counts: { ...releaseResult().counts, Rejected: 1 },
        }),
        runNotes: async () => notesResult({
            totals: { Conflict: 1, Locked: 1, TooLong: 1, Pending: 1, WriteCapReached: 2 },
            writeCapReached: true,
        }),
        logger: { log: (line) => logs.push(line) },
    });

    assert.equal(result.hasError, false);
    assert.ok(logs.some((line) => /write cap reached/.test(line)));
});

test('returns an error exit signal only for Error outcomes', async () => {
    const noError = await runSfToSapphire(parseSfToSapphireOptions([]), {
        runRelease: async () => releaseResult({
            counts: { ...releaseResult().counts, NotFound: 1, Rejected: 1 },
        }),
        runNotes: async () => notesResult({ totals: { Conflict: 1, Locked: 1, TooLong: 1, Pending: 1 } }),
        logger: { log: () => undefined },
    });
    assert.equal(noError.hasError, false);

    const releaseError = await runSfToSapphire(parseSfToSapphireOptions([]), {
        runRelease: async () => releaseResult({
            counts: { ...releaseResult().counts, Error: 1 },
            hasError: true,
        }),
        runNotes: async () => notesResult(),
        logger: { log: () => undefined },
    });
    assert.equal(releaseError.hasError, true);

    const notesError = await runSfToSapphire(parseSfToSapphireOptions([]), {
        runRelease: async () => releaseResult(),
        runNotes: async () => notesResult({ totals: { Error: 1 } }),
        logger: { log: () => undefined },
    });
    assert.equal(notesError.hasError, true);
});
