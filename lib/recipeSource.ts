/**
 * Read a recipe from a blog post URL. WordPress recipe plugins (WP Recipe Maker, Tasty, Mediavine…) publish
 * schema.org "Recipe" JSON-LD with the name, photo, ingredients and steps — we use that first, then fall back to
 * the page's Open Graph tags and visible text.
 */
export type RecipeSource = {
  title: string;
  description: string;
  ingredients: string[];
  steps: string[];
  imageUrl: string | null;
  text: string; // everything above as plain text for the writer
  url: string | null;
};

const decode = (s: string) =>
  s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
const strip = (html: string) => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

function meta(html: string, prop: string): string | null {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*>`, "i");
  const tag = html.match(re)?.[0];
  const c = tag?.match(/content=["']([^"']*)["']/i)?.[1];
  return c ? decode(c).trim() : null;
}

function findRecipe(node: any): any {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const r = findRecipe(n);
      if (r) return r;
    }
    return null;
  }
  const t = node["@type"];
  if (t === "Recipe" || (Array.isArray(t) && t.includes("Recipe"))) return node;
  return findRecipe(node["@graph"]) || null;
}

function imageOf(v: any): string | null {
  if (!v) return null;
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return imageOf(v[v.length - 1]) || imageOf(v[0]); // last is usually the largest
  return v.url || v.contentUrl || null;
}

function stepsOf(v: any): string[] {
  if (!v) return [];
  if (typeof v === "string") return strip(v).split(/(?<=[.!?])\s+(?=[A-Z0-9])/).filter(Boolean);
  if (Array.isArray(v)) return v.flatMap(stepsOf);
  if (v["@type"] === "HowToSection") return stepsOf(v.itemListElement);
  if (v.text) return [strip(String(v.text))];
  if (v.name) return [strip(String(v.name))];
  return [];
}

export function toText(r: Omit<RecipeSource, "text">): string {
  return [
    `Recipe: ${r.title}`,
    r.description ? `Description: ${r.description}` : "",
    r.ingredients.length ? `Ingredients:\n- ${r.ingredients.join("\n- ")}` : "",
    r.steps.length ? `Steps:\n${r.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function fetchRecipe(url: string): Promise<RecipeSource> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error("That link is not a valid URL");
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error("Use an http(s) link");
  const res = await fetch(u, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`The page answered ${res.status}. Paste the recipe text and photo instead.`);
  const html = (await res.text()).slice(0, 3_000_000);

  let recipe: any = null;
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      recipe = findRecipe(JSON.parse(m[1].trim()));
      if (recipe) break;
    } catch {}
  }

  const base = (s: string | null) => (s ? new URL(s, u).toString() : null);
  if (recipe) {
    const r = {
      title: strip(String(recipe.name || meta(html, "og:title") || "Recipe")),
      description: strip(String(recipe.description || meta(html, "og:description") || "")),
      ingredients: (Array.isArray(recipe.recipeIngredient) ? recipe.recipeIngredient : []).map((x: any) => strip(String(x))),
      steps: stepsOf(recipe.recipeInstructions).slice(0, 25),
      imageUrl: base(imageOf(recipe.image) || meta(html, "og:image")),
      url: u.toString(),
    };
    return { ...r, text: toText(r) };
  }

  // No recipe card: use the article text.
  const body = html.match(/<article[\s\S]*?<\/article>/i)?.[0] || html.match(/<body[\s\S]*<\/body>/i)?.[0] || html;
  const text = strip(body.replace(/<(script|style|nav|footer|header|aside)[\s\S]*?<\/\1>/gi, " ")).slice(0, 8000);
  if (text.length < 200 && !meta(html, "og:description")) {
    throw new Error("Could not read a recipe on that page (Facebook and some sites need a login). Paste the recipe text and photo instead.");
  }
  const r = {
    title: meta(html, "og:title") || strip(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || "Recipe"),
    description: meta(html, "og:description") || "",
    ingredients: [],
    steps: [],
    imageUrl: base(meta(html, "og:image")),
    url: u.toString(),
  };
  return { ...r, text: `${toText(r)}\n\nPage text:\n${text}` };
}
