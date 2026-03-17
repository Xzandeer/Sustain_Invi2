// seedInventory.js

import { initializeApp } from "firebase/app";
import {
  getFirestore,
  collection,
  addDoc,
  Timestamp,
} from "firebase/firestore";

// 🔹 FIREBASE CONFIG
const firebaseConfig = {
  apiKey: "AIzaSyAfAbFbC8kYWLwGW_fKJkGf2gKGXSGEc10",
  authDomain: "sustain-inventory.firebaseapp.com",
  projectId: "sustain-inventory",
};

// 🔹 INIT FIREBASE
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// 🔹 CATEGORIES
const categories = [
  { name: "Clothing" },
  { name: "Footwear" },
  { name: "Bags" },
  { name: "Accessories" },
  { name: "Furniture" },
  { name: "Kitchenware" },
  { name: "Home Decor" },
  { name: "Appliances" },
  { name: "Electronics" },
  { name: "Toys" },
  { name: "Miscellaneous" },
];

// 🔹 INVENTORY WITH CONDITION
const inventory = [
  // Clothing
  { name: "Uniqlo Oversized T-Shirt - White", category: "Clothing", price: 250, stock: 30, minStock: 10, status: "New" },
  { name: "Nike Windbreaker Jacket - Black/Red", category: "Clothing", price: 450, stock: 15, minStock: 5, status: "Refurbished" },
  { name: "Adidas Hoodie - Gray", category: "Clothing", price: 400, stock: 20, minStock: 8, status: "New" },

  // Footwear
  { name: "Nike Air Force 1 - White", category: "Footwear", price: 1200, stock: 10, minStock: 3, status: "Refurbished" },
  { name: "Converse Chuck Taylor - Black", category: "Footwear", price: 900, stock: 12, minStock: 4, status: "New" },
  { name: "Asics Running Shoes - Blue", category: "Footwear", price: 1100, stock: 8, minStock: 3, status: "Refurbished" },

  // Bags
  { name: "Herschel Backpack - Navy Blue", category: "Bags", price: 700, stock: 10, minStock: 4, status: "New" },
  { name: "Nike Sling Bag - Black", category: "Bags", price: 500, stock: 15, minStock: 5, status: "Refurbished" },

  // Accessories
  { name: "New Era Cap - Red", category: "Accessories", price: 350, stock: 25, minStock: 10, status: "New" },
  { name: "Casio Vintage Watch - Silver", category: "Accessories", price: 600, stock: 10, minStock: 3, status: "Refurbished" },

  // Furniture
  { name: "Wooden Dining Chair - Brown", category: "Furniture", price: 800, stock: 5, minStock: 2, status: "Refurbished" },
  { name: "Foldable Table - White", category: "Furniture", price: 1200, stock: 3, minStock: 1, status: "New" },
  { name: "Mini Cabinet Drawer - Oak", category: "Furniture", price: 1500, stock: 2, minStock: 1, status: "Refurbished" },
  { name: "Single Sofa Chair - Gray", category: "Furniture", price: 2500, stock: 2, minStock: 1, status: "Refurbished" },

  // Kitchenware
  { name: "Ceramic Bowl Set - White", category: "Kitchenware", price: 300, stock: 15, minStock: 5, status: "New" },
  { name: "Non-stick Frying Pan - Black", category: "Kitchenware", price: 500, stock: 10, minStock: 3, status: "Refurbished" },

  // Appliances
  { name: "Microwave Oven - Black", category: "Appliances", price: 2500, stock: 2, minStock: 1, status: "Refurbished" },
  { name: "Electric Fan - Gray", category: "Appliances", price: 1200, stock: 5, minStock: 2, status: "New" },

  // Electronics
  { name: "Sony Headphones - Black", category: "Electronics", price: 1200, stock: 6, minStock: 2, status: "Refurbished" },

  // Toys
  { name: "Plush Toy Bear - Brown", category: "Toys", price: 300, stock: 10, minStock: 4, status: "New" },
];

// 🔥 SEED FUNCTION
async function seed() {
  try {
    console.log("🚀 Seeding started...");

    const categoryMap = {};

    // 1. Categories
    for (const cat of categories) {
      const docRef = await addDoc(collection(db, "categories"), {
        name: cat.name,
        createdAt: Timestamp.now(),
      });
      categoryMap[cat.name] = docRef.id;
    }

    console.log("✅ Categories added");

    // 2. Inventory
    for (const item of inventory) {
      await addDoc(collection(db, "inventory"), {
        name: item.name,
        price: item.price,
        stock: item.stock,
        minStock: item.minStock,
        status: item.status, // 🔥 NEW FIELD
        categoryId: categoryMap[item.category],
        createdAt: Timestamp.now(),
      });
    }

    console.log("✅ Inventory added");
    console.log("🎉 DONE!");
    process.exit();
  } catch (err) {
    console.error("❌ Error:", err);
    process.exit(1);
  }
}

// RUN
seed();