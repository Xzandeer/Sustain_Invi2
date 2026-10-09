// Shared Firestore connection for the maintenance scripts.
//
// Uses serviceAccountKey.json in the project root if it exists, otherwise the
// FIREBASE_ADMIN_* variables in .env.local - the same credentials the app and
// the seed scripts use. Whichever is found decides which Firebase project the
// script writes to, so every script prints the project ID first.

const { initializeApp, cert, getApps } = require('firebase-admin/app')
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore')
const fs = require('fs')
const path = require('path')

function loadCredentials() {
  const keyPath = path.resolve(__dirname, '../../serviceAccountKey.json')
  if (fs.existsSync(keyPath)) {
    const account = require(keyPath)
    return { credential: cert(account), projectId: account.project_id }
  }

  const envPath = path.resolve(__dirname, '../../.env.local')
  if (!fs.existsSync(envPath)) {
    throw new Error('No serviceAccountKey.json and no .env.local found in the project root.')
  }
  require('dotenv').config({ path: envPath })

  const projectId = process.env.FIREBASE_ADMIN_PROJECT_ID
  const clientEmail = process.env.FIREBASE_ADMIN_CLIENT_EMAIL
  // Stored with escaped newlines so it fits on one line of an env file.
  const privateKey = (process.env.FIREBASE_ADMIN_PRIVATE_KEY || '').replace(/\\n/g, '\n')
  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      'FIREBASE_ADMIN_PROJECT_ID, FIREBASE_ADMIN_CLIENT_EMAIL and ' +
        'FIREBASE_ADMIN_PRIVATE_KEY must all be set in .env.local.'
    )
  }
  return { credential: cert({ projectId, clientEmail, privateKey }), projectId }
}

const { credential, projectId } = loadCredentials()
if (getApps().length === 0) initializeApp({ credential })

module.exports = { db: getFirestore(), projectId, FieldValue, Timestamp }
