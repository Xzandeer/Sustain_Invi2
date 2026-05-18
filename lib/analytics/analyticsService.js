// Analytics service - generates sales and inventory reports for dashboards
import { getFirestore, collection, query, where, getDocs, Timestamp } from 'firebase/firestore';
import { db } from '../firebase';

// 1. Sales Trend - shows daily revenue by category over a date range
export async function getSalesTrend(startDate, endDate) {
  const salesRef = collection(db, 'sales');
  // Step 1: Query sales within date range
  let q = query(
    salesRef,
    where('createdAt', '>=', Timestamp.fromDate(new Date(startDate))),
    where('createdAt', '<=', Timestamp.fromDate(new Date(endDate)))
  );
  const snapshot = await getDocs(q);

  // Step 2: Organize sales by date and category (structure: { date: { category: total } })
  const salesByDateCategory = {};
  const categoriesSet = new Set();
  snapshot.forEach(doc => {
    const data = doc.data();
    const date = data.createdAt.toDate().toISOString().slice(0, 10); // YYYY-MM-DD
    const category = data.category || 'Uncategorized';
    categoriesSet.add(category);
    if (!salesByDateCategory[date]) salesByDateCategory[date] = {};
    if (!salesByDateCategory[date][category]) salesByDateCategory[date][category] = 0;
    salesByDateCategory[date][category] += data.total || 0;
  });

  // Step 3: Format for chart display (array of {date, category1: revenue, category2: revenue})
  const allDates = Object.keys(salesByDateCategory).sort();
  const allCategories = Array.from(categoriesSet).sort();
  const chartData = allDates.map(date => {
    const row = { date };
    allCategories.forEach(cat => {
      row[cat] = salesByDateCategory[date][cat] || 0;
    });
    return row;
  });
  return { data: chartData, categories: allCategories, dates: allDates };
}

// 2. Top-Selling Categories - ranks categories by revenue performance
export async function getTopSellingCategories() {
  const salesRef = collection(db, 'sales');
  const snapshot = await getDocs(salesRef);
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);

  // Step 1: Aggregate sales data by category
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
    // Track today's sales separately
    if (saleDate === todayStr) {
      categoryStats[cat].todaySales += data.total || 0;
    }
  });

  // Step 2: Convert to array and sort by revenue (highest first)
  return Object.entries(categoryStats)
    .map(([category, stats]) => ({ category, ...stats }))
    .sort((a, b) => b.totalRevenue - a.totalRevenue);
}

// 3. Low Performing Categories - sorts categories by revenue (lowest first)
export async function getLowPerformingCategories() {
  const all = await getTopSellingCategories();
  // Reverse sort to put lowest revenue first
  return all.slice().sort((a, b) => a.totalRevenue - b.totalRevenue);
}

// 4. Low Stock Categories - checks current stock against minimum thresholds by category
export async function getLowStockCategories() {
  const inventoryRef = collection(db, 'inventory');
  const snapshot = await getDocs(inventoryRef);

  // Step 1: Sum inventory quantities and minimums by category
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

  // Step 2: Mark categories as low stock if current < minimum threshold
  return Object.entries(categoryStock).map(([category, stats]) => ({
    category,
    ...stats,
    status: stats.totalCurrentStock < stats.threshold ? 'Low' : 'OK',
  }));
}

// 5. Insights Generator - creates summary insights from sales and stock data
export async function generateInsights() {
  // Step 1: Fetch all data in parallel
  const [top, low, stock] = await Promise.all([
    getTopSellingCategories(),
    getLowPerformingCategories(),
    getLowStockCategories(),
  ]);
  const insights = [];

  // Step 2: Generate insights about top sellers
  if (top.length > 0) {
    insights.push(`${top[0].category} category generates the highest revenue.`);
  }

  // Step 3: Alert about low stock categories
  stock.forEach(cat => {
    if (cat.status === 'Low') {
      insights.push(`${cat.category} items are frequently low in stock.`);
    }
  });

  // Step 4: Highlight dominant performers (>20% ahead of #2)
  if (top.length > 1 && top[0].totalRevenue > top[1].totalRevenue * 1.2) {
    insights.push(`${top[0].category} outperforms other categories by a significant margin.`);
  }

  // Step 5: Alert about underperforming categories
  if (low.length > 0) {
    insights.push(`${low[0].category} has the lowest sales revenue.`);
  }
  return insights;
}
