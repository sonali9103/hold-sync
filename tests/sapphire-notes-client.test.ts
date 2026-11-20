import assert from 'node:assert/strict';
import test from 'node:test';

import {
    chunkNotesUpdates,
    NOTES_CHUNK_SIZE,
    SapphireNotesApiClient,
    SapphireNotesUpdate,
} from '../src/services/sapphire-notes-client';

test('chunks Sapphire note updates into groups of 25', () => {
    const updates: SapphireNotesUpdate[] = Array.from({ length: NOTES_CHUNK_SIZE + 1 }, (_, index) => ({
        SubmissionId: String(index),
        ExpectedNotes: '',
        AppendText: 'note',
    }));

    assert.deepEqual(chunkNotesUpdates(updates).map((chunk) => chunk.length), [25, 1]);
});

test('accepts a per-item result payload even when Sapphire responds with HTTP 500', async (t) => {
    const originalFetch = global.fetch;
    let request: { url: string; init?: RequestInit } | undefined;
    global.fetch = async (url, init) => {
        request = { url: String(url), init };
        return new Response(JSON.stringify({
            DryRun: false,
            Results: [{ SubmissionId: '42', Outcome: 'Locked', Message: 'locked' }],
            ErrorMessages: [{ Description: 'one record was locked' }],
        }), { status: 500, statusText: 'Internal Server Error' });
    };
    t.after(() => { global.fetch = originalFetch; });

    const client = new SapphireNotesApiClient({
        baseUrl: 'https://sapphire.example/',
        oracleConnectName: 'Dev Name',
    });
    const result = await client.appendNotesChunk([
        { SubmissionId: '42', ExpectedNotes: 'existing', AppendText: '\nnext' },
    ], false);

    assert.deepEqual(result.Results, [{ SubmissionId: '42', Outcome: 'Locked', Message: 'locked' }]);
    assert.equal(
        request?.url,
        'https://sapphire.example/api/DDILibrary/Sapphire_AppendNotes?oracleConnectName=Dev%20Name'
    );
    assert.deepEqual(JSON.parse(String(request?.init?.body)), {
        Updates: [{ SubmissionId: '42', ExpectedNotes: 'existing', AppendText: '\nnext' }],
        bDryRun: false,
        ModifiedBy: 'sfsync',
    });
});

test('reports an HTTP error without per-item results as a request failure', async (t) => {
    const originalFetch = global.fetch;
    global.fetch = async () => new Response(JSON.stringify({
        ErrorMessages: [{ Description: 'service unavailable' }],
    }), { status: 500, statusText: 'Internal Server Error' });
    t.after(() => { global.fetch = originalFetch; });

    const client = new SapphireNotesApiClient({ baseUrl: 'https://sapphire.example', oracleConnectName: 'Dev' });
    await assert.rejects(
        client.appendNotesChunk([{ SubmissionId: '42', ExpectedNotes: '', AppendText: 'next' }], false),
        /service unavailable/
    );
});
