const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const crypto = require('node:crypto');

const db = new DatabaseSync(path.join('data', 'ta-bridge.db'));

// Simulate the full accountByToken flow
const token = 'eyJzdWIiOiI1IiwibmFtZSI6IkJpb2JyaWRnZSBJVCBBZG1pbiIsImVtYWlsIjoiYmlvYnJpZGdlQGl0LmNvLnp3IiwibGV2ZWwiOiJJVCBBZG1pbmlzdHJhdG9yIiwiZXhwIjoxNzkxNjgwMTM5OTY0fQ.IGricv-sv2-5fYKm-ZmGbR5A2qDdXfrQJaoJu3oLZ-o';

// verifySessionToken
function hmacKey() {
  return crypto.createHash('sha256').update(process.env.SESSION_SECRET || 'biobridge-dev-session-secret').digest();
}

function verifySessionToken(token) {
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const claims = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', hmacKey()).update(claims).digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(sig, 'utf8'), Buffer.from(expected, 'utf8'))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(claims, 'base64url').toString('utf8'));
    if (typeof parsed.exp !== 'number' || parsed.exp <= Date.now()) return null;
    if (typeof parsed.sub !== 'string' || parsed.sub === '') return null;
    return parsed;
  } catch {
    return null;
  }
}

const claims = verifySessionToken(token);
console.log('Claims:', claims);

if (claims) {
  const id = Number(claims.sub);
  console.log('Account ID:', id);
  
  // systemAccountById
  const account = db.prepare('SELECT * FROM System_Accounts WHERE Account_ID = ?').get(id);
  console.log('Account:', account);
  
  if (account) {
    // resolveAccount
    const level = account.Access_Level_ID != null
      ? db.prepare('SELECT * FROM Access_Levels WHERE Access_Level_ID = ?').get(account.Access_Level_ID)
      : undefined;
    console.log('Level:', level);
    
    const permissions = JSON.parse(level?.Permissions_JSON || '{}');
    console.log('Permissions:', permissions);
    console.log('can_view_dashboard:', permissions.can_view_dashboard);
    console.log('can_view_my_portal:', permissions.can_view_my_portal);
    
    const home = permissions.can_view_dashboard ? '/' : '/my-portal';
    console.log('Home:', home);
  }
}