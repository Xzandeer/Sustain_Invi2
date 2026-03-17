// seedSales.js

import { initializeApp } from "firebase/app";
import {
  getFirestore,
  collection,
  getDocs,
  addDoc,
  doc,
  updateDoc,
  Timestamp,
} from "firebase/firestore";

// 🔹 CONFIG
const firebaseConfig = {
  apiKey: "AIzaSyAfAbFbC8kYWLwGW_fKJkGf2gKGXSGEc10",
  authDomain: "sustain-inventory.firebaseapp.com",
  projectId: "sustain-inventory",
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// 🔥 RANDOM HELPER
function random(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// 🔥 RANDOM DATE (BER MONTHS LAST YEAR → TODAY)
function getRandomDate() {
  const now = new Date();
  const start = new Date(now.getFullYear() - 1, 8, 1); // Sept last year
  const end = new Date();

  return new Date(start.getTime() + Math.random() * (end.getTime() - start.getTime()));
}

// 🔥 MAIN
async function seedSales() {
  try {
    console.log("🚀 Seeding sales with date range...");

    // 1. Get inventory
    const snapshot = await getDocs(collection(db, "inventory"));
    const inventory = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    }));

    if (inventory.length === 0) {
      console.log("❌ No inventory found!");
      return;
    }

    // 2. Generate 100 sales
    for (let i = 0; i < 100; i++) {
      const numberOfItems = random(1, 4);

      const selectedItems = [];
      let totalAmount = 0;

      for (let j = 0; j < numberOfItems; j++) {
        const item = inventory[random(0, inventory.length - 1)];

        if (!item.stock || item.stock <= 0) continue;

        const quantity = random(1, Math.min(3, item.stock));

        selectedItems.push({
          productId: item.id,
          name: item.name,
          quantity,
          price: item.price,
          categoryId: item.categoryId,
          status: item.status ?? "New",
        });

        totalAmount += item.price * quantity;

        // 🔥 update stock safely
        await updateDoc(doc(db, "inventory", item.id), {
          stock: Math.max(0, item.stock - quantity),
        });

        item.stock -= quantity;
      }

      if (selectedItems.length === 0) continue;

      // 🔥 RANDOM DATE
      const randomDate = getRandomDate();

      await addDoc(collection(db, "sales"), {
        items: selectedItems,
        totalAmount,
        createdAt: Timestamp.fromDate(randomDate),
      });
    }

    console.log("✅ Sales seeded with realistic dates!");
    process.exit();
  } catch (err) {
    console.error("❌ Error:", err);
    process.exit(1);
  }
}

// RUN
seedSales();