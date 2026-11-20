import assert from 'node:assert/strict';
import test from 'node:test';

import { HoldTicketRecord } from '../src/transform';
import {
    CASE_EXTERNAL_ID_FIELD,
    CASE_SUBMISSION_ID_FIELD,
    hasNotesSyncCaseUpdate,
    NOTES_SYNC_REQUIRED_FIELDS,
    SalesforceHoldClient,
} from '../src/services/salesforce-client';

type SalesforceRecord = Record<string, unknown>;

const ticket: HoldTicketRecord = {
    externalId: 'hold-1',
    submissionId: 'submission-42',
    doctorId: null,
    subAccountId: null,
    doctorName: null,
    doctorPhone: null,
    patientName: null,
    patientPhone: null,
    holdSource: 'Sapphire',
    patientId: null,
    holdType: 'Hold type',
    notes: 'Sapphire current notes',
    sourceTool: 'Sapphire',
    createdBy: 'test',
    createdDate: new Date('2026-11-19T00:00:00.000Z'),
    isResolved: false,
    resolvedBy: null,
    resolvedDate: null,
};

function clientForUpsert(existingCase: SalesforceRecord | null): {
    client: SalesforceHoldClient;
    lookupFields: string[] | undefined;
    upserts: Array<{ record: SalesforceRecord; externalIdField: string }>;
} {
    let lookupFields: string[] | undefined;
    const upserts: Array<{ record: SalesforceRecord; externalIdField: string }> = [];
    const caseObject = {
        findOne: async (_filter: unknown, fields: string[]) => {
            lookupFields = fields;
            return existingCase;
        },
        upsert: async (record: SalesforceRecord, externalIdField: string) => {
            upserts.push({ record, externalIdField });
            return { id: 'case-1' };
        },
    };
    const connection = {
        sobject: (name: string) => {
            if (name === 'Case') return caseObject;
            throw new Error(`Unexpected sObject ${name}`);
        },
    };
    const client = new SalesforceHoldClient({
        loginUrl: 'https://fake.example',
        username: 'fake',
        password: 'fake',
        securityToken: 'fake',
        defaultOwnerUsername: 'fake',
    });
    const mutableClient = client as unknown as {
        conn: unknown;
        defaultOwnerId: string;
        caseRecordTypeId: string;
    };
    mutableClient.conn = connection;
    mutableClient.defaultOwnerId = 'owner-1';
    mutableClient.caseRecordTypeId = 'record-type-1';

    return {
        client,
        get lookupFields() { return lookupFields; },
        upserts,
    };
}

async function upsertWithExisting(existingCase: SalesforceRecord | null): Promise<{
    lookupFields: string[] | undefined;
    record: SalesforceRecord;
}> {
    const setup = clientForUpsert(existingCase);
    await setup.client.upsertTicket(ticket);
    assert.equal(setup.upserts.length, 1);
    return { lookupFields: setup.lookupFields, record: setup.upserts[0].record };
}

test('uses the exact capital-ID submission field in notes-sync queries and record mapping', async () => {
    let query = '';
    const connection = {
        sobject: (name: string) => {
            assert.equal(name, 'Case');
            return {
                describe: async () => ({ fields: NOTES_SYNC_REQUIRED_FIELDS.map((field) => ({ name: field })) }),
            };
        },
        query: async (soql: string) => {
            query = soql;
            return {
                done: true,
                records: [{
                    Id: 'case-1',
                    CaseNumber: '0001',
                    [CASE_SUBMISSION_ID_FIELD]: 'submission-42',
                    Description: 'description',
                    Sapphire_Notes_Synced__c: 'base',
                    Notes_Synced_At__c: '2026-11-19T12:00:00.000Z',
                    Notes_Sync_Status__c: null,
                    Notes_Sync_Message__c: null,
                }],
            };
        },
    };
    const client = new SalesforceHoldClient({
        loginUrl: 'https://fake.example',
        username: 'fake',
        password: 'fake',
        securityToken: 'fake',
        defaultOwnerUsername: 'fake',
    });
    (client as unknown as { conn: unknown }).conn = connection;

    const cases = await client.getOpenCasesForNotesSync({ submissionId: 'submission-42' });

    assert.match(query, /Sapphire_Submission_ID__c/);
    assert.equal(query.includes(['Sapphire', 'Submission', 'Id__c'].join('_')), false);
    assert.equal(cases[0].submissionId, 'submission-42');
    assert.equal(cases[0].syncedAt, '2026-11-19T12:00:00.000Z');
    assert.equal(cases[0].message, null);
});

test('does not send an empty notes-sync update to Salesforce', () => {
    assert.equal(hasNotesSyncCaseUpdate({}), false);
    assert.equal(hasNotesSyncCaseUpdate({ status: 'Synced' }), true);
});

test('Salesforce client skips the update call when no notes-sync field changed', async () => {
    let updateCalls = 0;
    const client = new SalesforceHoldClient({
        loginUrl: 'https://fake.example',
        username: 'fake',
        password: 'fake',
        securityToken: 'fake',
        defaultOwnerUsername: 'fake',
    });
    (client as unknown as { conn: unknown }).conn = {
        sobject: (name: string) => {
            assert.equal(name, 'Case');
            return {
                update: async () => {
                    updateCalls++;
                    return { success: true };
                },
            };
        },
    };

    await client.updateNotesSyncCase('case-1', {});

    assert.equal(updateCalls, 0);
});

test('preserves a pending Salesforce Description edit during a hold-sync upsert', async () => {
    const result = await upsertWithExisting({
        Id: 'case-1',
        Status: 'New',
        Description: 'base\r\nSalesforce edit',
        Sapphire_Notes_Synced__c: 'base\n',
    });

    assert.deepEqual(result.lookupFields, ['Id', 'Status', 'Description', 'Sapphire_Notes_Synced__c']);
    assert.equal('Description' in result.record, false);
    assert.equal('Sapphire_Notes_Synced__c' in result.record, false);
    assert.equal(result.record[CASE_SUBMISSION_ID_FIELD], 'submission-42');
    assert.equal(result.record[CASE_EXTERNAL_ID_FIELD], 'hold-1');
});

test('overwrites Description during a hold-sync upsert when Description matches the base', async () => {
    const result = await upsertWithExisting({
        Id: 'case-1',
        Status: 'New',
        Description: 'base\r\n',
        Sapphire_Notes_Synced__c: 'base\n',
    });

    assert.equal(result.record.Description, 'Sapphire current notes');
    assert.equal('Sapphire_Notes_Synced__c' in result.record, false);
});

test('overwrites Description during a hold-sync upsert when the base is blank', async () => {
    const result = await upsertWithExisting({
        Id: 'case-1',
        Status: 'New',
        Description: 'Salesforce edit before a baseline',
        Sapphire_Notes_Synced__c: '\r\n\t',
    });

    assert.equal(result.record.Description, 'Sapphire current notes');
});

test('sets Description for a new Case during a hold-sync upsert', async () => {
    const result = await upsertWithExisting(null);

    assert.equal(result.record.Description, 'Sapphire current notes');
    assert.equal(result.record[CASE_SUBMISSION_ID_FIELD], 'submission-42');
});
