import jsforce = require('jsforce');
import { HoldTicketRecord } from '../transform';
import { formatUtcWatermarkDate, formatWatermarkDate } from '../watermark';

// Update these to match whatever API names you created in Setup.
const CASE_OBJECT = 'Case';
const CASE_EXTERNAL_ID_FIELD = 'Sapphire_Hold_ID__c';
const CASE_RECORD_TYPE_NAME = 'CS Ticket';
const RELEASE_STATUSES = ['Resolved'] as const;

export interface ResolvedCasePendingRelease {
    caseId: string;
    caseNumber: string;
    holdId: string;
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
            `SELECT Id, CaseNumber, ${CASE_EXTERNAL_ID_FIELD}\n` +
            `             FROM ${CASE_OBJECT}\n` +
            `             WHERE Status IN (${statuses})\n` +
            `             AND Hold_Source__c = 'Sapphire'\n` +
            `             AND ${CASE_EXTERNAL_ID_FIELD} != null\n` +
            `             AND Source_Release_Synced__c = false${holdIdFilter}`;

        interface ReleaseCaseRecord {
            Id: string;
            CaseNumber: string;
            Sapphire_Hold_ID__c: string;
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
            .findOne({ [CASE_EXTERNAL_ID_FIELD]: ticket.externalId }, ['Id', 'Status']);

        let status: 'New' | 'Resolved' | undefined;
        if (!existingCase) {
            status = ticket.isResolved ? 'Resolved' : 'New';
        } else if (ticket.isResolved && existingCase.Status !== 'Resolved') {
            status = 'Resolved';
        }

        const caseResult = await this.conn.sobject(CASE_OBJECT).upsert(
            {
                [CASE_EXTERNAL_ID_FIELD]: ticket.externalId,
                Sapphire_Submission_Id__c: ticket.submissionId,
                Sapphire_Hold_Created_Date__c: ticket.createdDate,
                OwnerId: this.defaultOwnerId,
                RecordTypeId: this.caseRecordTypeId,
                ...(status ? { Status: status } : {}),
                AccountId: accountId,
                ContactId: contactId,
                Subject: ticket.holdType,
                Description: ticket.notes,
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
