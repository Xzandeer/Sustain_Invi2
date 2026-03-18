// seedInventorySmart.js

import { initializeApp } from "firebase/app";
import {
  getFirestore,
  collection,
  addDoc,
  getDocs,
  Timestamp,
} from "firebase/firestore";

// 🔹 CONFIG
const firebaseConfig = {
  apiKey: "YOUR_KEY",
  authDomain: "YOUR_DOMAIN",
  projectId: "sustain-inventory",
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// 🔹 HELPERS
function random(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick(arr) {
  return arr[random(0, arr.length - 1)];
}

// 🔹 CATEGORIES
const categories = [
  "Clothing",
  "Footwear",
  "Accessories",
  "Furniture",
  "Kitchenware",
  "Electronics",
  "Appliances",
  "Toys",
  "Bags",
];

// 🔹 ITEM TYPES
const itemTypes = {
  small: ["Cap", "Bowl", "Toy", "Lunch Box", "Cup"],
  medium: ["T-Shirt", "Hoodie", "Bag", "Shoes"],
  large: ["Chair", "Table", "Cabinet", "Fan", "Microwave"],
};

// 🔹 BRANDS
const brands = [
  "Uniqlo",
  "Muji",
  "Nike",
  "Adidas",
  "Sony",
  "Panasonic",
];

// 🔹 COLORS
const colors = ["Black", "White", "Gray", "Blue", "Brown"];

// 🔹 PRICE GENERATOR
function generatePrice(type, status) {
  let base = 0;

  if (type === "small") base = random(50, 150);
  if (type === "medium") base = random(200, 1000);
  if (type === "large") base = random(1000, 5000);

  // Refurbished cheaper
  if (status === "Refurbished") {
    base *= 0.6;
  }

  return Math.round(base);
}

// 🔥 MAIN FUNCTION
async function seedInventory() {
  console.log("🚀 Seeding smart inventory...");

  const categoryMap = {};

  // 🔥 1. CHECK EXISTING CATEGORIES
  const existing = await getDocs(collection(db, "categories"));

  if (existing.empty) {
    console.log("📂 Creating categories...");

    for (const name of categories) {
      const ref = await addDoc(collection(db, "categories"), {
        name,
        createdAt: Timestamp.now(),
      });

      categoryMap[name] = ref.id;
    }
  } else {
    console.log("📂 Using existing categories...");

    existing.docs.forEach(doc => {
      categoryMap[doc.data().name] = doc.id;
    });
  }

  console.log("✅ Categories ready");

  // 🔥 2. CREATE INVENTORY
  for (let i = 0; i < 120; i++) {
    const category = pick(categories);

    const sizeType = pick(["small", "medium", "large"]);
    const itemName = pick(itemTypes[sizeType]);

    const brand = pick(brands);
    const color = pick(colors);

    const status = Math.random() > 0.5 ? "New" : "Refurbished";

    const price = generatePrice(sizeType, status);

    const stock = random(5, 40);
    const minStock = random(2, 10);

    await addDoc(collection(db, "inventory"), {
      name: `${brand} ${itemName} - ${color}`,
      categoryId: categoryMap[category],
      categoryName: category, // 🔥 FIXED
      price,
      stock,
      minStock,
      status,
      createdAt: Timestamp.now(),
    });
  }

  console.log("🎉 Inventory seeded successfully!");
  process.exit();
}

// RUN
seedInventory();