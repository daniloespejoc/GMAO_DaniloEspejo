(() => {
  "use strict";

  const PALETTE = ["#247f89", "#5bb8a6", "#82c5c7", "#e0a15c", "#718dc0", "#bd7782", "#8a9d6b"];
  const TYPE_COLORS = {
    Correctivo: "#d77b69",
    Preventivo: "#50a992",
    Predictivo: "#668cbd",
    "Sin clasificar": "#99a6b2",
  };
  const MONEY = new Intl.NumberFormat("es-CL", { maximumFractionDigits: 0 });
  const DECIMAL = new Intl.NumberFormat("es-CL", { maximumFractionDigits: 1 });
  const app = {
    rows: [],
    fileName: "",
    duplicateCount: 0,
    charts: new Map(),
    loading: false,
  };

  const $ = (selector) => document.querySelector(selector);
  const normalizeHeader = (value) =>
    String(value ?? "")
      .replace(/^\uFEFF/, "")
      .trim()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");

  const FIELD_ALIASES = {
    ot: ["ot", "orden", "orden_de_trabajo", "numero_ot", "n_ot"],
    tipo: ["tipo_mantenimiento", "tipo_de_mantenimiento", "clase_mantenimiento"],
    equipo: ["equipo", "activo", "nombre_equipo"],
    tipoEquipo: ["tipo_equipo", "familia_equipo", "clase_equipo"],
    criticidad: ["criticidad", "criticidad_equipo"],
    modoFalla: ["modo_falla", "modo_de_falla", "falla"],
    estado: ["estado", "estado_ot", "status"],
    downtime: ["downtime_h", "downtime", "tiempo_indisponibilidad_h"],
    horas: ["horas_mano_obra", "horas_hombre", "hh", "mano_de_obra_h"],
    costo: ["costo_total_clp", "costo_total", "costo_directo_clp"],
    inicio: ["fecha_inicio", "fecha_inicial"],
    fin: ["fecha_fin", "fecha_termino", "fecha_cierre"],
  };

  const normalizeValue = (value) => String(value ?? "").trim().replace(/^'+/, "").trim();

  function parseNumber(value) {
    if (value == null || String(value).trim() === "") return 0;
    let text = normalizeValue(value).replace(/[\s\u00a0]/g, "").replace(/[^\d,.\-()+]/g, "");
    if (!text) return 0;
    const negative = text.startsWith("(") && text.endsWith(")");
    text = text.replace(/[()]/g, "");
    const comma = text.lastIndexOf(",");
    const dot = text.lastIndexOf(".");
    if (comma >= 0 && dot >= 0) {
      const decimalSeparator = comma > dot ? "," : ".";
      const thousandsSeparator = decimalSeparator === "," ? "." : ",";
      text = text.split(thousandsSeparator).join("");
      if (decimalSeparator === ",") text = text.replace(",", ".");
    } else if (comma >= 0) {
      const pieces = text.split(",");
      text = pieces.length === 2 ? `${pieces[0]}.${pieces[1]}` : pieces.join("");
    } else if (dot >= 0) {
      const pieces = text.split(".");
      if (pieces.length > 2 || (pieces.length === 2 && pieces[1].length === 3)) {
        text = pieces.join("");
      }
    }
    const result = Number(text);
    if (!Number.isFinite(result)) return 0;
    return negative ? -result : result;
  }

  function parseDate(value) {
    const text = normalizeValue(value);
    if (!text) return null;
    let match = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (match) {
      return new Date(Date.UTC(+match[1], +match[2] - 1, +match[3], +(match[4] || 0), +(match[5] || 0), +(match[6] || 0)));
    }
    match = text.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (match) {
      return new Date(Date.UTC(+match[3], +match[2] - 1, +match[1], +(match[4] || 0), +(match[5] || 0), +(match[6] || 0)));
    }
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function normalizeType(value) {
    const text = normalizeValue(value).toLocaleLowerCase("es").replace(/\s+/g, " ");
    if (text === "correctivo" || text === "correctiva") return "Correctivo";
    if (text === "preventivo" || text === "preventiva") return "Preventivo";
    if (text === "predictivo" || text === "predictiva") return "Predictivo";
    return normalizeValue(value) || "Sin clasificar";
  }

  function normalizeState(value) {
    const text = normalizeValue(value).toLocaleLowerCase("es").replace(/[_-]+/g, " ").replace(/\s+/g, " ");
    if (["cerrada", "cerrado", "close", "closed"].includes(text)) return "CERRADA";
    return text.toLocaleUpperCase("es");
  }

  function parseRows(inputRows, headers) {
    const normalizedHeaders = headers.map((header) => normalizeHeader(header));
    const resolved = {};
    for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
      const index = normalizedHeaders.findIndex((header) => aliases.includes(header));
      if (index >= 0) resolved[field] = headers[index];
    }
    const missing = [];
    if (!resolved.ot) missing.push("OT");
    if (!resolved.tipo) missing.push("Tipo_mantenimiento");
    if (missing.length) {
      throw new Error(`Faltan columnas requeridas: ${missing.join(", ")}. Verifica que el CSV tenga encabezados CMMS en la primera fila.`);
    }

    const seen = new Set();
    const records = [];
    let ignoredRows = 0;
    let duplicateCount = 0;
    for (const source of inputRows) {
      const rowKey = JSON.stringify(source);
      if (seen.has(rowKey)) {
        duplicateCount += 1;
        continue;
      }
      seen.add(rowKey);
      const get = (field) => normalizeValue(resolved[field] ? source[resolved[field]] : "");
      const ot = get("ot");
      if (!ot) {
        ignoredRows += 1;
        continue;
      }
      records.push({
        ot,
        tipo: normalizeType(get("tipo")),
        equipo: get("equipo") || "Sin equipo",
        tipoEquipo: get("tipoEquipo") || "Sin clasificar",
        criticidad: get("criticidad") || "Sin clasificar",
        modoFalla: get("modoFalla"),
        estado: normalizeState(get("estado")),
        downtime: parseNumber(resolved.downtime ? source[resolved.downtime] : 0),
        horas: parseNumber(resolved.horas ? source[resolved.horas] : 0),
        costo: parseNumber(resolved.costo ? source[resolved.costo] : 0),
        inicio: parseDate(resolved.inicio ? source[resolved.inicio] : ""),
        fin: parseDate(resolved.fin ? source[resolved.fin] : ""),
      });
    }
    if (!records.length) throw new Error("El archivo no contiene filas válidas con identificador OT.");
    app.duplicateCount = duplicateCount;
    app.ignoredRows = ignoredRows;
    return records;
  }

  function setLoading(isLoading, label = "Leyendo archivo…") {
    app.loading = isLoading;
    $("#file-status").innerHTML = `<span class="status-dot${isLoading ? " muted" : ""}"></span>${escapeHtml(label)}`;
    $("#file-input").disabled = isLoading;
    document.querySelectorAll(".sample-button").forEach((button) => (button.disabled = isLoading));
  }

  function showError(message) {
    const alert = $("#alert");
    alert.textContent = message;
    alert.hidden = false;
  }

  function clearError() {
    $("#alert").hidden = true;
    $("#alert").textContent = "";
  }

  async function loadFile(file) {
    if (!file || app.loading) return;
    clearError();
    if (file.size > 50 * 1024 * 1024) {
      showError("El archivo supera el límite de 50 MB. Reduce el tamaño o exporta solo los registros necesarios.");
      return;
    }
    if (!/\.csv$/i.test(file.name)) {
      showError("Carga un archivo .csv con el formato exportado desde el CMMS.");
      return;
    }
    setLoading(true);
    try {
      const text = await file.text();
      const parsed = Papa.parse(text, { header: true, skipEmptyLines: "greedy", dynamicTyping: false, delimiter: "" });
      const errors = parsed.errors.filter((error) => error.code !== "UndetectableDelimiter");
      if (errors.length) throw new Error(`No se pudo leer el CSV: ${errors[0].message} (fila ${errors[0].row ?? "?"}).`);
      app.rows = parseRows(parsed.data, parsed.meta.fields || []);
      app.fileName = file.name;
      renderDashboard();
      setLoading(false, `${file.name} · ${app.rows.length.toLocaleString("es-CL")} registros limpios`);
    } catch (error) {
      app.rows = [];
      $("#dashboard").hidden = true;
      $("#empty-state").style.display = "block";
      $("#export-pdf").disabled = true;
      setLoading(false, "No se pudo cargar el archivo");
      showError(error instanceof Error ? error.message : "Error inesperado al leer el archivo.");
    } finally {
      $("#file-input").value = "";
    }
  }

  async function loadSample(group) {
    if (app.loading) return;
    const fileName = `CMMS_grupo_${group}.csv`;
    setLoading(true, `Cargando ${fileName}…`);
    clearError();
    try {
      const response = await fetch(`../dataset/${encodeURIComponent(fileName)}`);
      if (!response.ok) throw new Error(`No se pudo descargar ${fileName} (${response.status}).`);
      const text = await response.text();
      const parsed = Papa.parse(text, { header: true, skipEmptyLines: "greedy", dynamicTyping: false, delimiter: "" });
      const errors = parsed.errors.filter((error) => error.code !== "UndetectableDelimiter");
      if (errors.length) throw new Error(`Error al leer ${fileName}: ${errors[0].message}.`);
      app.rows = parseRows(parsed.data, parsed.meta.fields || []);
      app.fileName = fileName;
      renderDashboard();
      setLoading(false, `${fileName} · ${app.rows.length.toLocaleString("es-CL")} registros limpios`);
    } catch (error) {
      setLoading(false, "No se pudo cargar el ejemplo");
      showError(`${error instanceof Error ? error.message : "Error inesperado."} Puedes cargar el CSV manualmente.`);
    }
  }

  function getFilteredRows() {
    const type = $("#filter-maintenance").value;
    const criticality = $("#filter-criticality").value;
    return app.rows.filter((row) => (!type || row.tipo === type) && (!criticality || row.criticidad === criticality));
  }

  function sum(rows, field) {
    return rows.reduce((total, row) => total + (Number.isFinite(row[field]) ? row[field] : 0), 0);
  }

  function groupRows(rows, keyFunction) {
    const groups = new Map();
    for (const row of rows) {
      const key = keyFunction(row) || "Sin clasificar";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    return groups;
  }

  function uniqueCount(rows, field = "ot") {
    return new Set(rows.map((row) => row[field]).filter(Boolean)).size;
  }

  function getRepairRows(rows) {
    return rows.filter((row) => {
      const elapsed = row.inicio && row.fin ? (row.fin - row.inicio) / 3600000 : 0;
      return row.tipo === "Correctivo" && row.estado === "CERRADA" && elapsed > 0;
    }).map((row) => ({ ...row, reparacion: (row.fin - row.inicio) / 3600000 }));
  }

  function calculateMetrics(rows) {
    const types = [...groupRows(rows, (row) => row.tipo)].map(([type, group]) => ({
      type,
      ot: uniqueCount(group),
      hh: sum(group, "horas"),
      downtime: sum(group, "downtime"),
      cost: sum(group, "costo"),
    }));
    const totalOt = uniqueCount(rows);
    const totalHH = sum(rows, "horas");
    const totalDowntime = sum(rows, "downtime");
    const totalCost = sum(rows, "costo");
    const repairRows = getRepairRows(rows);
    const repairs = repairRows.map((row) => row.reparacion).sort((a, b) => a - b);
    const meanRepair = repairs.length ? repairs.reduce((a, b) => a + b, 0) / repairs.length : 0;
    const medianRepair = repairs.length
      ? repairs.length % 2
        ? repairs[(repairs.length - 1) / 2]
        : (repairs[repairs.length / 2 - 1] + repairs[repairs.length / 2]) / 2
      : 0;
    const corrective = types.find((item) => item.type === "Correctivo") || { ot: 0, hh: 0, downtime: 0, cost: 0 };
    const pct = (value, total) => (total > 0 ? (value / total) * 100 : 0);
    return {
      types,
      totalOt,
      totalHH,
      totalDowntime,
      totalCost,
      repairRows,
      meanRepair,
      medianRepair,
      corrective: {
        ...corrective,
        pctOt: pct(corrective.ot, totalOt),
        pctHH: pct(corrective.hh, totalHH),
        pctDowntime: pct(corrective.downtime, totalDowntime),
        pctCost: pct(corrective.cost, totalCost),
      },
    };
  }

  function calculatePareto(rows, field, metricField) {
    const failures = rows.filter((row) => row.tipo === "Correctivo" && row.modoFalla);
    const groups = [...groupRows(failures, (row) => row.modoFalla)].map(([name, group]) => ({
      name,
      events: uniqueCount(group),
      downtime: sum(group, "downtime"),
      cost: sum(group, "costo"),
    }));
    groups.sort((a, b) => b[metricField] - a[metricField]);
    const total = groups.reduce((value, item) => value + item[metricField], 0);
    let cumulative = 0;
    return groups.slice(0, 10).map((item) => {
      cumulative += total > 0 ? (item[metricField] / total) * 100 : 0;
      return { ...item, cumulative };
    });
  }

  function calculateJackknife(rows, keyFunction) {
    const repairs = getRepairRows(rows);
    const groups = [...groupRows(repairs, keyFunction)].map(([name, group]) => {
      const eventCount = uniqueCount(group);
      const downtime = sum(group, "downtime");
      return {
        name,
        eventCount,
        downtime,
        mttr: eventCount ? downtime / eventCount : 0,
        type: group[0]?.tipoEquipo || "Sin clasificar",
        criticality: group[0]?.criticidad || "Sin clasificar",
      };
    }).filter((group) => group.eventCount > 0 && group.mttr > 0);
    if (!groups.length) return { groups: [], xLimit: 0, yLimit: 0 };
    const xLimit = groups.reduce((total, item) => total + item.eventCount, 0) / groups.length;
    const totalEvents = groups.reduce((total, item) => total + item.eventCount, 0);
    const yLimit = groups.reduce((total, item) => total + item.downtime, 0) / totalEvents;
    for (const item of groups) {
      item.x = item.eventCount / xLimit;
      item.y = item.mttr / yLimit;
      item.risk = item.x * item.y;
      item.quadrant = item.x < 1
        ? item.y < 1 ? "Bajo control" : "Agudo"
        : item.y < 1 ? "Crónico" : "Grave";
    }
    groups.sort((a, b) => b.risk - a.risk);
    return { groups, xLimit, yLimit };
  }

  function formatDate(date) {
    if (!date) return "";
    return new Intl.DateTimeFormat("es-CL", { year: "numeric", month: "short", day: "2-digit", timeZone: "UTC" }).format(date);
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[char]);
  }

  function fillFilters() {
    const maintenance = $("#filter-maintenance");
    const criticality = $("#filter-criticality");
    const currentType = maintenance.value;
    const currentCriticality = criticality.value;
    const types = [...new Set(app.rows.map((row) => row.tipo))].sort();
    const criticalities = [...new Set(app.rows.map((row) => row.criticidad).filter((value) => value !== "Sin clasificar"))].sort();
    maintenance.innerHTML = '<option value="">Todos los tipos</option>' + types.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("");
    criticality.innerHTML = '<option value="">Todas</option>' + criticalities.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("");
    if (types.includes(currentType)) maintenance.value = currentType;
    if (criticalities.includes(currentCriticality)) criticality.value = currentCriticality;
  }

  function renderDashboard() {
    $("#dashboard").hidden = false;
    $("#empty-state").style.display = "none";
    $("#export-pdf").disabled = false;
    $("#breadcrumb-dataset").textContent = app.fileName;
    fillFilters();
    renderFilteredDashboard();
  }

  function renderFilteredDashboard() {
    const rows = getFilteredRows();
    const metrics = calculateMetrics(rows);
    const dates = rows.flatMap((row) => [row.inicio, row.fin]).filter(Boolean).sort((a, b) => a - b);
    $("#dataset-meta").textContent = `${app.rows.length.toLocaleString("es-CL")} registros limpios · ${app.duplicateCount.toLocaleString("es-CL")} duplicados exactos eliminados · análisis sobre ${rows.length.toLocaleString("es-CL")} registros filtrados`;
    $("#period-label").textContent = dates.length ? `${formatDate(dates[0])} — ${formatDate(dates[dates.length - 1])}` : "Periodo sin fechas disponibles";
    $("#filter-count").textContent = `${uniqueCount(rows).toLocaleString("es-CL")} OT`;
    renderKpis(metrics);
    renderInsight(metrics);
    renderCharts(rows, metrics);
    renderRiskTable(calculateJackknife(rows, (row) => row.equipo).groups);
  }

  function renderKpis(metrics) {
    const kpis = [
      { label: "Órdenes de trabajo", value: metrics.totalOt.toLocaleString("es-CL"), caption: "OT únicas", icon: "▤", color: "#248b91", tint: "#e8f6f3" },
      { label: "Horas-hombre", value: DECIMAL.format(metrics.totalHH), caption: "Horas de mano de obra", icon: "◷", color: "#5287b7", tint: "#edf3fb" },
      { label: "Downtime total", value: `${DECIMAL.format(metrics.totalDowntime)} h`, caption: "Indisponibilidad acumulada", icon: "⌁", color: "#cf8758", tint: "#fcf2e9" },
      { label: "Costo directo", value: `$${MONEY.format(metrics.totalCost)}`, caption: "CLP · repuestos + externos", icon: "$", color: "#9574b8", tint: "#f4eff9" },
      { label: "MTTR correctivo", value: `${DECIMAL.format(metrics.meanRepair)} h`, caption: `${metrics.repairRows.length.toLocaleString("es-CL")} reparaciones válidas`, icon: "↻", color: "#428e82", tint: "#e8f5f1" },
      { label: "Mediana reparación", value: `${DECIMAL.format(metrics.medianRepair)} h`, caption: "Mitad de reparaciones bajo este tiempo", icon: "⌁", color: "#697e9b", tint: "#eef2f7" },
    ];
    $("#kpi-grid").innerHTML = kpis.map((kpi) => `
      <article class="kpi-card" style="--kpi-color:${kpi.color};--kpi-tint:${kpi.tint}">
        <div class="kpi-top"><span>${kpi.label}</span><span class="kpi-icon">${kpi.icon}</span></div>
        <strong class="kpi-value" title="${escapeHtml(kpi.value)}">${escapeHtml(kpi.value)}</strong>
        <span class="kpi-caption">${kpi.caption}</span>
      </article>`).join("");
  }

  function renderInsight(metrics) {
    const c = metrics.corrective;
    $("#insight-text").textContent = c.ot
      ? `El mantenimiento correctivo representa el ${DECIMAL.format(c.pctOt)} % de las órdenes, consume ${DECIMAL.format(c.pctHH)} % de las horas-hombre, genera ${DECIMAL.format(c.pctDowntime)} % del downtime y concentra ${DECIMAL.format(c.pctCost)} % del costo directo.`
      : "No se encontraron OT correctivas en la selección actual. Revisa los filtros o el tipo de mantenimiento registrado en el archivo.";
  }

  const tooltipConfig = {
    backgroundColor: "#102a43",
    titleFont: { family: "DM Sans", size: 11, weight: "700" },
    bodyFont: { family: "DM Sans", size: 10 },
    padding: 10,
    cornerRadius: 7,
    displayColors: true,
  };
  const axisFont = { family: "DM Sans", size: 9 };
  const gridColor = "#edf1f3";

  function baseOptions(extra = {}) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 350 },
      plugins: {
        legend: { position: "bottom", labels: { usePointStyle: true, pointStyle: "circle", boxWidth: 7, boxHeight: 7, padding: 17, color: "#728494", font: axisFont } },
        tooltip: tooltipConfig,
      },
      ...extra,
    };
  }

  function destroyCharts() {
    for (const chart of app.charts.values()) chart.destroy();
    app.charts.clear();
  }

  function drawChart(id, config) {
    const canvas = document.getElementById(id);
    if (!canvas || !window.Chart) return;
    const chart = new window.Chart(canvas, config);
    app.charts.set(id, chart);
  }

  function typeColor(type, index) {
    return TYPE_COLORS[type] || PALETTE[index % PALETTE.length];
  }

  function renderCharts(rows, metrics) {
    destroyCharts();
    const types = metrics.types;
    drawChart("chart-mix", {
      type: "bar",
      data: {
        labels: types.map((item) => item.type),
        datasets: [
          { label: "% OT", data: types.map((item) => metrics.totalOt ? item.ot / metrics.totalOt * 100 : 0), backgroundColor: "#267e89", borderRadius: 5, maxBarThickness: 46 },
          { label: "% Horas-hombre", data: types.map((item) => metrics.totalHH ? item.hh / metrics.totalHH * 100 : 0), backgroundColor: "#72c6b1", borderRadius: 5, maxBarThickness: 46 },
        ],
      },
      options: baseOptions({ scales: {
        x: { grid: { display: false }, ticks: { color: "#718392", font: axisFont } },
        y: { beginAtZero: true, max: 100, grid: { color: gridColor }, ticks: { color: "#91a0aa", font: axisFont, callback: (value) => `${value}%` } },
      } }),
    });

    const horizontal = (items, label, values, color, formatter) => ({
      type: "bar",
      data: {
        labels: items.map((item) => item.label),
        datasets: [{ label, data: items.map(values), backgroundColor: items.map((_, i) => PALETTE[i % PALETTE.length]), borderRadius: 5, maxBarThickness: 30 }],
      },
      options: baseOptions({ indexAxis: "y", plugins: { ...baseOptions().plugins, legend: { display: false }, tooltip: { ...tooltipConfig, callbacks: { label: (ctx) => ` ${formatter(ctx.raw)}` } } }, scales: {
        x: { beginAtZero: true, grid: { color: gridColor }, ticks: { color: "#91a0aa", font: axisFont, callback: formatter } },
        y: { grid: { display: false }, ticks: { color: "#647a8b", font: { ...axisFont, size: 8 } } },
      } }),
    });

    const downtimeTypes = [...types].sort((a, b) => b.downtime - a.downtime).map((item) => ({ label: item.type, value: item.downtime }));
    const costTypes = [...types].sort((a, b) => b.cost - a.cost).map((item) => ({ label: item.type, value: item.cost / 1e6 }));
    drawChart("chart-downtime-type", horizontal(downtimeTypes, "Downtime [h]", (item) => item.value, null, (value) => `${DECIMAL.format(value)} h`));
    drawChart("chart-cost-type", horizontal(costTypes, "Costo [MCLP]", (item) => item.value, null, (value) => `${DECIMAL.format(value)} M`));

    const topEquipment = [...groupRows(rows, (row) => row.equipo)]
      .map(([label, group]) => ({ label, value: sum(group, "downtime") }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 10)
      .reverse();
    drawChart("chart-equipment", horizontal(topEquipment, "Downtime [h]", (item) => item.value, null, (value) => `${DECIMAL.format(value)} h`));

    const byFamily = [...groupRows(getRepairRows(rows), (row) => row.tipoEquipo)]
      .map(([label, group]) => ({ label, value: group.reduce((total, row) => total + row.reparacion, 0) / group.length, count: group.length }))
      .filter((item) => item.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, 12)
      .reverse();
    drawChart("chart-mttr", horizontal(byFamily, "MTTR [h]", (item) => item.value, null, (value) => `${DECIMAL.format(value)} h`));

    const pareto = calculatePareto(rows, "N_eventos", "events");
    drawChart("chart-pareto", {
      type: "bar",
      data: {
        labels: pareto.map((item) => item.name),
        datasets: [
          { type: "bar", label: "Eventos", data: pareto.map((item) => item.events), backgroundColor: "#398c91", borderRadius: 4, maxBarThickness: 28, yAxisID: "y" },
          { type: "line", label: "% acumulado", data: pareto.map((item) => item.cumulative), borderColor: "#e1a460", backgroundColor: "#e1a460", pointRadius: 2, borderWidth: 2, tension: .25, yAxisID: "y1" },
        ],
      },
      options: baseOptions({ indexAxis: "y", scales: {
        x: { beginAtZero: true, grid: { color: gridColor }, ticks: { color: "#91a0aa", font: axisFont, precision: 0 } },
        y: { grid: { display: false }, ticks: { color: "#647a8b", font: { ...axisFont, size: 8 } } },
        y1: { position: "top", min: 0, max: 100, grid: { display: false }, ticks: { color: "#cc9258", font: axisFont, callback: (value) => `${value}%` } },
      } }),
    });

    const jackknife = calculateJackknife(rows, (row) => row.equipo);
    const quadrantColor = { Grave: "#d16861", Agudo: "#dd9b50", Crónico: "#6a90bc", "Bajo control": "#44a58e" };
    const referenceLines = {
      id: "jackknifeReference",
      beforeDatasetsDraw(chart) {
        const { ctx, scales: { x, y } } = chart;
        if (!x || !y || x.min >= 1 || x.max <= 1 || y.min >= 1 || y.max <= 1) return;
        ctx.save();
        ctx.strokeStyle = "#adbbc2";
        ctx.lineWidth = 1;
        ctx.setLineDash([5, 5]);
        ctx.beginPath(); ctx.moveTo(x.getPixelForValue(1), y.top); ctx.lineTo(x.getPixelForValue(1), y.bottom); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x.left, y.getPixelForValue(1)); ctx.lineTo(x.right, y.getPixelForValue(1)); ctx.stroke();
        ctx.restore();
      },
    };
    drawChart("chart-jackknife", {
      type: "scatter",
      plugins: [referenceLines],
      data: {
        datasets: [...new Set(jackknife.groups.map((item) => item.quadrant))].map((quadrant) => ({
          label: quadrant,
          data: jackknife.groups.filter((item) => item.quadrant === quadrant).map((item) => ({ x: item.x, y: item.y, asset: item.name, events: item.eventCount, mttr: item.mttr, downtime: item.downtime, risk: item.risk })),
          backgroundColor: `${quadrantColor[quadrant]}cc`,
          pointRadius: 5,
          pointHoverRadius: 7,
        })),
      },
      options: baseOptions({
        plugins: { ...baseOptions().plugins, tooltip: { ...tooltipConfig, callbacks: { label: (ctx) => {
          const point = ctx.raw;
          return [` ${point.asset}`, ` Frecuencia*: ${DECIMAL.format(point.x)} · MTTR*: ${DECIMAL.format(point.y)}`, ` Fallas: ${point.events} · R*: ${DECIMAL.format(point.risk)}`];
        } } } },
        scales: {
          x: { type: "logarithmic", min: .1, max: Math.max(2, ...jackknife.groups.map((item) => item.x * 1.15)), title: { display: true, text: "Frecuencia normalizada N*", color: "#708391", font: axisFont }, grid: { color: gridColor }, ticks: { color: "#91a0aa", font: axisFont } },
          y: { type: "logarithmic", min: .1, max: Math.max(2, ...jackknife.groups.map((item) => item.y * 1.15)), title: { display: true, text: "Downtime / fallas normalizado MTTR*", color: "#708391", font: axisFont }, grid: { color: gridColor }, ticks: { color: "#91a0aa", font: axisFont } },
        },
      }),
    });
  }

  function renderRiskTable(groups) {
    const rows = groups.slice(0, 15);
    const tbody = $("#risk-table");
    if (!rows.length) {
      tbody.innerHTML = '<tr><td class="empty-row" colspan="8">No hay reparaciones correctivas cerradas con fechas válidas en la selección actual.</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map((item) => {
      const badgeClass = `badge-${normalizeHeader(item.quadrant)}`;
      return `<tr>
        <td class="asset-name">${escapeHtml(item.name)}</td>
        <td>${escapeHtml(item.type)}</td>
        <td>${escapeHtml(item.criticality)}</td>
        <td>${item.eventCount.toLocaleString("es-CL")}</td>
        <td>${DECIMAL.format(item.mttr)}</td>
        <td>${DECIMAL.format(item.downtime)}</td>
        <td class="risk-value">${DECIMAL.format(item.risk)}</td>
        <td><span class="badge ${badgeClass}">${escapeHtml(item.quadrant)}</span></td>
      </tr>`;
    }).join("");
  }

  function addPdfHeader(doc, page, title) {
    const width = doc.internal.pageSize.getWidth();
    doc.setFillColor(16, 42, 67);
    doc.rect(0, 0, width, 19, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.text("GMAO  /  MAINTENANCE INTELLIGENCE", 15, 12);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.text(title, width - 15, 12, { align: "right" });
    doc.setTextColor(91, 112, 129);
    doc.setFontSize(8);
    doc.text("Informe generado localmente · " + new Intl.DateTimeFormat("es-CL", { dateStyle: "long" }).format(new Date()), 15, 287);
    doc.text(String(page), width - 15, 287, { align: "right" });
  }

  function ensurePdfLibrary() {
    if (!window.jspdf?.jsPDF) throw new Error("No se cargó jsPDF. Verifica tu conexión a internet e inténtalo de nuevo.");
    if (!window.Chart || !window.Papa) throw new Error("Faltan dependencias del panel. Recarga la página e inténtalo de nuevo.");
  }

  async function exportPdf() {
    if (!app.rows.length || app.loading) return;
    clearError();
    const button = $("#export-pdf");
    button.disabled = true;
    button.innerHTML = "<span>…</span> Preparando informe";
    try {
      ensurePdfLibrary();
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4", compress: true });
      const rows = getFilteredRows();
      const metrics = calculateMetrics(rows);
      const width = doc.internal.pageSize.getWidth();
      const margin = 15;

      addPdfHeader(doc, 1, "Resumen ejecutivo");
      doc.setTextColor(34, 125, 132);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(9);
      doc.text("GESTIÓN DE ACTIVOS Y CONFIABILIDAD", margin, 32);
      doc.setTextColor(16, 42, 67);
      doc.setFontSize(24);
      doc.text("Informe Ejecutivo de", margin, 46);
      doc.text("Gestión de Mantenimiento", margin, 57);
      doc.setTextColor(99, 119, 134);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(10);
      doc.text(`Dataset: ${app.fileName}`, margin, 66);
      doc.text(`OT únicas: ${metrics.totalOt.toLocaleString("es-CL")}   ·   Registros analizados: ${rows.length.toLocaleString("es-CL")}`, margin, 72);

      const cards = [
        ["ÓRDENES DE TRABAJO", metrics.totalOt.toLocaleString("es-CL")],
        ["HORAS-HOMBRE", `${DECIMAL.format(metrics.totalHH)} h`],
        ["DOWNTIME TOTAL", `${DECIMAL.format(metrics.totalDowntime)} h`],
        ["COSTO DIRECTO", `$${MONEY.format(metrics.totalCost)} CLP`],
        ["MTTR CORRECTIVO", `${DECIMAL.format(metrics.meanRepair)} h`],
        ["MEDIANA REPARACIÓN", `${DECIMAL.format(metrics.medianRepair)} h`],
      ];
      const cardGap = 4;
      const cardW = (width - margin * 2 - cardGap * 2) / 3;
      cards.forEach(([label, value], index) => {
        const x = margin + (index % 3) * (cardW + cardGap);
        const y = 82 + Math.floor(index / 3) * 23;
        doc.setFillColor(246, 249, 250);
        doc.setDrawColor(223, 232, 236);
        doc.roundedRect(x, y, cardW, 19, 2, 2, "FD");
        doc.setTextColor(111, 132, 147);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(6.5);
        doc.text(label, x + 4, y + 6);
        doc.setTextColor(16, 55, 77);
        doc.setFontSize(value.length > 19 ? 10 : 13);
        doc.text(value, x + 4, y + 14);
      });

      const c = metrics.corrective;
      doc.setFillColor(235, 248, 244);
      doc.roundedRect(margin, 132, width - margin * 2, 22, 2, 2, "F");
      doc.setTextColor(31, 113, 98);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8);
      doc.text("HALLAZGO CLAVE DEL DIAGNÓSTICO", margin + 5, 139);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      const finding = `El mantenimiento correctivo representa ${DECIMAL.format(c.pctOt)} % de las OT, ${DECIMAL.format(c.pctHH)} % de las horas-hombre, ${DECIMAL.format(c.pctDowntime)} % del downtime y ${DECIMAL.format(c.pctCost)} % del costo directo.`;
      doc.text(doc.splitTextToSize(finding, width - margin * 2 - 10), margin + 5, 145);

      doc.setTextColor(16, 42, 67);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(12);
      doc.text("Distribución del mantenimiento", margin, 165);
      const mixRows = metrics.types.map((item) => [
        item.type,
        `${DECIMAL.format(metrics.totalOt ? item.ot / metrics.totalOt * 100 : 0)} %`,
        `${DECIMAL.format(metrics.totalHH ? item.hh / metrics.totalHH * 100 : 0)} %`,
        `${DECIMAL.format(metrics.totalDowntime ? item.downtime / metrics.totalDowntime * 100 : 0)} %`,
        `${DECIMAL.format(metrics.totalCost ? item.cost / metrics.totalCost * 100 : 0)} %`,
      ]);
      doc.autoTable({
        startY: 169,
        head: [["Tipo", "% OT", "% HH", "% Downtime", "% Costo"]],
        body: mixRows,
        theme: "striped",
        headStyles: { fillColor: [23, 69, 91], fontSize: 8 },
        bodyStyles: { fontSize: 8, textColor: [68, 91, 107] },
        alternateRowStyles: { fillColor: [246, 249, 250] },
        margin: { left: margin, right: margin },
      });

      const chartPages = [
        [["chart-mix", "Órdenes y esfuerzo por estrategia"], ["chart-downtime-type", "Downtime por estrategia"]],
        [["chart-cost-type", "Costo directo por estrategia"], ["chart-equipment", "Equipos con mayor downtime"]],
        [["chart-mttr", "MTTR correctivo por familia de equipo"], ["chart-pareto", "Pareto de modos de falla por frecuencia"]],
        [["chart-jackknife", "Jack-Knife normalizado por equipo"]],
      ];
      let page = 2;
      for (const charts of chartPages) {
        doc.addPage();
        addPdfHeader(doc, page, page < 4 ? "Desempeño y fallas" : "Priorización técnica");
        let y = 32;
        for (const [chartId, title] of charts) {
          const canvas = document.getElementById(chartId);
          if (!canvas || !app.charts.has(chartId)) continue;
          if (charts.length === 1) y = 44;
          doc.setTextColor(16, 42, 67);
          doc.setFont("helvetica", "bold");
          doc.setFontSize(11);
          doc.text(title, margin, y);
          const image = canvas.toDataURL("image/png", 1);
          const imageW = width - margin * 2;
          const imageH = charts.length === 1 ? 150 : 103;
          doc.addImage(image, "PNG", margin, y + 4, imageW, imageH, undefined, "FAST");
          y += imageH + 15;
        }
        if (page === 5) {
          const risk = calculateJackknife(rows, (row) => row.equipo).groups.slice(0, 12);
          doc.setTextColor(16, 42, 67);
          doc.setFont("helvetica", "bold");
          doc.setFontSize(11);
          doc.text("Activos prioritarios", margin, 215);
          doc.autoTable({
            startY: 219,
            head: [["Equipo", "Criticidad", "Fallas", "MTTR [h]", "Downtime [h]", "R*", "Cuadrante"]],
            body: risk.map((item) => [item.name, item.criticality, item.eventCount, DECIMAL.format(item.mttr), DECIMAL.format(item.downtime), DECIMAL.format(item.risk), item.quadrant]),
            theme: "striped",
            headStyles: { fillColor: [23, 69, 91], fontSize: 7 },
            bodyStyles: { fontSize: 7, textColor: [68, 91, 107] },
            margin: { left: margin, right: margin },
          });
        }
        page += 1;
      }

      const safeName = app.fileName.replace(/\.[^.]+$/, "").replace(/[^a-z0-9_-]+/gi, "_");
      doc.save(`Informe_Mantenimiento_${safeName}.pdf`);
    } catch (error) {
      showError(error instanceof Error ? error.message : "No se pudo generar el informe PDF.");
    } finally {
      button.disabled = false;
      button.innerHTML = "<span aria-hidden=\"true\">↧</span> Exportar informe PDF";
    }
  }

  function setupEvents() {
    $("#file-input").addEventListener("change", (event) => loadFile(event.target.files?.[0]));
    document.querySelectorAll(".sample-button").forEach((button) => {
      button.addEventListener("click", () => loadSample(button.dataset.group));
    });
    $("#filter-maintenance").addEventListener("change", renderFilteredDashboard);
    $("#filter-criticality").addEventListener("change", renderFilteredDashboard);
    $("#clear-filters").addEventListener("click", () => {
      $("#filter-maintenance").value = "";
      $("#filter-criticality").value = "";
      renderFilteredDashboard();
    });
    $("#export-pdf").addEventListener("click", exportPdf);
    const dropZone = $("#drop-zone");
    dropZone.addEventListener("dragover", (event) => {
      event.preventDefault();
      dropZone.classList.add("drag-over");
    });
    dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));
    dropZone.addEventListener("drop", (event) => {
      event.preventDefault();
      dropZone.classList.remove("drag-over");
      loadFile(event.dataTransfer?.files?.[0]);
    });
    dropZone.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        $("#file-input").click();
      }
    });
  }

  setupEvents();
})();
