// One-off script to add IT admin account
// Run with: node --experimental-sqlite scripts/add-it-admin.js

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');

// Copy of hashPassword from db.ts
function hashPassword(password) {
  return crypto.createHash('sha256').update(`${password}::biobridge-salt`).digest('hex');
}

// Open the DB
const dbPath = path.join(__dirname, '..', 'data', 'ta-bridge.db');
const db = new DatabaseSync(dbPath);

// Find the IT Administrator level
const level = db.prepare('SELECT Access_Level_ID FROM Access_Levels WHERE Level_Name = ?').get('IT Administrator');
if (!level) {
  console.error('IT Administrator level not found!');
  process.exit(1);
}
const accessLevelId = level.Access_Level_ID;

// Find Branch 1 (or any branch)
const branch = db.prepare('SELECT Branch_ID FROM Branches WHERE Branch_Name = ?').get('Branch 1');
const branchId = branch?.Branch_ID ?? null;

// Check if account already exists
const existing = db.prepare('SELECT Account_ID FROM System_Accounts WHERE Company_Email = ?').get('biobridge@it.co.zw');
if (existing) {
  console.log('Account already exists with ID:', existing.Account_ID);
  process.exit(0);
}

// Insert the account
const stmt = db.prepare(`
  INSERT INTO System_Accounts 
  (First_Name, Surname, Company_Email, Password_Hash, Access_Level_ID, Branch_ID, Employee_ID, Created_At)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const result = stmt.run(
  'Biobridge',
  'IT Admin',
  'biobridge@it.co.zw',
  hashPassword('biobridge'),
  accessLevelId,
  branchId,
  null, // Employee_ID - no linked employee
  Date.now()
);

console.log('Created IT admin account with ID:', result.lastInsertRowid);
console.log('Email: biobridge@it.co.zw');
console.log('Password: biobridge');
console.log('Access Level: IT Administrator (all 25 capabilities)');