import { getFirestore, collection, query, where, getDocs, Timestamp } from 'firebase/firestore';
import { db } from '../firebase';

// 1. Sales Trend
export async function getSalesTrend(startDate, endDate) {
  // Accepts optional category argument for filtering
  // Usage: getSalesTrend(startDate, endDate, category)
  // If category is undefined or 'All Categories', return all categories grouped
  // Else, return only the selected category
  const salesRef = collection(db, 'sales');
  let q = query(
    salesRef,
    where('createdAt', '>=', Timestamp.fromDate(new Date(startDate))),
    where('createdAt', '<=', Timestamp.fromDate(new Date(endDate)))
  );
  const snapshot = await getDocs(q);
  // salesByDateCategory: { [date]: { [category]: revenue } }
  const salesByDateCategory = {};
  const categoriesSet = new Set();
  snapshot.forEach(doc => {
    const data = doc.data();
    const date = data.createdAt.toDate().toISOString().slice(0, 10);
    const category = data.category || 'Uncategorized';
    categoriesSet.add(category);
    if (!salesByDateCategory[date]) salesByDateCategory[date] = {};
    if (!salesByDateCategory[date][category]) salesByDateCategory[date][category] = 0;
    salesByDateCategory[date][category] += data.total || 0;
  });
  // Get all dates sorted
  const allDates = Object.keys(salesByDateCategory).sort();
  const allCategories = Array.from(categoriesSet).sort();
  // Format for chart: [{ date, [category1]: revenue, [category2]: revenue, ... }]
  const chartData = allDates.map(date => {
    const row = { date };
    allCategories.forEach(cat => {
      row[cat] = salesByDateCategory[date][cat] || 0;
    });
    return row;
  });
  return { data: chartData, categories: allCategories, dates: allDates };
}

// 2. Top-Selling Categories
export async function getTopSellingCategories() {
  const salesRef = collection(db, 'sales');
  const snapshot = await getDocs(salesRef);
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const categoryStats = {};
  snapshot.forEach(doc => {
    const data = doc.data();
    const cat = data.category || 'Uncategorized';
    if (!categoryStats[cat]) {
      categoryStats[cat] = { totalUnitsSold: 0, totalRevenue: 0, todaySales: 0 };
    }
    categoryStats[cat].totalUnitsSold += data.quantity || 0;
    categoryStats[cat].totalRevenue += data.total || 0;
    const saleDate = data.createdAt.toDate().toISOString().slice(0, 10);
    if (saleDate === todayStr) {
      categoryStats[cat].todaySales += data.total || 0;
    }
  });
  return Object.entries(categoryStats)
    .map(([category, stats]) => ({ category, ...stats }))
    .sort((a, b) => b.totalRevenue - a.totalRevenue);
}

// 3. Low Performing Categories
export async function getLowPerformingCategories() {
  const all = await getTopSellingCategories();
  return all.slice().sort((a, b) => a.totalRevenue - b.totalRevenue);
}

// 4. Low Stock Categories
export async function getLowStockCategories() {
  const inventoryRef = collection(db, 'inventory');
  const snapshot = await getDocs(inventoryRef);
  const categoryStock = {};
  snapshot.forEach(doc => {
    const data = doc.data();
    const cat = data.category || 'Uncategorized';
    if (!categoryStock[cat]) {
      categoryStock[cat] = { totalCurrentStock: 0, threshold: 0 };
    }
    categoryStock[cat].totalCurrentStock += data.quantity || 0;
    categoryStock[cat].threshold += data.minStock || 0;
  });
  return Object.entries(categoryStock).map(([category, stats]) => ({
    category,
    ...stats,
    status: stats.totalCurrentStock < stats.threshold ? 'Low' : 'OK',
  }));
}

// 5. Insights Generator
export async function generateInsights() {
  const [top, low, stock] = await Promise.all([
    getTopSellingCategories(),
    getLowPerformingCategories(),
    getLowStockCategories(),
  ]);
  const insights = [];
  if (top.length > 0) {
    insights.push(`${top[0].category} category generates the highest revenue.`);
  }
  stock.forEach(cat => {
    if (cat.status === 'Low') {
      insights.push(`${cat.category} items are frequently low in stock.`);
    }
  });
  if (top.length > 1 && top[0].totalRevenue > top[1].totalRevenue * 1.2) {
    insights.push(`${top[0].category} outperforms other categories by a significant margin.`);
  }
  if (low.length > 0) {
    insights.push(`${low[0].category} has the lowest sales revenue.`);
  }
  return insights;
}
