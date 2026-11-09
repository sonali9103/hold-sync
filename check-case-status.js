require('dotenv').config();
const { Connection } = require('jsforce');

(async () => {
  const caseNumber = process.argv[2] || '00002162';
  if (!/^[0-9]{1,10}$/.test(caseNumber)) throw new Error('Case number must be digits');

  const conn = new Connection({ loginUrl: process.env.SF_LOGIN_URL });
  await conn.login(process.env.SF_USERNAME, process.env.SF_PASSWORD + process.env.SF_SECURITY_TOKEN);

  const c = await conn.query("SELECT CaseNumber, Status, RecordTypeId, RecordType.Name FROM Case WHERE CaseNumber = '" + caseNumber + "'");
  if (!c.records.length) throw new Error('Case not found');
  const rec = c.records[0];
  console.log('Case', rec.CaseNumber, '| status:', rec.Status, '| record type:', rec.RecordType && rec.RecordType.Name);

  const all = await conn.query('SELECT MasterLabel, IsClosed FROM CaseStatus ORDER BY SortOrder');
  console.log('\nAll Case Status values in the org:');
  all.records.forEach(r => console.log('  ' + r.MasterLabel + (r.IsClosed ? '  (closed)' : '')));

  const rt = rec.RecordTypeId || '012000000000000AAA';
  const pv = await conn.request('/services/data/v' + conn.version + '/ui-api/object-info/Case/picklist-values/' + rt + '/Status');
  console.log('\nValues offered to this user for this record type:');
  pv.values.forEach(v => console.log('  ' + v.label + (v.attributes && v.attributes.closed ? '  (closed)' : '')));
})().catch(e => { console.error('Failed:', e.message); process.exit(1); });
