import assert from 'node:assert/strict';
import test from 'node:test';

import {
    OracleHoldClient,
    SUBMISSION_NOTES_CHUNK_SIZE,
} from '../src/services/oracle-client';

type RequestCall = { url: string; body: { SubmissionIds: string[] } };

function withFakeFetch(
    responder: (call: RequestCall) => unknown,
    run: (calls: RequestCall[]) => Promise<void>
): Promise<void> {
    const originalFetch = global.fetch;
    const calls: RequestCall[] = [];
    global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const call = {
            url: String(input),
            body: JSON.parse(String(init?.body)) as { SubmissionIds: string[] },
        };
        calls.push(call);
        return new Response(JSON.stringify(responder(call)), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    }) as typeof fetch;
    return run(calls).finally(() => { global.fetch = originalFetch; });
}

test('submission-notes lookup trims and de-duplicates IDs, drops blanks, and chunks at 250', async () => {
    const ids = [
        '  sub-0  ',
        'sub-0',
        '',
        '   ',
        ...Array.from({ length: SUBMISSION_NOTES_CHUNK_SIZE }, (_, index) => `sub-${index + 1}`),
    ];

    await withFakeFetch(
        (call) => ({
            SubmissionNotes: call.body.SubmissionIds.map((SUBMISSIONID) => ({
                SUBMISSIONID,
                NOTES: null,
                MODDT: null,
                MODBY: null,
                MODTOOL: null,
            })),
            ErrorMessages: [],
        }),
        async (calls) => {
            const client = new OracleHoldClient({
                baseUrl: 'https://sapphire.example',
                oracleConnectName: 'Dev Name',
            });
            const rows = await client.fetchSubmissionNotes(ids);

            assert.equal(calls.length, 2);
            assert.match(calls[0].url, /Sapphire_GetSubmissionNotes\?oracleConnectName=Dev%20Name/);
            assert.equal(calls[0].body.SubmissionIds.length, SUBMISSION_NOTES_CHUNK_SIZE);
            assert.deepEqual(calls[0].body.SubmissionIds.slice(0, 2), ['sub-0', 'sub-1']);
            assert.deepEqual(calls[1].body.SubmissionIds, ['sub-250']);
            assert.equal(rows.length, SUBMISSION_NOTES_CHUNK_SIZE + 1);
        }
    );
});

test('submission-notes lookup preserves raw notes including CRLF and trailing whitespace', async () => {
    const rawNotes = 'first line\r\nsecond line  \r\n';

    await withFakeFetch(
        () => ({
            SubmissionNotes: [{
                SUBMISSIONID: 'CaseSensitiveId',
                NOTES: rawNotes,
                MODDT: '2026-11-20T12:00:00.000Z',
                MODBY: 'SapphireUser',
                MODTOOL: 'SAPPHIRE',
            }],
            ErrorMessages: [],
        }),
        async () => {
            const client = new OracleHoldClient({
                baseUrl: 'https://sapphire.example',
                oracleConnectName: 'Dev',
            });
            const [row] = await client.fetchSubmissionNotes([' CaseSensitiveId ']);

            assert.equal(row.SUBMISSIONID, 'CaseSensitiveId');
            assert.equal(row.NOTES, rawNotes);
            assert.equal(row.MODBY, 'SapphireUser');
            assert.equal(row.MODTOOL, 'SAPPHIRE');
            assert.equal(row.MODDT?.toISOString(), '2026-11-20T12:00:00.000Z');
        }
    );
});
