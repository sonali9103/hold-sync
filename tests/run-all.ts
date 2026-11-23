// Load every node:test module in one process.  This keeps the tests compatible with IIS/Windows
// development environments that disallow the child-process isolation used by `node --test`.
import './notes-decision.test';
import './notes-sync.test';
import './oracle-client.test';
import './sapphire-notes-client.test';
import './salesforce-client.test';
import './release-sync.test';
import './sf-to-sapphire.test';
import './sf-to-copia.test';
import './copia-unmapped-staff.test';
import './copia-read-sync-backfill.test';
import './transform.test';
