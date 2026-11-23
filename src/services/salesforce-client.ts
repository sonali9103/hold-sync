import jsforce = require('jsforce');
import { HoldTicketRecord } from '../transform';
import { normalizeNotes } from '../notes-decision';
import { formatUtcWatermarkDate, formatWatermarkDate } from '../watermark';

// Update these to match whatever API names you created in Setup.
const CASE_OBJECT = 'Case';
export const CASE_EXTERNAL_ID_FIELD = 'Sapphire_Hold_ID__c';
export const CASE_SUBMISSION_ID_FIELD = 'Sapphire_Submission_ID__c';
const CASE_RECORD_TYPE_NAME = 'CS Ticket';
const RELEASE_STATUSES = ['Resolved'] as const;

export interface ResolvedCasePendingRelease {
    caseId: string;
    caseNumber: string;
    holdId: string;
    resolvedBy: string | null;
}

/** A resolved Copia Case that has not yet been sent back to Copia. */
export interface ResolvedCopiaCasePendingRelease {
    caseId: string;
    caseNumber: string;
    holdId: string;
    resolvedBy: string | null;
}

/** A historical Copia Case that still needs the read-sync marker backfilled. */
export interface ResolvedCopiaCaseMissingReleaseSync {
    caseId: string;
    caseNumber: string;
    resolvedBy: string | null;
}

export interface NotesSyncCase {
    caseId: string;
    caseNumber: string;
    submissionId?: string | null;
    description: string | null;
    base: string | null;
    syncedAt?: string | null;
    status: string | null;
    message?: string | null;
}

export interface NotesSyncCaseUpdate {
    description?: string;
    base?: string;
    status?: string;
    message?: string | null;
    syncedAt?: Date;
}

export function hasNotesSyncCaseUpdate(update: NotesSyncCaseUpdate): boolean {
    return update.description !== undefined ||
        update.base !== undefined ||
        update.status !== undefined ||
        update.message !== undefined ||
        update.syncedAt !== undefined;
}

export const NOTES_SYNC_REQUIRED_FIELDS = [
    'Sapphire_Notes_Synced__c',
    'Notes_Sync_Status__c',
    'Notes_Sync_Message__c',
    'Notes_Synced_At__c',
] as const;

export function findMissingNotesSyncFields(fieldNames: Iterable<string>): string[] {
    const available = new Set(fieldNames);
    return NOTES_SYNC_REQUIRED_FIELDS.filter((field) => !available.has(field));
}

export class SalesforceHoldClient {
    private conn: jsforce.Connection;
    private credentials: {
        username: string;
        password: string;
        securityToken: string;
    };
    private defaultOwnerUsername: string;
    private defaultOwnerId: string | null = null;
    private caseRecordTypeId: string | null = null;

    constructor(config: {
        loginUrl: string;
        username: string;
        password: string;
        securityToken: string;
        defaultOwnerUsername: string; // e.g. your own Username for testing, KA's later
    }) {
        this.conn = new jsforce.Connection({ loginUrl: config.loginUrl });
        this.credentials = config;
        this.defaultOwnerUsername = config.defaultOwnerUsername;
    }

    async login(): Promise<void> {
        await this.conn.login(
            this.credentials.username,
            this.credentials.password + this.credentials.securityToken
        );
        // Resolve the default owner's User Id once per run, not per record.
        const result = await this.conn
            .sobject('User')
            .findOne({ Username: this.defaultOwnerUsername }, ['Id']);
        if (!result) {
            throw new Error(
                `Could not find Salesforce user with username ${this.defaultOwnerUsername}`
            );
        }
        this.defaultOwnerId = result.Id as string;

        // Resolve by the confirmed Case record-type label so this does not
        // depend on the still-unconfirmed DeveloperName/API name.
        const recordType = await this.conn
            .sobject('RecordType')
            .findOne(
                { SobjectType: CASE_OBJECT, Name: CASE_RECORD_TYPE_NAME },
                ['Id']
            );
        if (!recordType) {
            throw new Error(
                `Could not find ${CASE_OBJECT} Record Type named ${CASE_RECORD_TYPE_NAME}`
            );
        }
        this.caseRecordTypeId = recordType.Id as string;
    }

    /**
     * Resolves Account/Contact per the confirmed join strategy:
     * Account.Name = U_DOCTORID (no Oracle join needed, already on the
     * hold row), Contact.SubAccountId__c = SUBMISSION.U_SUBACCOUNTID
     * (one Oracle join, done upstream in oracle-client.ts).
     *
     * Missing matches are logged, not thrown — a hold ticket without a
     * resolved Account/Contact is still useful to CS; a crashed sync
     * run over one bad lookup is not.
     */
    private async resolveLookups(
        doctorId: string | null,
        subAccountId: string | null
    ): Promise<{ accountId: string | null; contactId: string | null }> {
        let accountId: string | null = null;
        let contactId: string | null = null;

        if (doctorId) {
            const account = await this.conn
                .sobject('Account')
                .findOne({ Name: doctorId }, ['Id']);
            if (account) {
                accountId = account.Id as string;
            } else {
                console.warn(`No Account found for doctorId=${doctorId}`);
            }
        }

        if (subAccountId) {
            const contact = await this.conn
                .sobject('Contact')
                .findOne({ SubAccountId__c: subAccountId }, ['Id']);
            if (contact) {
                contactId = contact.Id as string;
            } else {
                console.warn(`No Contact found for subAccountId=${subAccountId}`);
            }
        }

        return { accountId, contactId };
    }

    /** Returns the newest hold creation date already synced to Salesforce. */
    async getLatestSyncedHoldDate(
        source: 'sapphire' | 'copia' = 'sapphire'
    ): Promise<string | null> {
        if (!this.defaultOwnerId || !this.caseRecordTypeId) {
            throw new Error(
                'Not logged in — call login() before getLatestSyncedHoldDate()'
            );
        }

        const result = await this.conn.query<{ maxDate: string | null }>(
            `SELECT MAX(Sapphire_Hold_Created_Date__c) maxDate
             FROM ${CASE_OBJECT}
             WHERE ${source === 'copia'
                ? `${CASE_EXTERNAL_ID_FIELD} LIKE 'COPIA-%'`
                : `${CASE_EXTERNAL_ID_FIELD} != null AND (NOT ${CASE_EXTERNAL_ID_FIELD} LIKE 'COPIA-%')`}`
        );
        const maxDate = result.records[0]?.maxDate;
        if (!maxDate) return null;

        const date = new Date(maxDate);
        return source === 'copia'
            ? formatUtcWatermarkDate(date)
            : formatWatermarkDate(date);
    }

    async getResolvedCasesPendingRelease(
        onlyHoldIds?: string[]
    ): Promise<ResolvedCasePendingRelease[]> {
        if (!this.defaultOwnerId || !this.caseRecordTypeId) {
            throw new Error(
                'Not logged in â€” call login() before getResolvedCasesPendingRelease()'
            );
        }

        if (onlyHoldIds?.length === 0) return [];
        for (const holdId of onlyHoldIds ?? []) {
            if (!/^[0-9]+$/.test(holdId)) {
                throw new Error(`Invalid Sapphire hold ID: ${holdId}`);
            }
        }

        const statuses = RELEASE_STATUSES.map((status) => `'${status}'`).join(', ');
        const holdIdFilter = onlyHoldIds
            ? `\n             AND ${CASE_EXTERNAL_ID_FIELD} IN (${onlyHoldIds
                .map((holdId) => `'${holdId}'`)
                .join(', ')})`
            : '';
        const soql =
            `SELECT Id, CaseNumber, ${CASE_EXTERNAL_ID_FIELD}, Resolved_By__c\n` +
            `             FROM ${CASE_OBJECT}\n` +
            `             WHERE Status IN (${statuses})\n` +
            `             AND Hold_Source__c = 'Sapphire'\n` +
            `             AND ${CASE_EXTERNAL_ID_FIELD} != null\n` +
            `             AND Source_Release_Synced__c = false${holdIdFilter}`;

        interface ReleaseCaseRecord {
            Id: string;
            CaseNumber: string;
            Sapphire_Hold_ID__c: string;
            Resolved_By__c: string | null;
        }

        const records: ReleaseCaseRecord[] = [];
        let page = await this.conn.query<ReleaseCaseRecord>(soql);
        records.push(...page.records);
        while (!page.done) {
            if (!page.nextRecordsUrl) {
                throw new Error('Salesforce release query was incomplete without a next page URL.');
            }
            page = await this.conn.queryMore<ReleaseCaseRecord>(page.nextRecordsUrl);
            records.push(...page.records);
        }

        return records.map((record) => ({
            caseId: record.Id,
            caseNumber: record.CaseNumber,
            holdId: record.Sapphire_Hold_ID__c,
            resolvedBy: record.Resolved_By__c,
        }));
    }

    /**
     * Copia release candidates deliberately query only Resolved Cases.  In particular, a Case
     * moved to Cancelled by the separate Cancelled Letter process is never eligible here.
     */
    async getResolvedCopiaCasesPendingRelease(
        onlyHoldIds?: string[]
    ): Promise<ResolvedCopiaCasePendingRelease[]> {
        if (!this.defaultOwnerId || !this.caseRecordTypeId) {
            throw new Error(
                'Not logged in — call login() before getResolvedCopiaCasesPendingRelease()'
            );
        }

        if (onlyHoldIds?.length === 0) return [];
        for (const holdId of onlyHoldIds ?? []) {
            if (!/^\d{8}$/.test(holdId)) {
                throw new Error(`Invalid Copia hold ID: ${holdId}`);
            }
        }

        const holdIdFilter = onlyHoldIds
            ? `\n             AND ${CASE_EXTERNAL_ID_FIELD} IN (${onlyHoldIds
                .map((holdId) => `'${holdId}'`)
                .join(', ')})`
            : '';
        const soql =
            `SELECT Id, CaseNumber, ${CASE_EXTERNAL_ID_FIELD}, Resolved_By__c\n` +
            `             FROM ${CASE_OBJECT}\n` +
            `             WHERE Status = 'Resolved'\n` +
            `             AND Hold_Source__c = 'Copia'\n` +
            `             AND ${CASE_EXTERNAL_ID_FIELD} != null\n` +
            `             AND Source_Release_Synced__c != true${holdIdFilter}`;

        interface CopiaReleaseCaseRecord {
            Id: string;
            CaseNumber: string;
            Sapphire_Hold_ID__c: string;
            Resolved_By__c: string | null;
        }

        const records: CopiaReleaseCaseRecord[] = [];
        let page = await this.conn.query<CopiaReleaseCaseRecord>(soql);
        records.push(...page.records);
        while (!page.done) {
            if (!page.nextRecordsUrl) {
                throw new Error('Salesforce Copia release query was incomplete without a next page URL.');
            }
            page = await this.conn.queryMore<CopiaReleaseCaseRecord>(page.nextRecordsUrl);
            records.push(...page.records);
        }

        return records.map((record) => ({
            caseId: record.Id,
            caseNumber: record.CaseNumber,
            holdId: record.Sapphire_Hold_ID__c,
            resolvedBy: record.Resolved_By__c,
        }));
    }

    /**
     * Read-only helper for maintaining copia-staff-map.json. Once cancelled Copia Cases have the
     * marker, these are exactly the remaining possible Salesforce-to-Copia release candidates.
     */
    async getResolvedCopiaCaseResolvedByValues(): Promise<Array<string | null>> {
        if (!this.defaultOwnerId || !this.caseRecordTypeId) {
            throw new Error(
                'Not logged in — call login() before getResolvedCopiaCaseResolvedByValues()'
            );
        }

        interface CopiaResolvedByRecord {
            Resolved_By__c: string | null;
        }

        const records: CopiaResolvedByRecord[] = [];
        let page = await this.conn.query<CopiaResolvedByRecord>(
            `SELECT Resolved_By__c\n` +
            `             FROM ${CASE_OBJECT}\n` +
            `             WHERE Status = 'Resolved'\n` +
            `             AND Hold_Source__c = 'Copia'\n` +
            `             AND Source_Release_Synced__c != true`
        );
        records.push(...page.records);
        while (!page.done) {
            if (!page.nextRecordsUrl) {
                throw new Error('Salesforce Copia resolved-by query was incomplete without a next page URL.');
            }
            page = await this.conn.queryMore<CopiaResolvedByRecord>(page.nextRecordsUrl);
            records.push(...page.records);
        }

        return records.map((record) => record.Resolved_By__c);
    }

    /** Read-only source for the bounded historical Copia read-sync marker backfill. */
    async getResolvedCopiaCasesMissingReleaseSync(): Promise<ResolvedCopiaCaseMissingReleaseSync[]> {
        if (!this.defaultOwnerId || !this.caseRecordTypeId) {
            throw new Error(
                'Not logged in — call login() before getResolvedCopiaCasesMissingReleaseSync()'
            );
        }

        interface CopiaBackfillCaseRecord {
            Id: string;
            CaseNumber: string;
            Resolved_By__c: string | null;
        }

        const records: CopiaBackfillCaseRecord[] = [];
        let page = await this.conn.query<CopiaBackfillCaseRecord>(
            `SELECT Id, CaseNumber, Resolved_By__c\n` +
            `             FROM ${CASE_OBJECT}\n` +
            `             WHERE Status = 'Resolved'\n` +
            `             AND Hold_Source__c = 'Copia'\n` +
            `             AND Source_Release_Synced__c != true`
        );
        records.push(...page.records);
        while (!page.done) {
            if (!page.nextRecordsUrl) {
                throw new Error('Salesforce Copia backfill query was incomplete without a next page URL.');
            }
            page = await this.conn.queryMore<CopiaBackfillCaseRecord>(page.nextRecordsUrl);
            records.push(...page.records);
        }

        return records.map((record) => ({
            caseId: record.Id,
            caseNumber: record.CaseNumber,
            resolvedBy: record.Resolved_By__c,
        }));
    }

    async recordReleaseResult(
        caseId: string,
        synced: boolean,
        note: string | null
    ): Promise<void> {
        const result = await this.conn.sobject(CASE_OBJECT).update({
            Id: caseId,
            Source_Release_Synced__c: synced,
            Source_Release_Note__c: note === null ? null : note.slice(0, 255),
        });
        if (!result.success) {
            throw new Error(`Could not record Sapphire release result for Case ${caseId}`);
        }
    }

    /**
     * The comment has a stable machine prefix so a future Salesforce-comment sync can exclude
     * this audit event instead of sending it back to Copia as customer-service commentary.
     */
    async recordCopiaReleaseResult(caseId: string, note: string): Promise<void> {
        const update = await this.conn.sobject(CASE_OBJECT).update({
            Id: caseId,
            Source_Release_Synced__c: true,
        });
        if (!update.success) {
            throw new Error(`Could not mark Copia release synced for Case ${caseId}`);
        }

        const comment = await this.conn.sobject('CaseComment').create({
            ParentId: caseId,
            CommentBody: `[hold-sync sf-to-copia-release] ${note}`,
        });
        if (!comment.success) {
            throw new Error(`Could not add Copia release audit comment for Case ${caseId}`);
        }
    }

    /** Marks a Case which the Copia read sync had already observed as cancelled upstream. */
    async markCopiaReadSyncResolved(caseId: string): Promise<void> {
        const update = await this.conn.sobject(CASE_OBJECT).update({
            Id: caseId,
            Source_Release_Synced__c: true,
        });
        if (!update.success) {
            throw new Error(`Could not mark Copia read-sync Case ${caseId} release synced`);
        }
    }

    private async assertNotesSyncFieldsExist(): Promise<void> {
        const description = await this.conn.sobject(CASE_OBJECT).describe() as unknown as {
            fields?: Array<{ name?: string }>;
        };
        const fieldNames = (description.fields || [])
            .map((field) => field.name)
            .filter((name): name is string => typeof name === 'string');
        const missing = findMissingNotesSyncFields(fieldNames);
        if (missing.length > 0) {
            throw new Error(
                `Notes sync cannot run because these Salesforce Case fields are missing: ${missing.join(', ')}.`
            );
        }
    }

    async getOpenCasesForNotesSync(options: {
        submissionId?: string;
        limit?: number;
    } = {}): Promise<NotesSyncCase[]> {
        await this.assertNotesSyncFieldsExist();

        const submissionFilter = options.submissionId
            ? `\n             AND ${CASE_SUBMISSION_ID_FIELD} = '${options.submissionId.replace(/'/g, "\\'")}'`
            : '';
        const limit = options.limit ? `\n             LIMIT ${options.limit}` : '';
        const soql =
            `SELECT Id, CaseNumber, ${CASE_SUBMISSION_ID_FIELD}, Description, ` +
            `Sapphire_Notes_Synced__c, Notes_Synced_At__c, Notes_Sync_Status__c, ` +
            `Notes_Sync_Message__c\n` +
            `             FROM ${CASE_OBJECT}\n` +
            `             WHERE IsClosed = false\n` +
            `             AND Hold_Source__c = 'Sapphire'\n` +
            `             AND ${CASE_SUBMISSION_ID_FIELD} != null${submissionFilter}${limit}`;

        interface NotesCaseRecord {
            Id: string;
            CaseNumber: string;
            [CASE_SUBMISSION_ID_FIELD]: string | null;
            Description: string | null;
            Sapphire_Notes_Synced__c: string | null;
            Notes_Synced_At__c: string | null;
            Notes_Sync_Status__c: string | null;
            Notes_Sync_Message__c: string | null;
        }

        const records: NotesCaseRecord[] = [];
        let page = await this.conn.query<NotesCaseRecord>(soql);
        records.push(...page.records);
        while (!page.done) {
            if (!page.nextRecordsUrl) {
                throw new Error('Salesforce notes query was incomplete without a next page URL.');
            }
            page = await this.conn.queryMore<NotesCaseRecord>(page.nextRecordsUrl);
            records.push(...page.records);
        }

        return records.map((record) => ({
            caseId: record.Id,
            caseNumber: record.CaseNumber,
            submissionId: record[CASE_SUBMISSION_ID_FIELD],
            description: record.Description,
            base: record.Sapphire_Notes_Synced__c,
            syncedAt: record.Notes_Synced_At__c,
            status: record.Notes_Sync_Status__c,
            message: record.Notes_Sync_Message__c,
        }));
    }

    async updateNotesSyncCase(caseId: string, update: NotesSyncCaseUpdate): Promise<void> {
        if (!hasNotesSyncCaseUpdate(update)) return;

        const result = await this.conn.sobject(CASE_OBJECT).update({
            Id: caseId,
            ...(update.description === undefined ? {} : { Description: update.description }),
            ...(update.base === undefined ? {} : { Sapphire_Notes_Synced__c: update.base }),
            ...(update.status === undefined ? {} : { Notes_Sync_Status__c: update.status }),
            ...(update.message === undefined ? {} : { Notes_Sync_Message__c: update.message }),
            ...(update.syncedAt === undefined
                ? {}
                : { Notes_Synced_At__c: update.syncedAt.toISOString() }),
        });
        if (!result.success) {
            throw new Error(`Could not update notes-sync fields for Case ${caseId}`);
        }
    }

    async addNotesSyncComment(caseId: string, body: string): Promise<void> {
        const result = await this.conn.sobject('CaseComment').create({
            ParentId: caseId,
            CommentBody: body,
        });
        if (!result.success) {
            throw new Error(`Could not add notes-sync comment for Case ${caseId}`);
        }
    }

    /** Upserts one standalone Case for one Sapphire hold. */
    async upsertTicket(ticket: HoldTicketRecord): Promise<void> {
        if (!this.defaultOwnerId || !this.caseRecordTypeId) {
            throw new Error('Not logged in — call login() before upsertTicket()');
        }

        const { accountId, contactId } = await this.resolveLookups(
            ticket.doctorId,
            ticket.subAccountId
        );

        const existingCase = await this.conn
            .sobject(CASE_OBJECT)
            .findOne(
                { [CASE_EXTERNAL_ID_FIELD]: ticket.externalId },
                ['Id', 'Status', 'Description', 'Sapphire_Notes_Synced__c']
            );

        let status: 'New' | 'Resolved' | undefined;
        if (!existingCase) {
            status = ticket.isResolved ? 'Resolved' : 'New';
        } else if (ticket.isResolved && existingCase.Status !== 'Resolved') {
            status = 'Resolved';
        }

        const existingBase = existingCase?.Sapphire_Notes_Synced__c as string | null | undefined;
        const preservePendingDescription = existingCase !== null &&
            normalizeNotes(existingBase) !== '' &&
            normalizeNotes(existingCase.Description as string | null | undefined) !==
                normalizeNotes(existingBase);

        const caseResult = await this.conn.sobject(CASE_OBJECT).upsert(
            {
                [CASE_EXTERNAL_ID_FIELD]: ticket.externalId,
                [CASE_SUBMISSION_ID_FIELD]: ticket.submissionId,
                Sapphire_Hold_Created_Date__c: ticket.createdDate,
                OwnerId: this.defaultOwnerId,
                RecordTypeId: this.caseRecordTypeId,
                ...(status ? { Status: status } : {}),
                // An upstream Copia cancellation must never become a Salesforce-to-Copia release
                // candidate. Deliberately omit false so a prior true marker is never cleared.
                ...(ticket.sourceReleaseSynced ? { Source_Release_Synced__c: true } : {}),
                AccountId: accountId,
                ContactId: contactId,
                Subject: ticket.holdType,
                ...(preservePendingDescription ? {} : { Description: ticket.notes }),
                Department__c: 'Customer Service',
                Hold_Source__c: ticket.holdSource,
                Account_Number__c: ticket.doctorId,
                Created_By__c: ticket.createdBy || null,
                Resolved_By__c: ticket.resolvedBy,
                Source_Tool__c: ticket.sourceTool || null,
                Doctor_Name__c: ticket.doctorName,
                Doctor_Phone__c: ticket.doctorPhone,
                Patient_Name__c: ticket.patientName,
                Patient_Id__c: ticket.patientId,
                Patient_Phone__c: ticket.patientPhone,
            },
            CASE_EXTERNAL_ID_FIELD
        );

        const caseId = 'id' in caseResult ? caseResult.id : undefined;
        if (!caseId) {
            throw new Error(`Case upsert did not return an id for ${ticket.externalId}`);
        }

    }
}
