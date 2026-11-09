require('dotenv').config();
const { Connection } = require('jsforce');

const [mode, holdId] = process.argv.slice(2);
if (!['create', 'show'].includes(mode) || !/^[0-9]{1,12}$/.test(holdId || '')) {
  console.error('Usage: node sf-test-case.js <create|show> <numeric hold id>');
  process.exit(1);
}

(async () => {
  const conn = new Connection({ loginUrl: process.env.SF_LOGIN_URL });
  await conn.login(process.env.SF_USERNAME, process.env.SF_PASSWORD + process.env.SF_SECURITY_TOKEN);

  const found = await conn.query("SELECT Id, CaseNumber, Status, Source_Release_Synced__c, Source_Release_Note__c FROM Case WHERE Sapphire_Hold_Id__c = '" + holdId + "'");
  const existing = found.records[0];

  if (mode === 'show') {
    if (!existing) { console.log('No Case has hold id ' + holdId); return; }
    console.log('Case', existing.CaseNumber, '| status:', existing.Status,
      '| synced:', existing.Source_Release_Synced__c, '| note:', existing.Source_Release_Note__c);
    return;
  }

  if (existing) { console.log('Case ' + existing.CaseNumber + ' already has hold id ' + holdId + '. Use a different hold.'); return; }

  const rt = await conn.query("SELECT Id FROM RecordType WHERE SobjectType = 'Case' AND (DeveloperName = 'CS_Ticket' OR Name = 'CS Ticket')");
  if (!rt.records.length) throw new Error('CS Ticket record type not found');

  const made = await conn.sobject('Case').create({
    Subject: 'TEST release-sync ' + holdId,
    Status: 'New',
    RecordTypeId: rt.records[0].Id,
    Sapphire_Hold_Id__c: holdId,
    Hold_Source__c: 'Sapphire'
  });
  console.log('Created Case', made.id, 'as New');

  await conn.sobject('Case').update({ Id: made.id, Status: 'Resolved' });
  console.log('Set to Resolved. Run: node check-case... or  node sf-test-case.js show ' + holdId);
})().catch(e => { console.error('Failed:', e.message); process.exit(1); });
