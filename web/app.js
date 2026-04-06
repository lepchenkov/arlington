const state = {
  records: [],
  payload: null,
  windowYears: 3,
  propertyType: "All",
  charts: {},
  map: null,
  heatLayer: null,
  mapReady: false,
  mapVisible: false,
  heatCache: new Map(),
  dateRange: {
    min: null,
    max: null,
    selection: null,
  },
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
const saleRangeSlider = document.querySelector("#sale-date-slider");
const saleRangeStart = document.querySelector("#sale-range-start");
const saleRangeEnd = document.querySelector("#sale-range-end");

let suppressSliderRender = false;

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
      saleDateText: record.saleDate,
      saleMonth: `${saleDate.getFullYear()}-${String(saleDate.getMonth() + 1).padStart(2, "0")}`,
      saleQuarter: `${saleDate.getFullYear()}-Q${Math.floor(saleDate.getMonth() / 3) + 1}`,
    };
  });

  populateMeta(payload);
  populatePropertyTypes(payload.propertyTypes);
  renderNotes(payload.notes);
  initializeCharts();
  setupSaleRange();
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
    activateWindowChip(button);
    applyWindowPreset();
  });

  propertyTypeSelect.addEventListener("change", (event) => {
    state.propertyType = event.target.value;
    render();
  });
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

  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
    attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
  }).addTo(map);

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
  const [rangeStart, rangeEnd] = getActiveDateBounds();
  if (!rangeStart || !rangeEnd) {
    return [];
  }

  const startTime = rangeStart.getTime();
  const endTime = rangeEnd.getTime();

  return state.records.filter((record) => {
    if (record.saleDate.getTime() < startTime || record.saleDate.getTime() > endTime) {
      return false;
    }
    if (state.propertyType !== "All" && record.propertyType !== state.propertyType) {
      return false;
    }
    return true;
  });
}

function getLatestDate() {
  if (state.dateRange.max) {
    return state.dateRange.max;
  }
  if (!state.records.length) {
    return null;
  }
  const latest = state.records.reduce((current, record) => {
    if (!current || record.saleDate > current) {
      return record.saleDate;
    }
    return current;
  }, null);
  if (!latest) {
    return null;
  }
  state.dateRange.max = new Date(latest.getTime());
  return state.dateRange.max;
}

function renderStats(records) {
  const count = records.length;
  const amounts = records.map((record) => record.saleAmount).sort((left, right) => left - right);
  const totalVolume = amounts.reduce((sum, value) => sum + value, 0);
  const medianValue = amounts.length ? amounts[Math.floor(amounts.length / 2)] : 0;
  const latestRecord = records[0];
  const [rangeStart, rangeEnd] = getActiveDateBounds();
  const rangeLabel = formatRangeLabel(rangeStart, rangeEnd);

  setText("#transactions-value", count.toLocaleString("en-US"));
  setText("#transactions-foot", rangeLabel ? `Transactions from ${rangeLabel}` : "Transactions");
  setText("#median-value", amounts.length ? currency.format(medianValue) : "-");
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
  const grouped = groupBy(records, "saleMonth");
  const labels = Array.from(grouped.keys()).sort();
  const values = labels.map((label) => grouped.get(label).length);
  const styles = getThemeStyles();

  updateLineChart(
    state.charts.transactions,
    labels,
    values,
    {
      borderColor: readCssVar(styles, "--chart-line-cool", "#365b74"),
      backgroundColor: readCssVar(styles, "--chart-line-cool-fill", "rgba(54, 91, 116, 0.16)"),
    },
    (label) => monthLabelFormatter.format(new Date(`${label}-01T00:00:00`)),
  );
}

function renderPriceChart(records) {
  const grouped = groupBy(records, "saleQuarter");
  const labels = Array.from(grouped.keys()).sort();
  const values = labels.map((label) => median(grouped.get(label).map((record) => record.saleAmount)));
  const styles = getThemeStyles();

  updateLineChart(
    state.charts.price,
    labels,
    values,
    {
      borderColor: readCssVar(styles, "--chart-line-warm", "#be6139"),
      backgroundColor: readCssVar(styles, "--chart-line-warm-fill", "rgba(190, 97, 57, 0.16)"),
    },
    (label) => quarterLabel(label),
  );
}

function renderMixChart(records) {
  const counts = countBy(records, "propertyType");
  const labels = Array.from(counts.keys());
  const values = labels.map((label) => counts.get(label));
  const styles = getThemeStyles();
  const colors = buildBarPalette(values.length, styles);

  state.charts.mix.data.labels = labels;
  state.charts.mix.data.datasets = [
    {
      label: "Transactions",
      data: values,
      borderRadius: 12,
      backgroundColor: colors,
    },
  ];
  state.charts.mix.update();
}

function renderZipChart(records) {
  const grouped = groupBy(records, "zipCode");
  const zips = Array.from(grouped.entries())
    .filter(([, items]) => items.length >= 12)
    .map(([zip, items]) => ({
      zip,
      median: median(items.map((item) => item.saleAmount)),
    }))
    .sort((left, right) => right.median - left.median)
    .slice(0, 7);
  const styles = getThemeStyles();
  const barColor = readCssVar(styles, "--chart-zip-bar", "#d3a14a");

  state.charts.zip.data.labels = zips.map((item) => item.zip);
  state.charts.zip.data.datasets = [
    {
      label: "Median sale price",
      data: zips.map((item) => item.median),
      borderRadius: 12,
      backgroundColor: barColor,
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
  const [rangeStart, rangeEnd] = getActiveDateBounds();
  const cacheKey = `${state.propertyType}:${rangeStart ? rangeStart.toISOString() : "na"}:${rangeEnd ? rangeEnd.toISOString() : "na"}:${records.length}`;
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
  const styles = getThemeStyles();
  const muted = readCssVar(styles, "--muted", "#597169");
  const gridColor = readCssVar(styles, "--chart-grid", "rgba(23, 48, 42, 0.08)");

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
          color: muted,
          maxTicksLimit: 8,
        },
        grid: {
          display: false,
        },
      },
      y: {
        ticks: {
          color: muted,
          callback(value) {
            return currencyAxis ? compactNumber.format(value) : value;
          },
        },
        grid: {
          color: gridColor,
        },
      },
    },
  };
}

function sharedBarOptions() {
  const styles = getThemeStyles();
  const muted = readCssVar(styles, "--muted", "#597169");
  const gridColor = readCssVar(styles, "--chart-grid", "rgba(23, 48, 42, 0.08)");

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
        ticks: { color: muted },
        grid: { display: false },
      },
      y: {
        ticks: { color: muted },
        grid: { color: gridColor },
      },
    },
  };
}

function sharedHorizontalBarOptions() {
  const styles = getThemeStyles();
  const muted = readCssVar(styles, "--muted", "#597169");
  const gridColor = readCssVar(styles, "--chart-grid", "rgba(23, 48, 42, 0.08)");

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
          color: muted,
          callback(value) {
            return compactNumber.format(value);
          },
        },
        grid: { color: gridColor },
      },
      y: {
        ticks: { color: muted },
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

function buildBarPalette(length, styles = getThemeStyles()) {
  const fallbackPalette = ["#365b74", "#be6139", "#d3a14a", "#2f7668"];
  const vars = ["--chart-bar-1", "--chart-bar-2", "--chart-bar-3", "--chart-bar-4"];
  const resolved = vars.map((name, index) => readCssVar(styles, name, fallbackPalette[index]));
  return Array.from({ length }, (_, index) => resolved[index % resolved.length]);
}

function getThemeStyles() {
  return getComputedStyle(document.documentElement);
}

function readCssVar(styles, name, fallback = "") {
  const value = styles.getPropertyValue(name).trim();
  return value || fallback;
}

function setupSaleRange() {
  if (!state.records.length) {
    return;
  }

  const minDate = getEarliestDate();
  const maxDate = getLatestDate();
  if (!minDate || !maxDate) {
    return;
  }

  const start = calculateWindowStart(minDate, maxDate);
  const end = new Date(maxDate.getTime());
  state.dateRange.selection = [start, end];
  updateRangeLabels(start, end);

  if (!saleRangeSlider || typeof window === "undefined" || !window.noUiSlider || minDate.getTime() === maxDate.getTime()) {
    return;
  }

  if (saleRangeSlider.noUiSlider) {
    saleRangeSlider.noUiSlider.destroy();
  }

  const slider = window.noUiSlider.create(saleRangeSlider, {
    start: [start.getTime(), end.getTime()],
    connect: true,
    step: 24 * 60 * 60 * 1000,
    range: {
      min: minDate.getTime(),
      max: maxDate.getTime(),
    },
    behaviour: "drag",
  });

  slider.on("update", (values) => {
    const [left, right] = values.map((value) => new Date(Number(value)));
    updateRangeLabels(left, right);
  });

  slider.on("set", (values) => {
    const [left, right] = values.map((value) => new Date(Number(value)));
    state.dateRange.selection = [left, right];
    if (suppressSliderRender) {
      suppressSliderRender = false;
      return;
    }
    clearWindowSelection();
    render();
  });
}

function activateWindowChip(activeButton) {
  for (const item of windowControls.querySelectorAll(".chip")) {
    item.classList.toggle("is-active", item === activeButton);
  }
}

function clearWindowSelection() {
  for (const item of windowControls.querySelectorAll(".chip")) {
    item.classList.remove("is-active");
  }
}

function applyWindowPreset() {
  const latest = getLatestDate();
  const minDate = getEarliestDate();
  if (!latest || !minDate) {
    return;
  }

  const start = calculateWindowStart(minDate, latest);
  const end = new Date(latest.getTime());
  state.dateRange.selection = [start, end];
  updateRangeLabels(start, end);
  setSliderRange(start, end, { suppressRender: true });
  render();
}

function setSliderRange(start, end, options = {}) {
  if (!saleRangeSlider?.noUiSlider) {
    return;
  }
  if (options.suppressRender) {
    suppressSliderRender = true;
  }
  saleRangeSlider.noUiSlider.set([start.getTime(), end.getTime()]);
}

function calculateWindowStart(minDate, maxDate) {
  const start = new Date(maxDate.getTime());
  start.setFullYear(start.getFullYear() - state.windowYears);
  if (start < minDate) {
    start.setTime(minDate.getTime());
  }
  return start;
}

function getEarliestDate() {
  if (state.dateRange.min) {
    return state.dateRange.min;
  }
  if (!state.records.length) {
    return null;
  }
  const earliest = state.records.reduce((current, record) => {
    if (!current || record.saleDate < current) {
      return record.saleDate;
    }
    return current;
  }, null);
  if (!earliest) {
    return null;
  }
  state.dateRange.min = new Date(earliest.getTime());
  return state.dateRange.min;
}

function getActiveDateBounds() {
  if (state.dateRange.selection) {
    return state.dateRange.selection;
  }
  const latest = getLatestDate();
  const earliest = getEarliestDate();
  if (!latest || !earliest) {
    return [null, null];
  }
  const start = calculateWindowStart(earliest, latest);
  const end = new Date(latest.getTime());
  state.dateRange.selection = [start, end];
  updateRangeLabels(start, end);
  return state.dateRange.selection;
}

function updateRangeLabels(start, end) {
  if (saleRangeStart && start) {
    saleRangeStart.textContent = dateFormatter.format(start);
  }
  if (saleRangeEnd && end) {
    saleRangeEnd.textContent = dateFormatter.format(end);
  }
}

function formatRangeLabel(start, end) {
  if (!start || !end) {
    return null;
  }
  return `${dateFormatter.format(start)} – ${dateFormatter.format(end)}`;
}
