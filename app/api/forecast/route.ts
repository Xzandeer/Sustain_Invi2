import { NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";

// Retry function to avoid Gemini model overload (503) or quota errors (429)
async function callWithRetry(fn: () => Promise<any>, retries = 3, delay = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      if (err.message.includes("Quota exceeded") || err.message.includes("Too Many Requests")) {
        if (i < retries - 1) {
          console.log(`Quota exceeded. Retrying in ${delay} seconds...`);
          await new Promise((res) => setTimeout(res, delay * 1000));
          delay *= 2; // Exponentially increase the delay for the next retry
        } else {
          throw new Error("API quota exceeded, retries failed.");
        }
      } else {
        throw err; // Rethrow other errors (like 503 service unavailable)
      }
    }
  }
}

// API POST handler
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { sales, categorySales } = body;

    if (!process.env.GEMINI_API_KEY) {
      return NextResponse.json({ error: "Gemini API key missing." }, { status: 500 });
    }

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

    // ✔ Use a STABLE model!
    const model = genAI.getGenerativeModel({
      model: "gemini-3-flash-preview",
    });

    const prompt = `
You are an expert AI specializing in demand forecasting for retail surplus shops.

DATA PROVIDED:
- TOTAL DAILY SALES (chronological): 
${JSON.stringify(sales)}

- CATEGORY SALES DATA (format: { category: [list of daily amounts] }):
${JSON.stringify(categorySales)}

TASKS:
1. Forecast the next 7 days of total sales.
2. Forecast the next 7 days of sales for EACH category.
3. Identify rising, falling, and unstable categories.
4. Provide a 3-5 sentence analysis covering: restocking advice, next week's priority category, and low-demand risk areas.
5. Make it organized and concise.

Return **VALID JSON ONLY** in this exact format:

{
  "overallForecast": [7 numbers],
  "categoryForecast": {
    "CategoryName": [7 numbers]
  },
  "analysis": "string"
    `;

    // GEMINI CALL WITH RETRY
    const result = await callWithRetry(
      () => model.generateContent(prompt),
      3 // Retries, you can adjust this number
    );

    let raw = result.response.text().trim();

    // CLEAN JSON (remove ```json or ``` markers)
    raw = raw.replace(/```json/g, "")
             .replace(/```/g, "")
             .replace(/[\u0000-\u001F]+/g, "") // remove invisible chars
             .trim();

    // Parse JSON SAFELY
    let json;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      console.error("Raw AI output was not valid JSON:", raw);
      throw new Error("Invalid AI JSON output");
    }

    return NextResponse.json(json, { status: 200 });
  } catch (e: any) {
    console.error("Forecast API error:", e);
    return NextResponse.json({ error: "AI Forecasting failed", details: e.message }, { status: 500 });
  }
}
