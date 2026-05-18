// Firebase configuration file - initializes connection to Firestore database and authentication
import { initializeApp, getApps, getApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth } from "firebase/auth";

// Firebase project configuration with API keys and IDs
const firebaseConfig = {
  apiKey: "AIzaSyAfAbFbC8kYWLwGW_fKJkGf2gKGXSGEc10",
  authDomain: "sustain-inventory.firebaseapp.com",
  projectId: "sustain-inventory",
  storageBucket: "sustain-inventory.firebasestorage.app",
  messagingSenderId: "938566401352",
  appId: "1:938566401352:web:6256eb0f2c028d8e3f477d",
  measurementId: "G-LHZ8KX6EBZ"
};

// Guard against duplicate initialization (Turbopack HMR can re-evaluate modules)
const app = getApps().length ? getApp() : initializeApp(firebaseConfig);

// Export Firestore database instance - used for all data reads/writes
export const db = getFirestore(app);

// Export Authentication instance - used for login/logout/session checks
export const auth = getAuth(app);
