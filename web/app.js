// Choovio chat client. All server/page-derived text goes through textContent — never innerHTML.

const chat = document.getElementById("chat");
const landing = document.getElementById("landing");
const form = document.getElementById("composer");
const input = document.getElementById("input");

// A one-row textarea can't wrap its placeholder, so narrow screens get a shorter one.
const narrow = window.matchMedia("(max-width: 480px)");
const syncPlaceholder = () => { input.placeholder = narrow.matches ? "What are you shopping for?" : "What are you shopping for? Paste links to compare…"; };
syncPlaceholder();
narrow.addEventListener("change", syncPlaceholder);
const sendBtn = document.getElementById("send");
const demoBanner = document.getElementById("demo-banner");
const statusBanner = document.getElementById("status-banner");
const statusText = document.getElementById("status-text");
const modeGroup = document.getElementById("mode");
const modeLive = document.getElementById("mode-live");
const modeDemo = document.getElementById("mode-demo");
const newChatBtn = document.getElementById("new-chat");

let mode = "live";
let draft = null;
let status = null;
let busy = false;
let controller = null;

const reduceMotion = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };

try {
  const saved = localStorage.getItem("choovio-mode");
  if (saved === "demo" || saved === "live") mode = saved;
} catch {}

/* ---------- DOM helpers ---------- */

function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function safeHref(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

function imageSrc(url) {
  if (!url) return null;
  const href = safeHref(url);
  if (!href) return null;
  try {
    return new URL(href).protocol === "https:" ? href : null;
  } catch {
    return null;
  }
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return String(url); }
}

function link(url, label, cls) {
  const href = safeHref(url);
  if (!href) return el("span", cls ? { class: cls } : {}, label);
  const attrs = { href, target: "_blank", rel: "noopener noreferrer nofollow" };
  if (cls) attrs.class = cls;
  return el("a", attrs, label);
}

// Static, author-defined icon paths (24×24, stroked). Never built from server data.
const SVGNS = "http://www.w3.org/2000/svg";
const ICONS = {
  bag: ["M5.5 8h13l-1 12.2a1 1 0 0 1-1 .8h-9a1 1 0 0 1-1-.8z", "M9 8V6.5a3 3 0 0 1 6 0V8"],
  check: ["M5 12.5l4.5 4.5L19 7.5"],
  checkCircle: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M8.5 12.2l2.4 2.4 4.6-4.8"],
  alert: ["M10.3 4.2 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z", "M12 9.5v4", "M12 17v.01"],
  info: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M12 11v5", "M12 7.5v.01"],
  external: ["M14 4h6v6", "M20 4l-9 9", "M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"],
  star: ["M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"],
  swap: ["M7 4 3 8l4 4", "M3 8h14", "M17 20l4-4-4-4", "M21 16H7"],
  layers: ["M12 3 2.5 8 12 13l9.5-5z", "M2.5 12.5 12 17.5l9.5-5", "M2.5 16.5 12 21.5l9.5-5"],
  wallet: ["M4 7h15a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z", "M4 7V6a2 2 0 0 1 2-2h11", "M16 13.5h.01"],
  table: ["M4 4h16v16H4z", "M4 10h16", "M10 4v16"],
  clock: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M12 7v5l3 2"],
  help: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M9.5 9.3a2.6 2.6 0 0 1 5 .9c0 1.7-2.5 2.3-2.5 3.8", "M12 17v.01"],
  code: ["M8 7l-5 5 5 5", "M16 7l5 5-5 5"],
  chevron: ["M9 6l6 6-6 6"],
  link: ["M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1", "M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"],
  question: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M12 16v.01", "M12 13v-1.5"],
};

function icon(name, size = 16, cls = "icon") {
  const s = document.createElementNS(SVGNS, "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("width", String(size));
  s.setAttribute("height", String(size));
  s.setAttribute("fill", "none");
  s.setAttribute("stroke", "currentColor");
  s.setAttribute("stroke-width", "1.8");
  s.setAttribute("stroke-linecap", "round");
  s.setAttribute("stroke-linejoin", "round");
  s.setAttribute("aria-hidden", "true");
  s.setAttribute("focusable", "false");
  s.setAttribute("class", cls);
  for (const d of ICONS[name] ?? []) {
    const p = document.createElementNS(SVGNS, "path");
    p.setAttribute("d", d);
    s.appendChild(p);
  }
  return s;
}

function hueFor(text) {
  let h = 0;
  for (const ch of String(text)) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}

/** Product image with an elegant placeholder underneath; never shows a broken-image icon. */
function productMedia(product, cls = "media") {
  const box = el("div", { class: cls });
  const label = String(product?.brand || product?.name || "?").trim() || "?";
  const ph = el("div", { class: "ph", "aria-hidden": "true" });
  ph.style.setProperty("--ph-hue", String(hueFor(label)));
  ph.append(icon("bag", 26, "ph-icon"), el("span", { class: "ph-initial" }, label.charAt(0).toUpperCase()));
  box.appendChild(ph);

  const src = imageSrc(product?.imageUrl);
  if (src) {
    const img = el("img", {
      alt: product?.name ?? "",
      loading: "lazy",
      decoding: "async",
      referrerpolicy: "no-referrer",
    });
    img.addEventListener("load", () => {
      if (img.naturalWidth > 1 && img.naturalHeight > 1) box.classList.add("has-img");
      else img.remove();
    });
    img.addEventListener("error", () => { img.remove(); box.classList.remove("has-img"); });
    img.src = src;
    box.appendChild(img);
  }
  return box;
}

/* ---------- layout / thread ---------- */

function scrollBehavior() {
  return reduceMotion.matches ? "auto" : "smooth";
}

function scrollDown() {
  requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight, behavior: scrollBehavior() }));
}

function scrollToNode(node) {
  requestAnimationFrame(() => node.scrollIntoView({ block: "start", behavior: scrollBehavior() }));
}

function startThread() {
  if (!document.body.classList.contains("has-thread")) {
    document.body.classList.add("has-thread");
    landing.hidden = true;
    newChatBtn.hidden = false;
  }
}

function resetThread() {
  if (controller) controller.abort();
  chat.replaceChildren();
  draft = null;
  document.body.classList.remove("has-thread");
  landing.hidden = false;
  newChatBtn.hidden = true;
  input.value = "";
  autosize();
  updateSendState();
  window.scrollTo({ top: 0, behavior: scrollBehavior() });
  input.focus();
}

function botShell(extraClass = "") {
  const box = el("div", { class: `msg bot${extraClass ? " " + extraClass : ""}` });
  const avatar = el("div", { class: "avatar" });
  avatar.appendChild(el("img", { src: "/favicon.svg", alt: "", width: "28", height: "28" }));
  avatar.appendChild(el("span", { class: "who" }, "Choovio"));
  const body = el("div", { class: "bot-body" });
  box.append(avatar, body);
  return { box, body };
}

/* ---------- mode / status ---------- */

function setMode(next, fromUser = false) {
  const changed = next !== mode;
  mode = next;
  draft = null;
  modeLive.setAttribute("aria-pressed", String(mode === "live"));
  modeDemo.setAttribute("aria-pressed", String(mode === "demo"));
  modeGroup.dataset.mode = mode;
  demoBanner.hidden = mode !== "demo";
  try { localStorage.setItem("choovio-mode", mode); } catch {}
  renderStatus();
  if (fromUser && changed && chat.childElementCount) {
    chat.appendChild(el("div", { class: "divider", role: "separator" }, mode === "demo" ? "Switched to Demo mode — starting a fresh request" : "Switched to Live mode — starting a fresh request"));
    scrollDown();
  }
}

function renderStatus() {
  if (!status || mode === "demo") {
    statusBanner.hidden = true;
    return;
  }
  if (!status.liveSearch) {
    statusBanner.hidden = false;
    statusText.textContent = "Live search isn't configured on this server yet, so open-ended searches won't work. You can still paste product links to compare, or switch to Demo.";
  } else {
    statusBanner.hidden = true;
  }
}

/* ---------- messages ---------- */

function addUser(text) {
  startThread();
  const box = el("div", { class: "msg user" });
  box.appendChild(el("div", { class: "user-bubble" }, text));
  chat.appendChild(box);
  scrollDown();
}

const STEPS = ["Understanding your request", "Searching stores", "Reading product pages", "Comparing prices & reviews"];

function addTyping() {
  const { box, body } = botShell("loading");
  const card = el("div", { class: "progress-card", role: "status" });
  card.appendChild(el("div", { class: "progress-bar", "aria-hidden": "true" }));
  const head = el("div", { class: "progress-head" });
  head.append(el("span", { class: "spinner spinner--accent", "aria-hidden": "true" }), el("span", { class: "progress-title" }, "Researching — checking prices, stock and reviews…"));
  card.appendChild(head);
  const list = el("ol", { class: "steps", "aria-hidden": "true" });
  const items = STEPS.map((s) => {
    const li = el("li", { class: "step" });
    li.append(el("span", { class: "step-dot" }), el("span", { class: "step-label" }, s));
    list.appendChild(li);
    return li;
  });
  card.appendChild(list);
  body.appendChild(card);
  chat.appendChild(box);

  let i = 0;
  items[0].classList.add("is-active");
  const timer = setInterval(() => {
    if (i >= items.length - 1) return;
    items[i].classList.remove("is-active");
    items[i].classList.add("is-done");
    items[i].querySelector(".step-dot").appendChild(icon("check", 12));
    i += 1;
    items[i].classList.add("is-active");
  }, 2300);

  scrollDown();
  return { remove() { clearInterval(timer); box.remove(); } };
}

function addError(text) {
  const { box, body } = botShell();
  const alert = el("div", { class: "alert", role: "alert" });
  alert.append(icon("alert", 18), el("p", {}, text));
  body.appendChild(alert);
  chat.appendChild(box);
  scrollDown();
}

const AVAIL = { in_stock: "In stock", out_of_stock: "Out of stock", preorder: "Pre-order", limited: "Limited stock", discontinued: "Discontinued", unknown: "Stock not stated" };
const AVAIL_TONE = { in_stock: "ok", limited: "warn", preorder: "warn", out_of_stock: "bad", discontinued: "bad", unknown: "neutral" };
const KIND = { manufacturer_spec: "Manufacturer spec", retailer_listing: "Retailer listing", independent_review: "Independent review", retailer_rating: "Seller-hosted rating", marketing_claim: "Marketing claim", search_snippet: "Search snippet" };

function money(m) {
  if (!m) return null;
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency: m.currency }).format(m.amount); }
  catch { return `${m.amount} ${m.currency}`; }
}

function fmtTime(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
}

function iconList(items, iconName, cls) {
  const ul = el("ul", { class: `icon-list ${cls}` });
  for (const t of items) {
    const li = el("li");
    li.append(icon(iconName, 16), el("span", {}, t));
    ul.appendChild(li);
  }
  return ul;
}

function renderCard(rec, sp, role, tradeoff) {
  const node = el("article", { class: `card card--${role}` });
  const offer = sp.bestOffer;
  const name = sp.product.name + (sp.product.variant ? ` (${sp.product.variant})` : "");

  node.appendChild(productMedia({ ...sp.product, name }, "media card-media"));

  const body = el("div", { class: "card-body" });
  node.appendChild(body);

  // Badge + stock
  const top = el("div", { class: "card-top" });
  const badge = el("span", { class: `badge badge--${role}` });
  if (role === "best") badge.appendChild(icon("star", 13));
  badge.appendChild(document.createTextNode(role === "best" ? "Best choice" : role === "alt" ? "Alternative" : "Also compared"));
  const av = offer ? offer.availability : "unknown";
  const stock = el("span", { class: `pill pill--${AVAIL_TONE[av] ?? "neutral"} stock` });
  stock.append(el("span", { class: "pill-dot", "aria-hidden": "true" }), document.createTextNode(AVAIL[av] ?? "Stock not stated"));
  top.append(badge, stock);
  body.appendChild(top);

  body.appendChild(el("h3", { class: "card-name" }, name));
  const subParts = [sp.product.brand, offer?.seller ? `Sold by ${offer.seller}` : null].filter(Boolean);
  if (subParts.length) body.appendChild(el("p", { class: "card-sub" }, subParts.join(" · ")));

  // Price
  const priceRow = el("div", { class: "card-price" });
  const p = offer && money(offer.price);
  priceRow.appendChild(el("span", { class: p ? "price" : "price price--unknown" }, p ?? "Price not verified"));
  if (offer?.shipping) {
    priceRow.appendChild(el("span", { class: "price-note" }, offer.shipping.amount === 0 ? "+ free shipping (stated)" : `+ ${money(offer.shipping)} shipping`));
  }
  body.appendChild(priceRow);

  // Why
  const reasons = role === "best" ? rec.best.why : sp.fit.reasons.slice(0, 2);
  if (reasons.length) body.appendChild(iconList(reasons, "check", "card-why"));

  // Trade-off / ineligible reason
  const tradeText = tradeoff ?? (sp.eligible ? "" : sp.ineligibleReason ?? "");
  if (tradeText) {
    const t = el("div", { class: "card-tradeoff" });
    t.append(icon(role === "alt" ? "swap" : "info", 16), el("p", {}, tradeText));
    body.appendChild(t);
  }

  // Concerns
  const concerns = sp.fit.concerns.slice(0, 5);
  if (concerns.length) body.appendChild(iconList(concerns, "alert", "card-concerns"));

  // Actions
  const l = rec.links.find((x) => x.productId === sp.product.id);
  const href = l && safeHref(l.url);
  if (href) {
    const actions = el("div", { class: "card-actions" });
    const a = el("a", { class: role === "best" ? "btn btn--primary" : "btn btn--secondary", href, target: "_blank", rel: "noopener noreferrer nofollow" });
    a.append(document.createTextNode("View product"), icon("external", 15));
    actions.appendChild(a);
    if (l.affiliate) actions.appendChild(el("span", { class: "aff", title: "Choovio may earn a commission from this link. Affiliate status is never used for ranking." }, "affiliate"));
    body.appendChild(actions);
  }

  // Details & sources
  const more = el("details", { class: "card-more" });
  const summary = el("summary");
  summary.append(el("span", {}, "Details & sources"), icon("chevron", 16, "icon chev"));
  more.appendChild(summary);

  const facts = el("dl", { class: "facts" });
  const addFact = (k, v) => {
    if (!v) return;
    const row = el("div", { class: "fact" });
    row.append(el("dt", {}, k), el("dd", {}, v));
    facts.appendChild(row);
  };
  addFact("Brand", sp.product.brand);
  addFact("Model", sp.product.model);
  if (offer) {
    addFact("Seller", offer.seller);
    addFact("Shipping", offer.shipping ? (offer.shipping.amount === 0 ? "Free (stated)" : money(offer.shipping)) : "Not stated");
    addFact("Delivery", offer.deliveryDays ? `${offer.deliveryDays.min}–${offer.deliveryDays.max} days` : "Not stated");
    addFact("Returns", offer.returnPolicy ?? "Not stated");
    addFact("Warranty", offer.warranty ?? "Not stated");
    if (offer.listPrice) addFact("Claimed 'was' price", `${money(offer.listPrice)} (seller's claim, not verified)`);
  }
  for (const s of sp.product.specs.slice(0, 6)) addFact(s.name, `${s.value} — ${KIND[s.source.kind] ?? s.source.kind}`);
  for (const r of sp.product.reviews.slice(0, 3)) addFact(KIND[r.kind] ?? "Review", r.summary);
  if (facts.childElementCount) more.appendChild(facts);

  const sources = el("ul", { class: "sources" });
  const seen = new Set();
  for (const s of [...sp.product.offers.map((o) => o.source), ...sp.product.specs.map((x) => x.source), ...sp.product.reviews.map((r) => r.source)]) {
    if (!s) continue;
    const key = s.url + s.kind;
    if (seen.has(key)) continue;
    seen.add(key);
    const li = el("li", { class: "source" });
    const a = link(s.url, hostOf(s.url), "source-host");
    a.prepend(icon("link", 13));
    li.append(a, el("span", { class: "source-meta" }, `${KIND[s.kind] ?? s.kind} · checked ${fmtTime(s.checkedAt)}`));
    sources.appendChild(li);
  }
  if (sources.childElementCount) {
    more.appendChild(el("h4", { class: "mini-title" }, "Sources"));
    more.appendChild(sources);
  }
  body.appendChild(more);
  return node;
}

function sectionHead(title, iconName, count) {
  const h = el("h3", { class: "section-title" });
  h.appendChild(icon(iconName, 16));
  h.appendChild(document.createTextNode(title));
  if (count) h.appendChild(el("span", { class: "count" }, count));
  return h;
}

function renderRecommendation(rec, notice) {
  const { box, body } = botShell("result");

  const head = el("div", { class: "result-head" });
  if (rec.dataMode === "demo") head.appendChild(el("span", { class: "pill pill--demo" }, "DEMO DATA"));
  const statusLabel = { complete: "Research complete", partial: "Partial research", insufficient: "Not enough verified info" }[rec.status];
  const tone = rec.status === "complete" ? "ok" : rec.status === "partial" ? "warn" : "bad";
  const sp = el("span", { class: `pill pill--${tone}` });
  sp.append(icon(rec.status === "complete" ? "checkCircle" : "alert", 13), document.createTextNode(statusLabel ?? String(rec.status)));
  head.appendChild(sp);
  head.appendChild(el("span", { class: "result-count" }, `${rec.products.length} product${rec.products.length === 1 ? "" : "s"} compared`));
  body.appendChild(head);

  if (notice) {
    const n = el("div", { class: "notice" });
    n.append(icon("info", 16), el("p", {}, notice));
    body.appendChild(n);
  }

  const byId = new Map(rec.products.map((p) => [p.product.id, p]));
  const lead = el("div", { class: "lead" });
  if (!rec.best) {
    lead.appendChild(el("p", {}, "I couldn't find an option I'd confidently recommend yet."));
    const reasons = [...new Set(rec.products.map((p) => p.ineligibleReason).filter(Boolean))];
    if (reasons.length) lead.appendChild(el("p", { class: "lead-sub" }, `What got in the way: ${reasons.join("; ").toLowerCase()}.`));
  } else {
    const best = byId.get(rec.best.productId);
    lead.appendChild(el("p", {}, `My pick is the ${best.product.name}. Here's why, plus two alternatives worth considering.`));
  }
  body.appendChild(lead);

  if (rec.best && byId.get(rec.best.productId)) body.appendChild(renderCard(rec, byId.get(rec.best.productId), "best"));

  const alts = rec.alternatives.map((a) => [byId.get(a.productId), a.tradeoff]).filter(([s]) => s);
  if (alts.length) {
    const sec = el("section", { class: "section" });
    sec.appendChild(sectionHead("Alternatives", "layers"));
    const grid = el("div", { class: "card-grid" });
    for (const [s, t] of alts) grid.appendChild(renderCard(rec, s, "alt", t));
    sec.appendChild(grid);
    body.appendChild(sec);
  }

  const shown = new Set([rec.best?.productId, ...rec.alternatives.map((a) => a.productId)]);
  const others = rec.products.filter((s) => !shown.has(s.product.id));
  if (others.length) {
    const sec = el("section", { class: "section" });
    sec.appendChild(sectionHead(rec.best ? "Also compared" : "What I compared", "bag", String(others.length)));
    const grid = el("div", { class: "card-grid" });
    for (const s of others) grid.appendChild(renderCard(rec, s, "other"));
    sec.appendChild(grid);
    body.appendChild(sec);
  }

  // Cost + heads-up panels
  const panels = el("div", { class: "panels" });
  const bestCost = rec.best && rec.costs.find((c) => c.productId === rec.best.productId);
  if (bestCost) {
    const panel = el("section", { class: "panel" });
    panel.appendChild(sectionHead("What you'll actually pay", "wallet"));
    const total = el("div", { class: "cost-total" });
    total.append(
      el("span", { class: "cost-label" }, "Known so far"),
      el("span", { class: money(bestCost.knownTotal) ? "cost-amount" : "cost-amount cost-amount--unknown" }, money(bestCost.knownTotal) ?? "not confirmed"),
      el("span", { class: "cost-note" }, bestCost.shipping ? "item + stated shipping" : "item only"),
    );
    panel.appendChild(total);
    if (bestCost.unknownCosts.length) {
      panel.appendChild(el("p", { class: "mini-title" }, "Unknown"));
      panel.appendChild(iconList(bestCost.unknownCosts, "question", "muted-list"));
    }
    panels.appendChild(panel);
  }

  const notable = rec.uncertainties.filter((u) => !/not stated|Return policy|Shipping cost/i.test(u)).slice(0, 6);
  if (notable.length) {
    const panel = el("section", { class: "panel panel--warn" });
    panel.appendChild(sectionHead("Heads-up", "alert"));
    panel.appendChild(iconList(notable, "info", "muted-list"));
    panels.appendChild(panel);
  }
  if (panels.childElementCount) body.appendChild(panels);

  // Side-by-side table
  if (rec.table.length) {
    const sec = el("section", { class: "section" });
    sec.appendChild(sectionHead("Side by side", "table"));
    const wrap = el("div", { class: "table-wrap", tabindex: "0", role: "region", "aria-label": "Side-by-side comparison" });
    const table = el("table");
    const thead = el("thead");
    const hr = el("tr");
    for (const h of ["Product", "Price", "Stock", "Delivery", "Warranty & returns", "Rating", "Key specs"]) hr.appendChild(el("th", { scope: "col" }, h));
    thead.appendChild(hr);
    const tbody = el("tbody");
    for (const r of rec.table) {
      const isBest = r.productId === rec.best?.productId;
      const tr = el("tr", isBest ? { class: "is-best" } : {});
      const nameCell = el("th", { scope: "row", class: "cell-product" });
      const product = byId.get(r.productId)?.product ?? { name: r.name, brand: null, imageUrl: null };
      const inner = el("div", { class: "cell-product-inner" });
      inner.appendChild(productMedia({ ...product, name: r.name }, "media thumb"));
      const nameWrap = el("div", { class: "cell-product-name" });
      nameWrap.appendChild(el("span", {}, r.name));
      if (isBest) nameWrap.appendChild(el("span", { class: "mini-badge" }, "Best"));
      inner.appendChild(nameWrap);
      nameCell.appendChild(inner);
      tr.appendChild(nameCell);
      for (const v of [r.price, r.availability, r.delivery, r.warrantyReturns, r.rating, r.keySpecs]) tr.appendChild(el("td", {}, v));
      tbody.appendChild(tr);
    }
    table.append(thead, tbody);
    wrap.appendChild(table);
    sec.appendChild(wrap);
    body.appendChild(sec);
  }

  const meta = el("div", { class: "meta" });
  meta.append(icon("clock", 15), el("p", {}, `Checked ${fmtTime(rec.checkedAt)}. Prices and stock change — confirm on the seller's page before buying. ${rec.disclosures.filter((d) => !/^DEMO/.test(d)).join(" ")}`));
  body.appendChild(meta);

  const details = el("details", { class: "json-toggle" });
  const sum = el("summary");
  sum.append(icon("code", 14), el("span", {}, "Structured data (JSON)"), icon("chevron", 14, "icon chev"));
  details.appendChild(sum);
  details.appendChild(el("pre", {}, JSON.stringify({ status: rec.status, data_mode: rec.dataMode, checked_at: rec.checkedAt, best: rec.best, alternatives: rec.alternatives, costs: rec.costs, uncertainties: rec.uncertainties, sources: rec.sources }, null, 2)));
  body.appendChild(details);

  chat.appendChild(box);
  scrollToNode(box);
}

function renderQuestions(reply) {
  const { box, body } = botShell();
  const card = el("div", { class: "questions-card" });
  const head = el("div", { class: "questions-head" });
  head.append(el("span", { class: "questions-icon", "aria-hidden": "true" }), el("p", {}, reply.message));
  head.firstChild.appendChild(icon("help", 18));
  card.appendChild(head);
  const ol = el("ol", { class: "questions" });
  for (const q of reply.questions) ol.appendChild(el("li", {}, q.question));
  card.appendChild(ol);
  card.appendChild(el("p", { class: "questions-hint" }, "Reply below — one message with whatever you know is plenty."));
  body.appendChild(card);
  chat.appendChild(box);
  scrollDown();
}

/* ---------- sending ---------- */

function updateSendState() {
  sendBtn.disabled = busy || !input.value.trim();
  sendBtn.classList.toggle("is-loading", busy);
  sendBtn.setAttribute("aria-label", busy ? "Researching…" : "Send");
  form.classList.toggle("is-busy", busy);
}

function autosize() {
  input.style.height = "auto";
  if (input.value) input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
  else input.style.height = "";
}

async function send(text) {
  if (busy) return;
  addUser(text);
  const typing = addTyping();
  busy = true;
  updateSendState();
  const ctrl = new AbortController();
  controller = ctrl;
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: text, draft, mode }),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    typing.remove();
    if (ctrl.signal.aborted) return;
    if (!res.ok) {
      addError(data.error ?? "Sorry — something went wrong. Please try again.");
      return;
    }
    if (data.type === "questions") {
      draft = data.draft;
      renderQuestions(data);
    } else {
      draft = null;
      renderRecommendation(data.recommendation, data.notice);
    }
  } catch {
    typing.remove();
    if (!ctrl.signal.aborted) addError("I couldn't reach the Choovio server. Check your connection and try again.");
  } finally {
    if (controller === ctrl) controller = null;
    busy = false;
    updateSendState();
    input.focus();
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || busy) return;
  input.value = "";
  autosize();
  send(text);
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    form.requestSubmit();
  }
});
input.addEventListener("input", () => {
  autosize();
  updateSendState();
});
document.getElementById("examples").addEventListener("click", (e) => {
  const card = e.target.closest(".prompt-card");
  if (!card) return;
  const text = (card.querySelector(".prompt-text") ?? card).textContent.trim();
  if (text) send(text);
});
modeLive.addEventListener("click", () => setMode("live", true));
modeDemo.addEventListener("click", () => setMode("demo", true));
newChatBtn.addEventListener("click", resetThread);

fetch("/api/status").then((r) => r.json()).then((s) => { status = s; renderStatus(); }).catch(() => {});
setMode(mode);
updateSendState();
