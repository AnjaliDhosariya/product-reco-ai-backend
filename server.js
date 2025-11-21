// backend/server.js
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const Groq = require("groq-sdk");
const fetch = require("node-fetch");

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());

const client = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

/* ---------------------------
   Category + Brand mapping
   --------------------------- */
const categoryMap = {
  phone: "smartphones",
  phones: "smartphones",
  smartphone: "smartphones",
  smartphones: "smartphones",
  mobile: "smartphones",
  mobiles: "smartphones",

  laptop: "laptops",
  laptops: "laptops",

  perfume: "fragrances",
  perfumes: "fragrances",
  fragrance: "fragrances"
};

// Known brands (expand as needed)
const KNOWN_BRANDS = [
  "apple", "samsung", "realme", "oppo", "vivo", "xiaomi", "oneplus",
  "honor", "motorola", "nokia", "sony", "google", "lg", "htc"
];

/* ---------------------------
   Helpers
   --------------------------- */
async function fetchProducts() {
  const res = await fetch("https://dummyjson.com/products?limit=200&skip=0");
  const data = await res.json();
  return data.products || [];
}

// try to extract the first {...} object from text
function extractJSON(text) {
  if (!text || typeof text !== "string") return null;
  const m = text.match(/\{[\s\S]*\}/);
  return m ? m[0] : null;
}

// normalize numeric (strip commas, currency symbols)
function asNumber(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === "number") return Number(val);
  const s = String(val).replace(/[,₹$€£]/g, "").trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/* ---------------------------
   Local price extraction (robust)
   --------------------------- */
function extractPriceRangeLocal(text) {
  if (!text || typeof text !== "string") return { price_min: null, price_max: null };
  let t = text.toLowerCase();
  t = t.replace(/(\d),(\d)/g, "$1$2"); // remove stray comma thousands

  // between x and y or x to y
  let m = t.match(/(?:between|from)\s+(\d{1,6})\s+(?:and|to|-)\s+(\d{1,6})/);
  if (m) return { price_min: Number(m[1]), price_max: Number(m[2]) };

  m = t.match(/(\d{1,6})\s*(?:to|-)\s*(\d{1,6})/);
  if (m) return { price_min: Number(m[1]), price_max: Number(m[2]) };

  // above / over / greater than / more than
  m = t.match(/(?:above|over|greater than|more than|>)(?:\s*)(\d{1,6})/);
  if (m) return { price_min: Number(m[1]), price_max: null };

  // below / under / less than / up to
  m = t.match(/(?:below|under|less than|up to|upto|<)(?:\s*)(\d{1,6})/);
  if (m) return { price_min: null, price_max: Number(m[1]) };

  return { price_min: null, price_max: null };
}

/* ---------------------------
   Local brand detection (fallback)
   --------------------------- */
function detectBrandLocal(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  for (const b of KNOWN_BRANDS) {
    if (t.includes(b.toLowerCase())) return b;
  }
  return null;
}

/* ---------------------------
   Local category detect fallback
   --------------------------- */
function detectCategoryLocal(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  if (/(phone|mobile|smartphone|handset|cell)/.test(t)) return "smartphones";
  if (/(laptop|notebook)/.test(t)) return "laptops";
  if (/(perfume|fragrance)/.test(t)) return "fragrances";
  return null;
}

/* ---------------------------
   Score products by keywords + rating
   --------------------------- */
function scoreProduct(product, keywords = [], features = []) {
  let score = 0;
  const hay = `${product.title || ""} ${product.description || ""} ${product.brand || ""}`.toLowerCase();

  for (const kw of keywords) {
    const k = String(kw || "").toLowerCase().trim();
    if (!k) continue;
    const exact = new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (exact.test(hay)) score += 6; // exact phrase match is valuable
    else if (hay.includes(k)) score += 2;
  }

  for (const f of features) {
    const k = String(f || "").toLowerCase().trim();
    if (!k) continue;
    if (hay.includes(k)) score += 4;
  }

  if (product.rating) score += Math.min(5, product.rating) * 0.5;
  // prefer in-stock (if product.stock exists)
  if (product.stock && product.stock > 0) score += 0.5;

  return score;
}

/* ---------------------------
   MAIN /recommend endpoint
   --------------------------- */
app.post("/recommend", async (req, res) => {
  console.log("🔥 /recommend HIT");
  const userTextRaw = (req.body.prompt || "").toString().trim();
  console.log("📩 User Prompt:", userTextRaw);

  try {
    console.log("📡 Fetching products...");
    const products = await fetchProducts();
    console.log("📦 Fetched Products:", products.length);

    // categories present for debugging
    console.log("📚 Categories Available:", [...new Set(products.map(p => p.category))]);

    // First: local price extraction always (reliable)
    const localPrice = extractPriceRangeLocal(userTextRaw);
    console.log("💰 Local price parse:", localPrice);

    // second: try AI to extract structured intent: category, brand, price_min, price_max, features
    let parsed = {
      category: null,
      brand: null,
      price_min: null,
      price_max: null,
      features: []
    };

    try {
      console.log("🤖 Asking Groq for structured intent (category, brand, price_min, price_max, features)...");

      const promptSystem = `
You are an assistant that extracts structured product intent from a user's short request.
Return ONLY JSON in this exact format (no explanation, no other text):

{
  "category": string or null,
  "brand": string or null,
  "price_min": number or null,
  "price_max": number or null,
  "features": []
}

Rules/Examples:
- If the user mentions phone/mobile/smartphone, category -> "smartphones".
- Brands: Apple, Samsung, Realme, Oppo, Vivo, Xiaomi, OnePlus, Google, Motorola, Nokia, Sony.
- Price examples:
  - "below 500" or "under 500" => price_max = 500
  - "above 500" or "over 500" => price_min = 500
  - "between 200 and 500" => both numbers
  - Use numbers only, no currency symbols.
- Features: array of short strings like "good camera", "long battery", "gaming", "4G", "5G".
- If something is not mentioned, return null or empty array.
- OUTPUT STRICT JSON ONLY.
`;

      const groqResponse = await client.chat.completions.create({
        model: "llama-3.1-8b-instant", // free-tier-appropriate
        messages: [
          { role: "system", content: promptSystem },
          { role: "user", content: userTextRaw }
        ]
      });

      const raw = groqResponse.choices[0].message.content;
      console.log("📝 Raw AI Output:", raw);

      const js = extractJSON(raw);
      if (js) {
        try {
          const p = JSON.parse(js);
          parsed.category = p.category || null;
          parsed.brand = p.brand || null;
          parsed.price_min = asNumber(p.price_min);
          parsed.price_max = asNumber(p.price_max);
          parsed.features = Array.isArray(p.features) ? p.features.filter(Boolean) : [];
          console.log("✅ Parsed AI JSON:", parsed);
        } catch (e) {
          console.warn("⚠️ Failed to JSON.parse AI output, ignoring AI parse:", e.message);
        }
      } else {
        console.warn("⚠️ AI returned no JSON object (falling back).");
      }
    } catch (aiErr) {
      console.warn("⚠️ Groq call failed (will fallback to local):", aiErr?.message || aiErr);
    }

    // If AI provided nothing for price, use local extraction
    if (parsed.price_min === null && parsed.price_max === null) {
      parsed.price_min = asNumber(localPrice.price_min);
      parsed.price_max = asNumber(localPrice.price_max);
    } else {
      // If AI gave one and local gave another, prefer AI but fill missing with local
      if (parsed.price_min === null && localPrice.price_min) parsed.price_min = asNumber(localPrice.price_min);
      if (parsed.price_max === null && localPrice.price_max) parsed.price_max = asNumber(localPrice.price_max);
    }

    // If AI didn't provide category, fallback local detection
    if (!parsed.category) {
      const catLocal = detectCategoryLocal(userTextRaw);
      parsed.category = catLocal;
    }

    // If AI didn't provide brand, fallback local brand detection
    if (!parsed.brand) {
      const brandLocal = detectBrandLocal(userTextRaw);
      parsed.brand = brandLocal;
    }

    // Normalize category -> dummyjson categories
    let mappedCategory = null;
    if (parsed.category) {
      mappedCategory = categoryMap[parsed.category.toLowerCase()] || null;
    }
    console.log("🏷️ Mapped Category:", mappedCategory);

    // Sanitize price min/max (swap if min > max)
    if (parsed.price_min !== null && parsed.price_max !== null && parsed.price_min > parsed.price_max) {
      const t = parsed.price_min;
      parsed.price_min = parsed.price_max;
      parsed.price_max = t;
      console.log("🔁 Swapped price_min/price_max because min > max");
    }

    console.log("🔍 Final parsed intent:", parsed);

    // -------------------------
    // Filtering
    // -------------------------
    let candidates = products.slice();

    if (mappedCategory) {
      candidates = candidates.filter(p => p.category === mappedCategory);
    }

    if (parsed.brand) {
      const br = parsed.brand.toLowerCase();
      candidates = candidates.filter(p => (p.brand || "").toLowerCase().includes(br));
    }

    if (parsed.price_min !== null) {
      candidates = candidates.filter(p => p.price >= parsed.price_min);
    }
    if (parsed.price_max !== null) {
      candidates = candidates.filter(p => p.price <= parsed.price_max);
    }

    console.log("📊 Candidates after category/brand/price filter:", candidates.length);

    // If no features identified by AI, attempt lightweight local feature extraction from user text
    let features = Array.isArray(parsed.features) ? parsed.features : [];
    if (!features.length) {
      const ft = [];
      const t = userTextRaw.toLowerCase();
      if (t.includes("camera") || t.includes("photo") || t.includes("photography")) ft.push("camera");
      if (t.includes("battery") || t.includes("long battery")) ft.push("battery");
      if (t.includes("gaming") || t.includes("game")) ft.push("gaming");
      if (t.includes("5g")) ft.push("5g");
      if (t.includes("4g")) ft.push("4g");
      if (t.includes("ram")) ft.push("ram");
      if (t.includes("screen") || t.includes("display")) ft.push("display");
      features = ft;
    }

    // Score & sort
    const keywords = [] // combine intent words and features lightly
      .concat((parsed.intent ? [parsed.intent] : []))
      .concat(features || [])
      .concat(parsed.brand ? [parsed.brand] : []);

    // If no keywords, derive from words user typed (short tokens)
    let derived = [];
    if (!keywords.length) {
      derived = userTextRaw
        .toLowerCase()
        .split(/[\s,]+/)
        .filter(w => w.length > 2)
        .slice(0, 5);
    }

    const effectiveKeywords = keywords.length ? keywords : derived;

    const scored = candidates.map(p => ({ p, score: scoreProduct(p, effectiveKeywords, features) }));
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // tie-breaker: prefer lower price
      return (a.p.price || 0) - (b.p.price || 0);
    });

    const top = scored.slice(0, 20).map(x => x.p);

    console.log("✅ Final returned products:", top.length);

    return res.json({ products: top, debug: { parsed, effectiveKeywords, features } });
  } catch (err) {
    console.error("🔥 BACKEND ERROR:", err);
    return res.status(500).json({ products: [] });
  }
});

app.listen(3001, () => console.log("Backend running on 3001"));
