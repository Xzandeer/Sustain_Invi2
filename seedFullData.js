// seedSalesJanToMarch.js

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

// CONFIG
const firebaseConfig = {
  apiKey: "YOUR_KEY",
  authDomain: "YOUR_DOMAIN",
  projectId: "sustain-inventory",
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// HELPERS
function random(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick(arr) {
  return arr[random(0, arr.length - 1)];
}

// 🔥 WEIGHTED (cheap sells more)
function weightedPick(items) {
  const weighted = [];

  items.forEach(item => {
    let weight = 1;

    if (item.price <= 150) weight = 5;
    else if (item.price <= 1000) weight = 3;
    else weight = 1;

    for (let i = 0; i < weight; i++) {
      weighted.push(item);
    }
  });

  return pick(weighted);
}

// 🔥 MAIN
async function seedSalesJanToMarch() {
  console.log("🚀 Seeding Jan–March sales...");

  // 1. GET INVENTORY
  const snapshot = await getDocs(collection(db, "inventory"));
  const inventory = snapshot.docs.map(doc => ({
    id: doc.id,
    ...doc.data(),
  }));

  if (inventory.length === 0) {
    console.log("❌ No inventory found");
    return;
  }

  const year = new Date().getFullYear();
  const start = new Date(year, 0, 1); // Jan 1
  const end = new Date(year, 2, 18); // March 18

  let current = new Date(start);
  let totalSales = 0;

  // 🔥 WEEKLY LOOP
  while (current <= end) {
    const salesPerWeek = random(4, 8); // NORMAL (lower than BER)

    for (let i = 0; i < salesPerWeek; i++) {
      const itemsCount = random(1, 3);
      const selectedItems = [];
      let totalAmount = 0;

      for (let j = 0; j < itemsCount; j++) {
        const item = weightedPick(inventory);

        if (!item.stock || item.stock <= 0) continue;

        const qty = random(1, Math.min(3, item.stock));

        selectedItems.push({
          productId: item.id,
          name: item.name,
          quantity: qty,
          price: item.price,
          categoryId: item.categoryId,
          categoryName: item.categoryName,
          status: item.status,
        });

        totalAmount += item.price * qty;

        // update stock
        item.stock -= qty;

        await updateDoc(doc(db, "inventory", item.id), {
          stock: Math.max(0, item.stock),
        });
      }

      if (selectedItems.length === 0) continue;

      // random day in week
      const saleDate = new Date(current);
      saleDate.setDate(saleDate.getDate() + random(0, 6));

      await addDoc(collection(db, "sales"), {
        items: selectedItems,
        totalAmount,
        createdAt: Timestamp.fromDate(saleDate),
        customer: "Walk-in Customer",
        status: "Completed",
      });

      totalSales++;
    }

    // next week
    current.setDate(current.getDate() + 7);
  }

  console.log(`🎉 DONE! Created ${totalSales} sales (Jan–March)`);
  process.exit();
}

// RUN
seedSalesJanToMarch();