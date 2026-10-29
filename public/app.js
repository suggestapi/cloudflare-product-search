// Demo UI for Cloudflare Product Search. No framework, no build step.
const form = document.getElementById("search-form");
const input = document.getElementById("q");
const list = document.getElementById("suggestions");
const statusEl = document.getElementById("status");
const productsEl = document.getElementById("products");
const productsHeading = document.getElementById("products-heading");
const docsSection = document.getElementById("docs-section");
const docsEl = document.getElementById("docs");

let suggestions = [];
let active = -1;
let typeaheadController;
let debounceTimer;

async function getJson(path, params, signal) {
  const res = await fetch(`${path}?${new URLSearchParams(params)}`, { signal });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.message || `Request failed (${res.status})`), { status: res.status });
  return body;
}

function suggestionText(s) {
  return s.title || s.text || s.query || s.value || "";
}

function closeList() {
  list.hidden = true;
  input.setAttribute("aria-expanded", "false");
  input.removeAttribute("aria-activedescendant");
  active = -1;
}

function renderSuggestions() {
  list.replaceChildren(
    ...suggestions.map((s, i) => {
      const li = document.createElement("li");
      li.id = `suggestion-${i}`;
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", String(i === active));
      li.textContent = suggestionText(s);
      li.addEventListener("mousedown", (event) => {
        event.preventDefault();
        choose(i);
      });
      return li;
    })
  );
  const open = suggestions.length > 0;
  list.hidden = !open;
  input.setAttribute("aria-expanded", String(open));
  if (active >= 0) input.setAttribute("aria-activedescendant", `suggestion-${active}`);
}

function choose(i) {
  const s = suggestions[i];
  if (!s) return;
  closeList();
  if (s.url) {
    window.location.href = s.url;
    return;
  }
  input.value = suggestionText(s);
  runSearch(input.value);
}

async function typeahead(query) {
  typeaheadController?.abort();
  if (query.length < 2) {
    suggestions = [];
    closeList();
    return;
  }
  typeaheadController = new AbortController();
  try {
    const data = await getJson("/api/autocomplete", { q: query, limit: 6 }, typeaheadController.signal);
    suggestions = data.suggestions || [];
    active = -1;
    renderSuggestions();
  } catch (error) {
    if (error.name !== "AbortError") closeList();
  }
}

function formatPrice(price, currency) {
  if (typeof price !== "number") return "";
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: currency || "USD" }).format(price);
  } catch {
    return String(price);
  }
}

function renderProducts(items) {
  productsHeading.hidden = items.length === 0;
  productsEl.replaceChildren(
    ...items.map((item) => {
      const li = document.createElement("li");
      if (item.image) {
        const img = document.createElement("img");
        img.src = item.image;
        img.alt = "";
        img.loading = "lazy";
        li.append(img);
      }
      const title = document.createElement(item.url ? "a" : "div");
      title.className = "title";
      title.textContent = item.title || item.id || "Untitled";
      if (item.url) title.href = item.url;
      li.append(title);
      if (item.subtitle) {
        const sub = document.createElement("div");
        sub.className = "subtitle";
        sub.textContent = item.subtitle;
        li.append(sub);
      }
      const price = formatPrice(item.price, item.currency);
      if (price) {
        const p = document.createElement("div");
        p.className = "price";
        p.textContent = price;
        li.append(p);
      }
      return li;
    })
  );
}

function renderDocs(results) {
  docsSection.hidden = results.length === 0;
  docsEl.replaceChildren(
    ...results.map((r) => {
      const li = document.createElement("li");
      const text = document.createElement("div");
      text.textContent = (r.title ? `${r.title}: ` : "") + (r.text || "").slice(0, 240);
      const source = document.createElement("div");
      source.className = "source";
      source.textContent = r.source;
      li.append(text, source);
      return li;
    })
  );
}

async function runSearch(query) {
  query = query.trim();
  if (!query) return;
  closeList();
  statusEl.textContent = "Searching…";
  const url = new URL(window.location.href);
  url.searchParams.set("q", query);
  history.replaceState(null, "", url);

  const [products, docs] = await Promise.allSettled([
    getJson("/api/search", { q: query }),
    getJson("/api/ask", { q: query, limit: 3 })
  ]);

  if (products.status === "fulfilled") {
    const items = products.value.suggestions || [];
    renderProducts(items);
    const corrected = products.value.corrected_query;
    statusEl.textContent =
      `${items.length} product${items.length === 1 ? "" : "s"}` +
      (corrected && corrected !== query ? ` · showing results for “${corrected}”` : "");
  } else {
    renderProducts([]);
    statusEl.textContent = products.reason.status === 501
      ? "Product search is not configured. Set SUGGESTAPI_PUBLIC_KEY."
      : products.reason.message;
  }

  renderDocs(docs.status === "fulfilled" ? docs.value.results || [] : []);
}

input.addEventListener("input", () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => typeahead(input.value.trim()), 120);
});

input.addEventListener("keydown", (event) => {
  if (list.hidden) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : -1;
    active = (active + step + suggestions.length) % suggestions.length;
    renderSuggestions();
  } else if (event.key === "Enter" && active >= 0) {
    event.preventDefault();
    choose(active);
  } else if (event.key === "Escape") {
    closeList();
  }
});

input.addEventListener("blur", () => setTimeout(closeList, 100));

form.addEventListener("submit", (event) => {
  event.preventDefault();
  runSearch(input.value);
});

const initial = new URLSearchParams(window.location.search).get("q");
if (initial) {
  input.value = initial;
  runSearch(initial);
}
