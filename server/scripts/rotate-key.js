/**
 * Key rotation script.
 * Usage: node scripts/rotate-key.js <old_base64_key> <new_base64_key>
 *
 * Decrypts all stored Plaid access tokens with the old key,
 * re-encrypts them with the new key, in a single transaction.
 * The new key should already be set in .env before running this —
 * pass the OLD key as the first argument.
 */

import crypto from 'crypto';
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'networth.db');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function encryptWith(key, plaintext) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { ciphertext, iv, authTag };
}

function decryptWith(key, { ciphertext, iv, authTag }) {
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

const [,, oldKeyB64, newKeyB64] = process.argv;

if (!oldKeyB64 || !newKeyB64) {
  console.error('Usage: node scripts/rotate-key.js <old_base64_key> <new_base64_key>');
  process.exit(1);
}

const oldKey = Buffer.from(oldKeyB64, 'base64');
const newKey = Buffer.from(newKeyB64, 'base64');

if (oldKey.length !== 32 || newKey.length !== 32) {
  console.error('Both keys must decode to exactly 32 bytes');
  process.exit(1);
}

if (!fs.existsSync(DB_PATH)) {
  console.error(`Database not found at ${DB_PATH}`);
  process.exit(1);
}

const db = new Database(DB_PATH);

const items = db.prepare('SELECT id, encrypted_access_token, iv, auth_tag FROM plaid_items').all();

if (items.length === 0) {
  console.log('No Plaid items found — nothing to rotate.');
  process.exit(0);
}

const rotateAll = db.transaction(() => {
  for (const item of items) {
    let plaintext;
    try {
      plaintext = decryptWith(oldKey, {
        ciphertext: item.encrypted_access_token,
        iv: item.iv,
        authTag: item.auth_tag,
      });
    } catch (err) {
      throw new Error(`Failed to decrypt item ${item.id} with old key: ${err.message}`);
    }

    const { ciphertext, iv, authTag } = encryptWith(newKey, plaintext);

    db.prepare(`
      UPDATE plaid_items
      SET encrypted_access_token = ?, iv = ?, auth_tag = ?
      WHERE id = ?
    `).run(ciphertext, iv, authTag, item.id);

    console.log(`[rotate-key] Re-encrypted item ${item.id}`);
  }
});

try {
  rotateAll();
  console.log(`[rotate-key] Successfully rotated ${items.length} item(s). Update ENCRYPTION_KEY in .env to the new key.`);
} catch (err) {
  console.error(`[rotate-key] Rotation failed (transaction rolled back): ${err.message}`);
  process.exit(1);
}
