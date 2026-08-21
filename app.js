/* hauction — app.js
 * Plain JS, no build step, no ES modules.
 * Depends on: Leaflet 1.9.x, Leaflet.markercluster 1.5.x (loaded via CDN).
 *
 * Multi-currency note: adding a non-EUR source requires no changes here —
 * each auction record carries a `currency` field that flows from the scraper
 * through auctions.json to the frontend.  Add new currencies to CURRENCY_SYMBOLS.
 */

(function () {
  'use strict';

  // ── Constants ───────────────────────────────────────────────────────────────
  var STORAGE_KEY      = 'hauction_map_view';
  var DEFAULT_VIEW     = { lat: 50, lng: 10, zoom: 6 };
  var NEW_THRESHOLD_MS = 48 * 60 * 60 * 1000;

  // Guard: prevents popup-driven hash writes from re-triggering the hashchange
  // listener and causing recursive re-centering.
  var suppressHashChange = false;

  // ── Category display labels ─────────────────────────────────────────────────
  var CATEGORY_LABELS = {
    house:      'Haus',
    apartment:  'Wohnung',
    land:       'Grundstück',
    commercial: 'Gewerbe',
    garage:     'Garage',
    other:      'Sonstiges',
  };

  // ── Category colours (used by circleMarker and the legend) ──────────────────
  var CATEGORY_COLORS = {
    house:      '#e74c3c',  // red
    apartment:  '#3498db',  // blue
    land:       '#27ae60',  // green
    commercial: '#f39c12',  // orange
    garage:     '#9b59b6',  // purple
    other:      '#95a5a6',  // gray
  };

  function categoryColor(cat) {
    return CATEGORY_COLORS[cat] || '#95a5a6';
  }

  function categoryLabel(cat) {
    return CATEGORY_LABELS[cat] || (cat ? cat.charAt(0).toUpperCase() + cat.slice(1) : 'Unbekannt');
  }

  // ── Currency symbols ────────────────────────────────────────────────────────
  var CURRENCY_SYMBOLS = {
    EUR: '€',
    USD: '$',
    GBP: '£',
  };

  function fmtPrice(value, currency) {
    if (value == null) return '—';
    var sym = CURRENCY_SYMBOLS[currency] || (currency || '');
    var formatted = new Intl.NumberFormat('de-DE', {
      maximumFractionDigits: 0,
    }).format(value);
    return formatted + '\u00a0' + sym;
  }

  // ── HTML escaping ───────────────────────────────────────────────────────────
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g,  '&amp;')
      .replace(/</g,  '&lt;')
      .replace(/>/g,  '&gt;')
      .replace(/"/g,  '&quot;');
  }

  // ── Date helpers ────────────────────────────────────────────────────────────
  function isNew(publishedOn) {
    if (!publishedOn) return false;
    return (Date.now() - new Date(publishedOn).getTime()) < NEW_THRESHOLD_MS;
  }

  function fmtDate(dateStr) {
    if (!dateStr) return '—';
    var parts = dateStr.slice(0, 10).split('-');
    if (parts.length === 3) {
      return parts[2] + '.' + parts[1] + '.' + parts[0];
    }
    return dateStr.slice(0, 10);
  }

  // ── Popup HTML builder ──────────────────────────────────────────────────────
  function buildPopupHtml(auction) {
    var newBadge = isNew(auction.published_on)
      ? '<span class="badge-new">NEU</span>'
      : '';

    var catColor = categoryColor(auction.category);
    var catBadge = auction.category
      ? '<span class="badge-category" style="background:' + catColor + '20;color:' + catColor + ';">'
          + escapeHtml(categoryLabel(auction.category))
          + '</span>'
      : '';

    var desc = '';
    if (auction.description) {
      var truncated = auction.description.length > 300
        ? auction.description.slice(0, 300) + '…'
        : auction.description;
      desc = '<div class="detail-row description">'
           + escapeHtml(truncated)
           + '</div>';
    }

    return '<div class="auction-popup">'
      + '<h3>' + escapeHtml(auction.title || '—') + '</h3>'
      + catBadge
      + '<div class="detail-row price">' + fmtPrice(auction.price, auction.currency) + '</div>'
      + '<div class="detail-row">'
      +   '<span class="detail-label">Adresse</span>'
      +   escapeHtml(auction.address || '—')
      + '</div>'
      + '<div class="detail-row">'
      +   '<span class="detail-label">Versteigerungstermin</span>'
      +   fmtDate(auction.auction_date) + newBadge
      + '</div>'
      + desc
      + (auction.url
        ? '<a class="auction-link" href="' + escapeHtml(auction.url) + '" target="_blank" rel="noopener noreferrer">Auktion ansehen ↗</a>'
        : '')
      + '</div>';
  }

  // ── localStorage view persistence ───────────────────────────────────────────
  function saveView(map) {
    try {
      var c = map.getCenter();
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        lat:  c.lat,
        lng:  c.lng,
        zoom: map.getZoom(),
      }));
    } catch (_) { /* storage unavailable */ }
  }

  function loadSavedView() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var v = JSON.parse(raw);
      if (typeof v.lat === 'number' && typeof v.lng === 'number' && typeof v.zoom === 'number') {
        return v;
      }
    } catch (_) { /* ignore */ }
    return null;
  }

  // ── Status bar ──────────────────────────────────────────────────────────────
  function setStatus(msg) {
    var el = document.getElementById('status');
    if (el) el.textContent = msg;
  }

  function setCount(visible, total) {
    var el = document.getElementById('filter-count');
    if (el) el.textContent = visible + ' von ' + total + ' Auktionen';
  }

  // ── Map initialisation ──────────────────────────────────────────────────────
  var savedView = loadSavedView();
  var initView  = savedView || DEFAULT_VIEW;

  var map = L.map('map', {
    center: [initView.lat, initView.lng],
    zoom:   initView.zoom,
  });

  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom:     19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  map.on('moveend', function () { saveView(map); });

  // ── Deep-link handler ───────────────────────────────────────────────────────
  function handleDeepLink(clusterGroup, markerMap) {
    var hash = window.location.hash;
    if (!hash.startsWith('#auction=')) return;

    var encoded = hash.slice('#auction='.length);
    if (!encoded) return;

    var auctionId;
    try {
      auctionId = decodeURIComponent(encoded);
    } catch (_) {
      return;
    }

    if (!markerMap.has(auctionId)) return;

    var marker = markerMap.get(auctionId);
    clusterGroup.zoomToShowLayer(marker, function () {
      marker.openPopup();
    });
  }

  // ── Shared render state (needed by applyFilters) ────────────────────────────
  var allAuctions   = [];       // full dataset
  var allMarkerPairs = [];      // [{auction, marker}, …] — all markers (even filtered out)
  var clusterGroup  = null;
  var markerMap     = new Map(); // id → marker

  // ── Create a single circleMarker for an auction ─────────────────────────────
  function createMarker(auction) {
    var color  = categoryColor(auction.category);
    var marker = L.circleMarker([auction.lat, auction.lon], {
      radius:      8,
      fillColor:   color,
      color:       '#ffffff',
      weight:      2,
      opacity:     1,
      fillOpacity: 0.8,
      auctionId:   auction.id,
    });
    marker.bindPopup(buildPopupHtml(auction), { maxWidth: 320 });
    return marker;
  }

  // ── Filter logic ────────────────────────────────────────────────────────────
  function applyFilters() {
    // Read category selection
    var catCheckboxes = document.querySelectorAll('input[name="category"]');
    var selectedCats  = new Set();
    catCheckboxes.forEach(function (cb) {
      if (cb.checked) selectedCats.add(cb.value);
    });

    // Read numeric constraints (empty string → no constraint)
    var maxPriceEl   = document.getElementById('filter-max-price');
    var maxWaterEl   = document.getElementById('filter-max-water');
    var maxAirportEl = document.getElementById('filter-max-airport');

    var maxPrice   = maxPriceEl   && maxPriceEl.value   !== '' ? parseFloat(maxPriceEl.value)   : null;
    var maxWater   = maxWaterEl   && maxWaterEl.value   !== '' ? parseFloat(maxWaterEl.value)   : null;
    var maxAirport = maxAirportEl && maxAirportEl.value !== '' ? parseFloat(maxAirportEl.value) : null;

    if (!clusterGroup) return;

    clusterGroup.clearLayers();

    var visible = 0;
    allMarkerPairs.forEach(function (pair) {
      var a = pair.auction;
      var m = pair.marker;

      // Category filter — unknown category counts as 'other'
      var cat = a.category || 'other';
      if (!selectedCats.has(cat)) return;

      // Price filter — null price passes (no data = no exclusion)
      if (maxPrice !== null && a.price != null && a.price > maxPrice) return;

      // Water distance filter — null distance fails when filter is set
      if (maxWater !== null) {
        if (a.water_distance_km == null || a.water_distance_km > maxWater) return;
      }

      // Airport distance filter — null distance fails when filter is set
      if (maxAirport !== null) {
        if (a.airport_distance_km == null || a.airport_distance_km > maxAirport) return;
      }

      clusterGroup.addLayer(m);
      visible++;
    });

    setCount(visible, allAuctions.length);
  }

  // ── Attach filter events ────────────────────────────────────────────────────
  function attachFilterEvents() {
    document.querySelectorAll('input[name="category"]').forEach(function (cb) {
      cb.addEventListener('change', applyFilters);
    });
    ['filter-max-price', 'filter-max-water', 'filter-max-airport'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener('input', applyFilters);
    });
  }

  // ── Render auctions ─────────────────────────────────────────────────────────
  function renderAuctions(auctions) {
    allAuctions    = auctions;
    allMarkerPairs = [];
    markerMap      = new Map();
    clusterGroup   = L.markerClusterGroup();

    auctions.forEach(function (auction) {
      if (auction.lat == null || auction.lon == null) return;

      var marker = createMarker(auction);
      allMarkerPairs.push({ auction: auction, marker: marker });
      clusterGroup.addLayer(marker);
      markerMap.set(auction.id, marker);
    });

    map.addLayer(clusterGroup);
    setCount(allMarkerPairs.length, allAuctions.length);

    // ── Popup open: update URL hash ──────────────────────────────────────────
    map.on('popupopen', function (e) {
      var auctionId = e.popup._source && e.popup._source.options.auctionId;
      if (!auctionId) return;
      suppressHashChange = true;
      history.replaceState(
        null, '',
        '#auction=' + encodeURIComponent(auctionId)
      );
      suppressHashChange = false;
    });

    // ── Popup close: clear URL hash ──────────────────────────────────────────
    map.on('popupclose', function () {
      if (!window.location.hash.startsWith('#auction=')) return;
      suppressHashChange = true;
      history.replaceState(
        null, '',
        window.location.pathname + window.location.search
      );
      suppressHashChange = false;
    });

    // ── Handle hash navigation ───────────────────────────────────────────────
    window.addEventListener('hashchange', function () {
      if (suppressHashChange) return;
      handleDeepLink(clusterGroup, markerMap);
    });

    // ── Apply deep link on first load ────────────────────────────────────────
    handleDeepLink(clusterGroup, markerMap);

    // ── Attach filter event listeners ────────────────────────────────────────
    attachFilterEvents();
  }

  // ── Fetch auction data ──────────────────────────────────────────────────────
  fetch('./auctions.json')
    .then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    })
    .then(function (data) {
      var auctions    = data.auctions || [];
      var generatedAt = data.generated_at || '';

      if (generatedAt) {
        setStatus(
          'Daten: ' + generatedAt.slice(0, 16).replace('T', ' ') + ' UTC  |  '
          + auctions.length + ' Auktion(en)'
        );
      }

      renderAuctions(auctions);

      // Fit bounds on first visit (no saved view) when no deep link is active.
      if (!savedView && !window.location.hash.startsWith('#auction=')) {
        var coords = auctions
          .filter(function (a) { return a.lat != null && a.lon != null; })
          .map(function (a) { return [a.lat, a.lon]; });
        if (coords.length > 0) {
          map.fitBounds(coords, { padding: [30, 30] });
        }
      }
    })
    .catch(function (err) {
      console.error('Failed to load auctions.json:', err);
      setStatus('Fehler beim Laden der Auktionsdaten: ' + err.message);
    });

}());
