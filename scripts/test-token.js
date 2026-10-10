const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const crypto = require('node:crypto');

const db = new DatabaseSync(path.join('data', 'ta-bridge.db'));

// Test the exact login flow: verify password, create token
const account = db.prepare('SELECT * FROM System_Accounts WHERE Company_Email = ?').get('biobridge@it.co.zw');

function hashPassword(password) {
  return crypto.createHash('sha256').update(password + '::biobridge-salt').digest('hex');
}

function verifyPassword(password, hash) {
  return hashPassword(password) === hash;
}

console.log('Password check:', verifyPassword('biobridge', account.Password_Hash));

// Create session token (simulate)
function hmacKey() {
  return crypto.createHash('sha256').update(process.env.SESSION_SECRET || 'biobridge-dev-session-secret').digest();
}

const expiresAt = Date.now() + 12 * 60 * 60 * 1000;
const claims = Buffer.from(
  JSON.stringify({
    sub: String(account.Account_ID),
    name: account.First_Name + ' ' + account.Surname,
    email: account.Company_Email,
    level: 'IT Administrator',
    exp: expiresAt,
  }),
  'utf8'
).toString('base64url');
const sig = crypto.createHmac('sha256', hmacKey()).update(claims).digest('base64url');
const token = claims + '.' + sig;
console.log('Token:', token);

// Verify it
const dot = token.lastIndexOf('.');
const claimsPart = token.slice(0, dot);
const sigPart = token.slice(dot + 1);
const expected = crypto.createHmac('sha256', hmacKey()).update(claimsPart).digest('base64url');
console.log('Sig match:', sigPart === expected);

const parsed = JSON.parse(Buffer.from(claimsPart, 'base64url').toString('utf8'));
console.log('Parsed claims:', parsed);