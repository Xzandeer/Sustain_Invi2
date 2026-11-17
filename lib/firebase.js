// Firebase configuration file - initializes connection to Firestore database and authentication
import { initializeApp, getApps, getApp } from "firebase/app";
import { getFirestore, initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from "firebase/firestore";
import { getAuth, setPersistence, browserSessionPersistence } from "firebase/auth";

// Firebase project configuration, read from environment variables.
//
// These come from .env.local (or the Vercel environment) so the app can be
// pointed at a different Firebase project without touching code. That is what
// makes separate test / demo / production databases possible - each has its own
// quota, and seeding one can never affect another.
//
// NEXT_PUBLIC_ variables are inlined into the browser bundle at build time, so
// changing them requires restarting the dev server, not just a page refresh.
const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

// Fail loudly rather than connecting to nothing. A missing variable otherwise
// surfaces much later as confusing "permission denied" or empty-collection
// errors that look like data problems.
if (!firebaseConfig.projectId) {
  throw new Error(
    "Firebase config missing. Check NEXT_PUBLIC_FIREBASE_* variables in .env.local, then restart the dev server."
  );
}

// Guard against duplicate initialization (Turbopack HMR can re-evaluate modules)
const app = getApps().length ? getApp() : initializeApp(firebaseConfig);

// Export Firestore database instance - used for all data reads/writes.
//
// In the browser it keeps an offline cache in IndexedDB, so documents already
// read are served from the cache (shared by every open tab). This replaces
// enableIndexedDbPersistence(), which Firebase has deprecated and warned about
// on every page. On a hot reload the instance already exists and is reused.
function createDb() {
  if (typeof window === "undefined") return getFirestore(app);
  try {
    return initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
  } catch {
    return getFirestore(app);
  }
}
export const db = createDb();

// Export Authentication instance - used for login/logout/session checks
export const auth = getAuth(app);

// Keep the sign-in for this tab only. The default keeps it on the computer
// until someone signs out, so on a shared shop computer the next person to
// open the site was already signed in as the last one.
// See also components/shared/SessionGuard.tsx (Back button and idle sign-out).
if (typeof window !== "undefined") {
  setPersistence(auth, browserSessionPersistence).catch(() => {});
}

