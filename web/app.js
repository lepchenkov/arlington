const state = {
  records: [],
  payload: null,
  windowYears: 3,
  propertyType: "All",
  charts: {},
  map: null,
  mapTileLayer: null,
  mapTileTheme: null,
  heatLayer: null,
  mapReady: false,
  mapVisible: false,
  heatCache: new Map(),
  theme: document.documentElement.dataset.theme || "light",
};

const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const compactNumber = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

const monthLabelFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  year: "2-digit",
});

const quarterLabelFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  year: "numeric",
});

const propertyTypeSelect = document.querySelector("#property-type");
const windowControls = document.querySelector("#window-controls");
const themeToggle = document.querySelector("#theme-toggle");

boot().catch((error) => {
  console.error(error);
  document.querySelector("#generated-at").textContent = "Build failed";
});

async function boot() {
  installRevealAnimation();
  bindControls();

  const response = await fetch("./data/transactions.json");
  if (!response.ok) {
    throw new Error(`Unable to load dashboard data: ${response.status}`);
  }

  const payload = await response.json();
  state.payload = payload;
  state.records = payload.records.map((record) => {
    const saleDate = new Date(`${record.saleDate}T00:00:00`);
    return {
      ...record,
      saleDate,
      saleMonth: `${saleDate.getFullYear()}-${String(saleDate.getMonth() + 1).padStart(2, "0")}`,
      saleQuarter: `${saleDate.getFullYear()}-Q${Math.floor(saleDate.getMonth() / 3) + 1}`,
    };
  });

  populateMeta(payload);
  populatePropertyTypes(payload.propertyTypes);
  renderNotes(payload.notes);
  initializeCharts();
  syncThemeUi();
  installMapLoader();
  render();
}

function bindControls() {
  windowControls.addEventListener("click", (event) => {
    const button = event.target.closest("[data-window]");
    if (!button) {
      return;
    }

    state.windowYears = Number(button.dataset.window);
    for (const item of windowControls.querySelectorAll(".chip")) {
      item.classList.toggle("is-active", item === button);
    }
    render();
  });

  propertyTypeSelect.addEventListener("change", (event) => {
    state.propertyType = event.target.value;
    render();
  });
  themeToggle.addEventListener("click", toggleTheme);
}

function populateMeta(payload) {
  const generatedAt = new Date(payload.generatedAt);
  document.querySelector("#generated-at").textContent = dateFormatter.format(generatedAt);
  document.querySelector("#coverage-window").textContent = `${payload.window.startDate} to ${payload.window.endDate}`;
  const sourceLink = document.querySelector("#source-link");
  sourceLink.href = payload.source.salesApi;
  document.querySelector("#method-note").textContent = payload.notes[2];
}

function populatePropertyTypes(propertyTypes) {
  const options = ["All", ...propertyTypes];
  propertyTypeSelect.innerHTML = options
    .map((option) => `<option value="${option}">${option}</option>`)
    .join("");
}

function renderNotes(notes) {
  const noteList = document.querySelector("#dataset-notes");
  noteList.innerHTML = notes.map((note) => `<li>${note}</li>`).join("");
}

function initializeCharts() {
  state.charts.transactions = new Chart(document.querySelector("#transactions-chart"), {
    type: "line",
    data: { labels: [], datasets: [] },
    options: sharedLineOptions("Transactions"),
  });

  state.charts.price = new Chart(document.querySelector("#price-chart"), {
    type: "line",
    data: { labels: [], datasets: [] },
    options: sharedLineOptions("Median price", true),
  });

  state.charts.mix = new Chart(document.querySelector("#mix-chart"), {
    type: "bar",
    data: { labels: [], datasets: [] },
    options: sharedBarOptions(),
  });

  state.charts.zip = new Chart(document.querySelector("#zip-chart"), {
    type: "bar",
    data: { labels: [], datasets: [] },
    options: sharedHorizontalBarOptions(),
  });
}

function initializeMap() {
  if (state.mapReady) {
    return;
  }

  const map = L.map("sales-map", {
    preferCanvas: true,
    scrollWheelZoom: false,
    zoomControl: false,
  }).setView([38.8816, -77.091], 12);

  state.mapTileLayer = createMapTileLayer(state.theme);
  state.mapTileLayer.addTo(map);
  state.mapTileTheme = state.theme;

  L.control
    .zoom({
      position: "topright",
    })
    .addTo(map);

  state.map = map;
  state.heatLayer = L.heatLayer([], {
    blur: 26,
    maxZoom: 14,
    minOpacity: 0.35,
    radius: 28,
    gradient: {
      0.2: "#f0cb73",
      0.45: "#e39156",
      0.7: "#c55d40",
      0.95: "#6d2530",
    },
  }).addTo(map);
  state.mapReady = true;
}

function installMapLoader() {
  const mapSection = document.querySelector(".map-section");
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) {
          continue;
        }

        initializeMap();
        state.mapVisible = true;
        state.map.invalidateSize();
        renderMap(getFilteredRecords());
        observer.disconnect();
        break;
      }
    },
    {
      rootMargin: "220px 0px",
      threshold: 0.1,
    },
  );

  observer.observe(mapSection);
}

function render() {
  const filtered = getFilteredRecords();
  renderStats(filtered);
  renderTransactionChart(filtered);
  renderPriceChart(filtered);
  renderMixChart(filtered);
  renderZipChart(filtered);
  renderRecentSales(filtered);
  renderMap(filtered);
}

function getFilteredRecords() {
  const latestDate = getLatestDate();
  const threshold = new Date(latestDate);
  threshold.setFullYear(threshold.getFullYear() - state.windowYears);

  return state.records.filter((record) => {
    if (record.saleDate < threshold) {
      return false;
    }
    if (state.propertyType !== "All" && record.propertyType !== state.propertyType) {
      return false;
    }
    return true;
  });
}

function getLatestDate() {
  return state.records.reduce((latest, record) => {
    if (!latest || record.saleDate > latest) {
      return record.saleDate;
    }
    return latest;
  }, null);
}

function renderStats(records) {
  const count = records.length;
  const amounts = records.map((record) => record.saleAmount).sort((left, right) => left - right);
  const totalVolume = amounts.reduce((sum, value) => sum + value, 0);
  const median = amounts.length ? amounts[Math.floor(amounts.length / 2)] : 0;
  const latestRecord = records[0];

  setText("#transactions-value", count.toLocaleString("en-US"));
  setText("#transactions-foot", `${state.windowYears}-year transaction count`);
  setText("#median-value", amounts.length ? currency.format(median) : "-");
  setText("#median-foot", "50th percentile recorded sale");
  setText("#volume-value", compactNumber.format(totalVolume));
  setText("#volume-foot", `${currency.format(totalVolume)} in total volume`);
  setText("#recent-value", latestRecord ? dateFormatter.format(latestRecord.saleDate) : "-");
  setText(
    "#recent-foot",
    latestRecord ? `${latestRecord.address} sold for ${currency.format(latestRecord.saleAmount)}` : "-",
  );
}

function renderTransactionChart(records) {
  const theme = getThemePalette();
  const grouped = groupBy(records, "saleMonth");
  const labels = Array.from(grouped.keys()).sort();
  const values = labels.map((label) => grouped.get(label).length);

  updateLineChart(state.charts.transactions, labels, values, {
    borderColor: theme.lineCool,
    backgroundColor: theme.lineCoolFill,
  }, (label) => monthLabelFormatter.format(new Date(`${label}-01T00:00:00`)));
}

function renderPriceChart(records) {
  const theme = getThemePalette();
  const grouped = groupBy(records, "saleQuarter");
  const labels = Array.from(grouped.keys()).sort();
  const values = labels.map((label) => median(grouped.get(label).map((record) => record.saleAmount)));

  updateLineChart(state.charts.price, labels, values, {
    borderColor: theme.lineWarm,
    backgroundColor: theme.lineWarmFill,
  }, (label) => quarterLabel(label));
}

function renderMixChart(records) {
  const theme = getThemePalette();
  const counts = countBy(records, "propertyType");
  const labels = Array.from(counts.keys());
  const values = labels.map((label) => counts.get(label));

  state.charts.mix.data.labels = labels;
  state.charts.mix.data.datasets = [
    {
      label: "Transactions",
      data: values,
      borderRadius: 12,
      backgroundColor: [theme.bar1, theme.bar2, theme.bar3, theme.bar4],
    },
  ];
  state.charts.mix.update();
}

function renderZipChart(records) {
  const theme = getThemePalette();
  const grouped = groupBy(records, "zipCode");
  const zips = Array.from(grouped.entries())
    .filter(([, items]) => items.length >= 12)
    .map(([zip, items]) => ({
      zip,
      median: median(items.map((item) => item.saleAmount)),
    }))
    .sort((left, right) => right.median - left.median)
    .slice(0, 7);

  state.charts.zip.data.labels = zips.map((item) => item.zip);
  state.charts.zip.data.datasets = [
    {
      label: "Median sale price",
      data: zips.map((item) => item.median),
      borderRadius: 12,
      backgroundColor: theme.zipBar,
    },
  ];
  state.charts.zip.update();
}

function renderRecentSales(records) {
  const salesList = document.querySelector("#recent-sales");
  const rows = records.slice(0, 8);

  salesList.innerHTML = rows
    .map((record) => {
      return `
        <article class="sale-row">
          <div class="sale-topline">
            <span class="sale-address">${record.address}</span>
            <span class="sale-price">${currency.format(record.saleAmount)}</span>
          </div>
          <p class="sales-meta">
            ${dateFormatter.format(record.saleDate)} · ${record.propertyType} · ZIP ${record.zipCode}
          </p>
        </article>
      `;
    })
    .join("");
}

function renderMap(records) {
  if (!state.mapReady || !state.mapVisible) {
    return;
  }

  const heatPoints = buildHeatGrid(records);
  state.heatLayer.setLatLngs(heatPoints);
}

function buildHeatGrid(records) {
  const cacheKey = `${state.windowYears}:${state.propertyType}:${records.length}`;
  if (state.heatCache.has(cacheKey)) {
    return state.heatCache.get(cacheKey);
  }

  const grid = new Map();
  const cellSize = 0.004;

  for (const record of records) {
    const latBucket = Math.round(record.lat / cellSize);
    const lonBucket = Math.round(record.lon / cellSize);
    const key = `${latBucket}:${lonBucket}`;
    const existing = grid.get(key) || { lat: 0, lon: 0, count: 0 };
    existing.lat += record.lat;
    existing.lon += record.lon;
    existing.count += 1;
    grid.set(key, existing);
  }

  const maxCount = Math.max(...Array.from(grid.values()).map((item) => item.count), 1);
  const heatPoints = Array.from(grid.values()).map((item) => [
    item.lat / item.count,
    item.lon / item.count,
    Math.max(0.2, item.count / maxCount),
  ]);
  state.heatCache.set(cacheKey, heatPoints);
  return heatPoints;
}

function sharedLineOptions(label, currencyAxis = false) {
  const theme = getThemePalette();
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: {
      intersect: false,
      mode: "index",
    },
    plugins: {
      decimation: {
        enabled: true,
        algorithm: "lttb",
      },
      legend: {
        display: false,
      },
      tooltip: {
        callbacks: {
          label(context) {
            const value = context.parsed.y;
            return currencyAxis ? currency.format(value) : `${value.toLocaleString("en-US")} ${label.toLowerCase()}`;
          },
        },
      },
    },
    scales: {
      x: {
        ticks: {
          color: theme.muted,
          maxTicksLimit: 8,
        },
        grid: {
          display: false,
        },
      },
      y: {
        ticks: {
          color: theme.muted,
          callback(value) {
            return currencyAxis ? compactNumber.format(value) : value;
          },
        },
        grid: {
          color: theme.grid,
        },
      },
    },
  };
}

function sharedBarOptions() {
  const theme = getThemePalette();
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      decimation: {
        enabled: true,
        algorithm: "lttb",
      },
      legend: { display: false },
      tooltip: {
        callbacks: {
          label(context) {
            return `${context.parsed.y.toLocaleString("en-US")} transactions`;
          },
        },
      },
    },
    scales: {
      x: {
        ticks: { color: theme.muted },
        grid: { display: false },
      },
      y: {
        ticks: { color: theme.muted },
        grid: { color: theme.grid },
      },
    },
  };
}

function sharedHorizontalBarOptions() {
  const theme = getThemePalette();
  return {
    indexAxis: "y",
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      decimation: {
        enabled: true,
        algorithm: "lttb",
      },
      legend: { display: false },
      tooltip: {
        callbacks: {
          label(context) {
            return currency.format(context.parsed.x);
          },
        },
      },
    },
    scales: {
      x: {
        ticks: {
          color: theme.muted,
          callback(value) {
            return compactNumber.format(value);
          },
        },
        grid: { color: theme.grid },
      },
      y: {
        ticks: { color: theme.muted },
        grid: { display: false },
      },
    },
  };
}

function updateLineChart(chart, rawLabels, rawValues, palette, labelFormatter) {
  chart.data.labels = rawLabels.map(labelFormatter);
  chart.data.datasets = [
    {
      data: rawValues,
      borderColor: palette.borderColor,
      backgroundColor: palette.backgroundColor,
      fill: true,
      tension: 0.3,
      pointRadius: 0,
      pointHoverRadius: 4,
      borderWidth: 2.5,
    },
  ];
  chart.update();
}

function syncThemeUi() {
  const nextLabel = state.theme === "dark" ? "Light mode" : "Dark mode";
  themeToggle.textContent = nextLabel;
  themeToggle.setAttribute("aria-pressed", String(state.theme === "dark"));
}

function toggleTheme() {
  state.theme = state.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = state.theme;
  try {
    localStorage.setItem("arlington-theme", state.theme);
  } catch {
    // Ignore storage failures and keep the active in-memory theme.
  }
  syncThemeUi();
  syncChartTheme();
  syncMapTheme();
  render();
}

function getThemePalette() {
  const styles = getComputedStyle(document.documentElement);
  return {
    muted: styles.getPropertyValue("--muted").trim(),
    grid: styles.getPropertyValue("--chart-grid").trim(),
    lineCool: styles.getPropertyValue("--chart-line-cool").trim(),
    lineCoolFill: styles.getPropertyValue("--chart-line-cool-fill").trim(),
    lineWarm: styles.getPropertyValue("--chart-line-warm").trim(),
    lineWarmFill: styles.getPropertyValue("--chart-line-warm-fill").trim(),
    bar1: styles.getPropertyValue("--chart-bar-1").trim(),
    bar2: styles.getPropertyValue("--chart-bar-2").trim(),
    bar3: styles.getPropertyValue("--chart-bar-3").trim(),
    bar4: styles.getPropertyValue("--chart-bar-4").trim(),
    zipBar: styles.getPropertyValue("--chart-zip-bar").trim(),
  };
}

function syncChartTheme() {
  if (!state.charts.transactions) {
    return;
  }

  state.charts.transactions.options = sharedLineOptions("Transactions");
  state.charts.price.options = sharedLineOptions("Median price", true);
  state.charts.mix.options = sharedBarOptions();
  state.charts.zip.options = sharedHorizontalBarOptions();
}

function createMapTileLayer(theme) {
  const url =
    theme === "dark"
      ? "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
      : "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";

  return L.tileLayer(url, {
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
  });
}

function syncMapTheme() {
  if (!state.mapReady || state.mapTileTheme === state.theme) {
    return;
  }

  if (state.mapTileLayer) {
    state.map.removeLayer(state.mapTileLayer);
  }
  state.mapTileLayer = createMapTileLayer(state.theme);
  state.mapTileLayer.addTo(state.map);
  state.mapTileTheme = state.theme;
  if (state.heatLayer?.bringToFront) {
    state.heatLayer.bringToFront();
  }
}

function groupBy(records, key) {
  return records.reduce((map, record) => {
    const bucket = record[key];
    if (!map.has(bucket)) {
      map.set(bucket, []);
    }
    map.get(bucket).push(record);
    return map;
  }, new Map());
}

function countBy(records, key) {
  return records.reduce((map, record) => {
    const bucket = record[key];
    map.set(bucket, (map.get(bucket) || 0) + 1);
    return map;
  }, new Map());
}

function median(values) {
  if (!values.length) {
    return 0;
  }
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)];
}

function quarterLabel(quarterKey) {
  const [year, quarter] = quarterKey.split("-Q");
  const month = Number(quarter) * 3 - 2;
  return quarterLabelFormatter.format(new Date(`${year}-${String(month).padStart(2, "0")}-01T00:00:00`));
}

function setText(selector, value) {
  document.querySelector(selector).textContent = value;
}

function installRevealAnimation() {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.16 },
  );

  for (const element of document.querySelectorAll(".reveal")) {
    observer.observe(element);
  }
}
