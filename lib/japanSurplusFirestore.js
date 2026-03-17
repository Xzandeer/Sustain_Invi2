import { initializeApp, getApps, getApp } from "firebase/app";
import {
  collection,
  doc,
  getDocs,
  getFirestore,
  query,
  runTransaction,
  serverTimestamp,
  where,
} from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyAfAbFbC8kYWLwGW_fKJkGf2gKGXSGEc10",
  authDomain: "sustain-inventory.firebaseapp.com",
  projectId: "sustain-inventory",
  storageBucket: "sustain-inventory.firebasestorage.app",
  messagingSenderId: "938566401352",
  appId: "1:938566401352:web:6256eb0f2c028d8e3f477d",
  measurementId: "G-LHZ8KX6EBZ"
};

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
const db = getFirestore(app);

const inventoryDocId = (itemName) =>
  String(itemName)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export const initialInventoryItems = [
  { item_name: "Rice Cooker", category: "Appliance", price: 1200, quantity: 5 },
  { item_name: "Electric Kettle", category: "Appliance", price: 850, quantity: 6 },
  { item_name: "Microwave Oven", category: "Appliance", price: 3500, quantity: 2 },
  { item_name: "Electric Fan", category: "Appliance", price: 950, quantity: 7 },
  { item_name: "Portable Induction Cooker", category: "Appliance", price: 1800, quantity: 3 },
  { item_name: "Wooden Dining Chair", category: "Furniture", price: 950, quantity: 10 },
  { item_name: "Office Chair", category: "Furniture", price: 1800, quantity: 3 },
  { item_name: "Folding Table", category: "Furniture", price: 1500, quantity: 4 },
  { item_name: "Coffee Table", category: "Furniture", price: 1200, quantity: 5 },
  { item_name: "Bookshelf", category: "Furniture", price: 1700, quantity: 2 },
  { item_name: "Wall Clock", category: "Home Decor", price: 300, quantity: 8 },
  { item_name: "Table Lamp", category: "Home Decor", price: 450, quantity: 6 },
  { item_name: "Standing Lamp", category: "Home Decor", price: 850, quantity: 3 },
  { item_name: "Decorative Vase", category: "Home Decor", price: 250, quantity: 10 },
  { item_name: "Ceramic Plate Set", category: "Kitchenware", price: 450, quantity: 6 },
  { item_name: "Glass Cup Set", category: "Kitchenware", price: 350, quantity: 7 },
  { item_name: "Non-stick Frying Pan", category: "Kitchenware", price: 650, quantity: 5 },
  { item_name: "Cooking Pot", category: "Kitchenware", price: 900, quantity: 4 },
  { item_name: "Knife Set", category: "Kitchenware", price: 700, quantity: 3 },
  { item_name: "Japanese Bento Box", category: "Kitchenware", price: 300, quantity: 12 },
  { item_name: "Tea Cup Set", category: "Kitchenware", price: 350, quantity: 8 },
  { item_name: "Small Refrigerator", category: "Appliance", price: 6000, quantity: 1 },
  { item_name: "Washing Machine", category: "Appliance", price: 7500, quantity: 1 },
  { item_name: "Vacuum Cleaner", category: "Appliance", price: 2500, quantity: 2 },
];

const validateNumber = (value, fieldName) => {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative number.`);
  }
};

export const addInventoryItem = async (item_name, category, price, quantity) => {
  try {
    if (!item_name || !category) {
      throw new Error("item_name and category are required.");
    }
    validateNumber(price, "price");
    validateNumber(quantity, "quantity");

    const ref = doc(db, "inventory", inventoryDocId(item_name));
    await runTransaction(db, async (transaction) => {
      const snap = await transaction.get(ref);

      if (snap.exists()) {
        const currentQuantity = Number(snap.data().quantity ?? 0);
        transaction.update(ref, {
          quantity: currentQuantity + quantity,
        });
        return;
      }

      transaction.set(ref, {
        item_name,
        category,
        price,
        quantity,
        date_added: serverTimestamp(),
      });
    });

    return { success: true, item_name };
  } catch (error) {
    console.error("addInventoryItem error:", error);
    throw error;
  }
};

export const addOrUpdateInventoryItem = addInventoryItem;

export const insertInitialInventoryItems = async () => {
  try {
    for (const item of initialInventoryItems) {
      await addInventoryItem(item.item_name, item.category, item.price, item.quantity);
    }
    return { success: true, count: initialInventoryItems.length };
  } catch (error) {
    console.error("insertInitialInventoryItems error:", error);
    throw error;
  }
};

export const recordSale = async (item_name, quantity_sold, price) => {
  try {
    if (!item_name) {
      throw new Error("item_name is required.");
    }
    validateNumber(quantity_sold, "quantity_sold");
    validateNumber(price, "price");
    if (quantity_sold === 0) {
      throw new Error("quantity_sold must be greater than 0.");
    }

    const total_price = quantity_sold * price;
    const inventoryRef = doc(db, "inventory", inventoryDocId(item_name));
    const salesRef = doc(collection(db, "sales"));

    await runTransaction(db, async (transaction) => {
      const inventorySnap = await transaction.get(inventoryRef);

      if (!inventorySnap.exists()) {
        throw new Error(`Inventory item "${item_name}" does not exist.`);
      }

      const currentQuantity = Number(inventorySnap.data().quantity ?? 0);
      if (currentQuantity < quantity_sold) {
        throw new Error(`Insufficient stock for "${item_name}". Current stock: ${currentQuantity}.`);
      }

      transaction.update(inventoryRef, {
        quantity: currentQuantity - quantity_sold,
      });

      transaction.set(salesRef, {
        item_name,
        quantity_sold,
        price,
        total_price,
        sale_date: serverTimestamp(),
      });
    });

    return { success: true, item_name, quantity_sold, total_price };
  } catch (error) {
    console.error("recordSale error:", error);
    throw error;
  }
};

export const createReservation = async (item_name, customer_name, quantity_reserved) => {
  try {
    if (!item_name || !customer_name) {
      throw new Error("item_name and customer_name are required.");
    }
    validateNumber(quantity_reserved, "quantity_reserved");
    if (quantity_reserved === 0) {
      throw new Error("quantity_reserved must be greater than 0.");
    }

    const inventoryRef = doc(db, "inventory", inventoryDocId(item_name));
    const reservationRef = doc(collection(db, "reservations"));

    await runTransaction(db, async (transaction) => {
      const inventorySnap = await transaction.get(inventoryRef);
      if (!inventorySnap.exists()) {
        throw new Error(`Inventory item "${item_name}" does not exist.`);
      }

      const currentQuantity = Number(inventorySnap.data().quantity ?? 0);
      if (currentQuantity < quantity_reserved) {
        throw new Error(`Insufficient stock for "${item_name}". Current stock: ${currentQuantity}.`);
      }

      transaction.update(inventoryRef, {
        quantity: currentQuantity - quantity_reserved,
      });

      transaction.set(reservationRef, {
        item_name,
        customer_name,
        quantity_reserved,
        reservation_date: serverTimestamp(),
        status: "Reserved",
      });
    });

    return { success: true, reservation_id: reservationRef.id };
  } catch (error) {
    console.error("createReservation error:", error);
    throw error;
  }
};

export const completeReservation = async (reservation_id) => {
  try {
    if (!reservation_id) {
      throw new Error("reservation_id is required.");
    }

    const reservationRef = doc(db, "reservations", reservation_id);
    const salesRef = doc(collection(db, "sales"));

    await runTransaction(db, async (transaction) => {
      const reservationSnap = await transaction.get(reservationRef);
      if (!reservationSnap.exists()) {
        throw new Error(`Reservation "${reservation_id}" does not exist.`);
      }

      const reservationData = reservationSnap.data();
      const status = String(reservationData.status ?? "");
      if (status !== "Reserved") {
        throw new Error(`Reservation "${reservation_id}" is not active.`);
      }

      const item_name = String(reservationData.item_name ?? "").trim();
      const quantity_sold = Number(reservationData.quantity_reserved ?? 0);
      if (!item_name || quantity_sold <= 0) {
        throw new Error("Invalid reservation data.");
      }

      const inventoryRef = doc(db, "inventory", inventoryDocId(item_name));
      const inventorySnap = await transaction.get(inventoryRef);
      if (!inventorySnap.exists()) {
        throw new Error(`Inventory item "${item_name}" does not exist.`);
      }

      const price = Number(inventorySnap.data().price ?? 0);
      validateNumber(price, "price");
      const total_price = price * quantity_sold;

      transaction.set(salesRef, {
        item_name,
        quantity_sold,
        price,
        total_price,
        sale_date: serverTimestamp(),
      });

      transaction.update(reservationRef, {
        status: "Completed",
      });
    });

    return { success: true, reservation_id };
  } catch (error) {
    console.error("completeReservation error:", error);
    throw error;
  }
};

export const cancelReservation = async (reservation_id) => {
  try {
    if (!reservation_id) {
      throw new Error("reservation_id is required.");
    }

    const reservationRef = doc(db, "reservations", reservation_id);

    await runTransaction(db, async (transaction) => {
      const reservationSnap = await transaction.get(reservationRef);
      if (!reservationSnap.exists()) {
        throw new Error(`Reservation "${reservation_id}" does not exist.`);
      }

      const reservationData = reservationSnap.data();
      const status = String(reservationData.status ?? "");
      if (status !== "Reserved") {
        throw new Error(`Reservation "${reservation_id}" is not active.`);
      }

      const item_name = String(reservationData.item_name ?? "").trim();
      const quantity_reserved = Number(reservationData.quantity_reserved ?? 0);
      if (!item_name || quantity_reserved <= 0) {
        throw new Error("Invalid reservation data.");
      }

      const inventoryRef = doc(db, "inventory", inventoryDocId(item_name));
      const inventorySnap = await transaction.get(inventoryRef);
      if (!inventorySnap.exists()) {
        throw new Error(`Inventory item "${item_name}" does not exist.`);
      }

      const currentQuantity = Number(inventorySnap.data().quantity ?? 0);
      transaction.update(inventoryRef, {
        quantity: currentQuantity + quantity_reserved,
      });

      transaction.update(reservationRef, {
        status: "Cancelled",
      });
    });

    return { success: true, reservation_id };
  } catch (error) {
    console.error("cancelReservation error:", error);
    throw error;
  }
};

export const getActiveReservations = async () => {
  try {
    const reservationsQuery = query(
      collection(db, "reservations"),
      where("status", "==", "Reserved")
    );
    const snapshot = await getDocs(reservationsQuery);

    return snapshot.docs.map((reservationDoc) => ({
      id: reservationDoc.id,
      ...reservationDoc.data(),
    }));
  } catch (error) {
    console.error("getActiveReservations error:", error);
    throw error;
  }
};

export { app, db };
