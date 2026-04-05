// CoffeeMap - Mobile-first OpenStreetMap coffee shop finder

(function () {
  'use strict';

  // --- Supabase ---
  var SUPABASE_URL = 'https://rosfemsvecvsszgkhjns.supabase.co';
  var SUPABASE_KEY = 'sb_publishable_ZpxXIsFgIvs5DbfFFt_7vQ_WyjWTRHZ';
  var sb = null;
  var currentUser = null;

  try {
    var createClient = (window.supabase && window.supabase.createClient) ||
                       (window.Supabase && window.Supabase.createClient);
    if (createClient) {
      sb = createClient(SUPABASE_URL, SUPABASE_KEY);
    } else {
      console.warn('Supabase SDK not loaded. Price features disabled.');
    }
  } catch (e) {
    console.warn('Supabase init failed:', e);
  }

  async function ensureAuth() {
    if (!sb) return null;
    if (currentUser) return currentUser;
    try {
      var { data } = await sb.auth.getSession();
      if (data.session) {
        currentUser = data.session.user;
        return currentUser;
      }
      var { data: signIn, error } = await sb.auth.signInAnonymously();
      if (error) { console.error('Auth error:', error); return null; }
      currentUser = signIn.session.user;
      return currentUser;
    } catch (e) {
      console.error('Auth error:', e);
      return null;
    }
  }

  var isAdmin = false;
  var hiddenPlaces = new Set();

  if (sb) {
    ensureAuth();
    loadHiddenPlaces();
  }

  async function loadHiddenPlaces() {
    if (!sb) return;
    var { data } = await sb.from('hidden_places').select('osm_id');
    if (data) {
      hiddenPlaces = new Set(data.map(function (r) { return r.osm_id; }));
    }
  }

  function checkAdmin() {
    if (!currentUser) { isAdmin = false; updateAdminUI(); return; }
    // Verify against server-side admins table
    sb.from('admins').select('user_id').eq('user_id', currentUser.id).maybeSingle()
      .then(function (res) {
        isAdmin = !!(res.data);
        updateAdminUI();
      })
      .catch(function () {
        isAdmin = false;
        updateAdminUI();
      });
  }

  function updateAdminUI() {
    var $loggedOut = document.getElementById('admin-logged-out');
    var $loggedIn = document.getElementById('admin-logged-in');
    var $status = document.getElementById('admin-status');
    if (isAdmin) {
      $loggedOut.style.display = 'none';
      $loggedIn.classList.remove('hidden');
      $status.textContent = 'Logged in as ' + currentUser.email;
    } else {
      $loggedOut.style.display = '';
      $loggedIn.classList.add('hidden');
    }
  }

  // --- State ---
  let map;
  let userMarker;
  let userLatLng = null;
  let shopMarkers = [];
  let activeMarker = null;
  let currentOsmId = null;
  let currentShopName = null;

  // --- DOM refs ---
  const $map = document.getElementById('map');
  const $searchInput = document.getElementById('search-input');
  const $btnSearch = document.getElementById('btn-search');
  const $btnMenu = document.getElementById('btn-menu');
  const $btnLocate = document.getElementById('btn-locate');
  const $sidebar = document.getElementById('sidebar');
  const $overlay = document.getElementById('sidebar-overlay');
  const $btnCloseSidebar = document.getElementById('btn-close-sidebar');
  const $detail = document.getElementById('shop-detail');
  const $btnCloseDetail = document.getElementById('btn-close-detail');
  const $btnDirections = document.getElementById('btn-directions');
  const $loading = document.getElementById('loading');
  const $filterCafe = document.getElementById('filter-cafe');
  const $filterEspresso = document.getElementById('filter-espresso');
  const $filterRoastery = document.getElementById('filter-roastery');
  const $filterWifi = document.getElementById('filter-wifi');
  const $prefPlantMilk = document.getElementById('pref-plant-milk');
  const $priceDisplay = document.getElementById('price-display');
  const $priceModal = document.getElementById('price-modal');
  const $btnAddPrice = document.getElementById('btn-add-price');
  const $btnClosePrice = document.getElementById('btn-close-price');
  const $btnSubmitPrice = document.getElementById('btn-submit-price');
  const $inputPrice = document.getElementById('input-price');
  const $inputPricePlant = document.getElementById('input-price-plant');
  const $priceError = document.getElementById('price-error');
  const $pillWifi = document.getElementById('pill-wifi');
  const $pillPlant = document.getElementById('pill-plant');
  const $btnHidePlace = document.getElementById('btn-hide-place');
  const $btnAdminLogin = document.getElementById('btn-admin-login');
  const $btnAdminLogout = document.getElementById('btn-admin-logout');
  const $adminLoginLink = document.getElementById('admin-login-link');
  const $loginModal = document.getElementById('login-modal');
  const $btnCloseLogin = document.getElementById('btn-close-login');
  const $adminEmail = document.getElementById('admin-email');
  const $adminPassword = document.getElementById('admin-password');
  const $adminError = document.getElementById('admin-error');

  // --- Coffee icon ---
  function createCoffeeIcon(active, priceText, muted) {
    var cls = 'coffee-marker' + (active ? ' coffee-marker-active' : '') + (muted ? ' coffee-marker-muted' : '');
    var priceTag = priceText ? '<span class="marker-price">' + priceText + '</span>' : '';
    return L.divIcon({
      className: '',
      html: '<div class="coffee-marker-wrap">' +
            '<div class="' + cls + '"><span>&#9749;</span></div>' +
            priceTag + '</div>',
      iconSize: active ? [38, 38] : [32, 32],
      iconAnchor: active ? [19, 38] : [16, 32],
      popupAnchor: [0, -32],
    });
  }

  const userIcon = L.divIcon({
    className: '',
    html: '<div class="user-location"></div>',
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });

  // --- Init map ---
  function initMap() {
    map = L.map($map, {
      zoomControl: true,
      attributionControl: true,
      tap: true,
    }).setView([40.7128, -74.006], 14);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(map);

    let moveTimer;
    map.on('moveend', function () {
      clearTimeout(moveTimer);
      moveTimer = setTimeout(fetchCoffeeShops, 400);
    });

    map.on('click', function () {
      closeDetail();
    });

    locateUser(true);
  }

  // --- Geolocation ---
  function locateUser(initial) {
    if (!navigator.geolocation) return;

    navigator.geolocation.getCurrentPosition(
      function (pos) {
        userLatLng = [pos.coords.latitude, pos.coords.longitude];

        if (userMarker) {
          userMarker.setLatLng(userLatLng);
        } else {
          userMarker = L.marker(userLatLng, { icon: userIcon, zIndexOffset: 1000 }).addTo(map);
        }

        if (initial) {
          // Snap to query grid so viewport bbox is identical across GPS drift
          var snappedLat = Math.round(pos.coords.latitude / QUERY_GRID) * QUERY_GRID;
          var snappedLng = Math.round(pos.coords.longitude / QUERY_GRID) * QUERY_GRID;
          map.setView([snappedLat, snappedLng], 15);
        } else {
          map.flyTo(userLatLng, 16, { duration: 0.8 });
        }
      },
      function () {
        if (initial) fetchCoffeeShops();
      },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  }

  // =========================================================================
  // Region-based fetch system with background worker
  // =========================================================================
  // Fetches whole viewport as ONE request (not split into cells).
  // Uses a grid for TRACKING which areas are covered (to avoid re-fetching).
  // Background worker prefetches surrounding regions one at a time.
  // =========================================================================

  var CELL_SIZE = 0.005;        // ~500m tracking grid
  var QUERY_GRID = 0.01;        // ~1km query snap grid (coarser = stable cache keys)
  var CELL_TTL = 60 * 60 * 1000; // 1 hour
  var MAX_ELEMENTS = 3000;
  var MAX_RETRY = 3;

  var lastElements = [];
  var elementIndex = {};

  // Grid tracks which cells are covered — but queries are region-sized, not cell-sized
  var cellStates = {};  // "cx,cy" -> { time, filterKey, zoom }

  // Region queue: viewport + N/E/S/W prefetch, sorted by distance
  var regionQueue = [];   // [{ bounds, filterKey, zoom, attempts, failTime, isViewport }]
  var activeRequest = false;
  var workerTimer = null;
  var retryWakeTimer = null;
  var consecutiveErrors = 0;

  function getFilterKey() {
    return ($filterCafe.checked ? 'c' : '') +
           ($filterEspresso.checked ? 'e' : '') +
           ($filterRoastery.checked ? 'r' : '');
  }

  // --- Grid helpers (for tracking, not querying) ---
  function cellId(cx, cy) { return cx + ',' + cy; }

  function markCellsFetched(bounds, filterKey, zoom) {
    var now = Date.now();
    var s = bounds.getSouth(), n = bounds.getNorth();
    var w = bounds.getWest(), e = bounds.getEast();
    for (var lat = Math.floor(s / CELL_SIZE); lat * CELL_SIZE <= n; lat++) {
      for (var lng = Math.floor(w / CELL_SIZE); lng * CELL_SIZE <= e; lng++) {
        cellStates[cellId(lng, lat)] = { time: now, filterKey: filterKey, zoom: zoom };
      }
    }
    saveCellStates();
  }

  function regionFullyCovered(bounds, filterKey, zoom) {
    var now = Date.now();
    var s = bounds.getSouth(), n = bounds.getNorth();
    var w = bounds.getWest(), e = bounds.getEast();
    for (var lat = Math.floor(s / CELL_SIZE); lat * CELL_SIZE <= n; lat++) {
      for (var lng = Math.floor(w / CELL_SIZE); lng * CELL_SIZE <= e; lng++) {
        var c = cellStates[cellId(lng, lat)];
        if (!c || c.filterKey !== filterKey || c.zoom !== zoom || now - c.time >= CELL_TTL) {
          return false;
        }
      }
    }
    return true;
  }

  // --- Persistence ---
  function saveCellStates() {
    try {
      var toSave = {};
      var now = Date.now();
      for (var key in cellStates) {
        var c = cellStates[key];
        if (now - c.time < CELL_TTL) toSave[key] = c;
      }
      localStorage.setItem('cm_cells', JSON.stringify(toSave));
    } catch (e) {}
  }

  function loadCellStates() {
    try {
      var stored = localStorage.getItem('cm_cells');
      if (!stored) return;
      var parsed = JSON.parse(stored);
      var now = Date.now();
      for (var key in parsed) {
        if (now - parsed[key].time < CELL_TTL) cellStates[key] = parsed[key];
      }
    } catch (e) {}
  }

  // --- Build the queue: viewport first, then surrounding regions ---
  function buildRegionQueue() {
    var filterKey = getFilterKey();
    var zoom = map.getZoom();
    var bounds = map.getBounds();
    var padded = bounds.pad(0.1);

    // Demote any old viewport regions to background
    regionQueue.forEach(function (r) { r.isViewport = false; });

    // Helper: check if a bounds is already in the queue
    function alreadyQueued(b) {
      var bs = bboxString(b);
      for (var i = 0; i < regionQueue.length; i++) {
        if (bboxString(regionQueue[i].bounds) === bs) return true;
      }
      return false;
    }

    // Always include viewport in batch — cache hits are free and stream back
    // instantly, so there's no cost to re-requesting a covered region.
    if (!alreadyQueued(padded)) {
      regionQueue.unshift({
        bounds: padded, filterKey: filterKey, zoom: zoom,
        attempts: 0, failTime: 0, isViewport: true
      });
    } else {
      var bs = bboxString(padded);
      regionQueue.forEach(function (r) {
        if (bboxString(r.bounds) === bs) r.isViewport = true;
      });
    }

    // Surrounding regions: N, NE, E, SE, S, SW, W, NW
    var latSpan = bounds.getNorth() - bounds.getSouth();
    var lngSpan = bounds.getEast() - bounds.getWest();
    var offsets = [
      [0, latSpan], [lngSpan, latSpan], [lngSpan, 0], [lngSpan, -latSpan],
      [0, -latSpan], [-lngSpan, -latSpan], [-lngSpan, 0], [-lngSpan, latSpan]
    ];

    offsets.forEach(function (off) {
      var shifted = L.latLngBounds(
        [bounds.getSouth() + off[1], bounds.getWest() + off[0]],
        [bounds.getNorth() + off[1], bounds.getEast() + off[0]]
      );
      if (regionFullyCovered(shifted, filterKey, zoom)) return;
      if (alreadyQueued(shifted)) return;
      regionQueue.push({
        bounds: shifted, filterKey: filterKey, zoom: zoom,
        attempts: 0, failTime: 0, isViewport: false
      });
    });

    // Purge stale entries (wrong filter/zoom)
    regionQueue = regionQueue.filter(function (r) {
      return r.filterKey === filterKey && r.zoom === zoom;
    });
  }

  // --- Worker: batch-fetches all regions in one streaming request ---
  function wakeWorker() {
    clearTimeout(workerTimer);
    clearTimeout(retryWakeTimer);
    buildRegionQueue();
    runBatch();
  }

  function runBatch() {
    if (activeRequest) return;

    var filterKey = getFilterKey();
    var zoom = map.getZoom();

    // Collect regions — always include viewport (cache hits are free),
    // skip covered background regions
    var toFetch = [];
    var regionMap = {}; // id -> region
    for (var i = 0; i < regionQueue.length; i++) {
      var r = regionQueue[i];
      if (!r.isViewport && regionFullyCovered(r.bounds, r.filterKey, r.zoom)) {
        regionQueue.splice(i, 1); i--; continue;
      }
      var bbox = bboxString(r.bounds);
      var query = buildQuery(bbox);
      if (!query) { regionQueue.splice(i, 1); i--; continue; }
      var id = bbox;
      toFetch.push({ id: id, query: query });
      regionMap[id] = r;
    }

    if (toFetch.length === 0) {
      hideLoading();
      return;
    }

    // Sort: viewport first
    toFetch.sort(function (a, b) {
      var ra = regionMap[a.id], rb = regionMap[b.id];
      if (ra.isViewport !== rb.isViewport) return ra.isViewport ? -1 : 1;
      var center = map.getCenter();
      var ac = ra.bounds.getCenter(), bc = rb.bounds.getCenter();
      var da = (ac.lat - center.lat) * (ac.lat - center.lat) + (ac.lng - center.lng) * (ac.lng - center.lng);
      var db = (bc.lat - center.lat) * (bc.lat - center.lat) + (bc.lng - center.lng) * (bc.lng - center.lng);
      return da - db;
    });

    showLoading();
    activeRequest = true;
    console.log('Batch fetch:', toFetch.length, 'regions');

    var proxyUrl = SUPABASE_URL + '/functions/v1/overpass-proxy';
    fetch(proxyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY },
      body: JSON.stringify({ queries: toFetch }),
    }).then(function (res) {
      if (!res.ok) {
        throw new Error('Batch proxy error ' + res.status);
      }
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';

      function processLines() {
        var lines = buffer.split('\n');
        buffer = lines.pop() || '';
        lines.forEach(function (line) {
          if (!line.trim()) return;
          try {
            var result = JSON.parse(line);
            var region = regionMap[result.id];
            if (!region) return;
            console.log('Stream:', result.id, 'cache=' + result.cache, result.error || '');
            if (result.data && result.data.elements && result.data.elements.length > 0) {
              mergeElements(result.data.elements);
              renderShops(lastElements);
              markCellsFetched(region.bounds, region.filterKey, region.zoom);
              var idx = regionQueue.indexOf(region);
              if (idx >= 0) regionQueue.splice(idx, 1);
            } else if (result.error) {
              region.attempts++;
              region.failTime = Date.now();
              if (!region.isViewport && region.attempts >= MAX_RETRY) {
                var idx = regionQueue.indexOf(region);
                if (idx >= 0) regionQueue.splice(idx, 1);
              }
            } else {
              // Success but no elements
              markCellsFetched(region.bounds, region.filterKey, region.zoom);
              var idx = regionQueue.indexOf(region);
              if (idx >= 0) regionQueue.splice(idx, 1);
            }
          } catch (e) {
            console.error('Stream parse error:', e);
          }
        });
      }

      function pump() {
        return reader.read().then(function (result) {
          if (result.done) {
            if (buffer.trim()) processLines();
            return;
          }
          buffer += decoder.decode(result.value, { stream: true });
          processLines();
          return pump();
        });
      }

      return pump();
    }).catch(function (err) {
      console.error('Batch fetch error:', err.message);
      consecutiveErrors++;
    }).then(function () {
      activeRequest = false;
      hideLoading();
      // Retry remaining regions after a delay if any are left
      if (regionQueue.length > 0) {
        var gap = consecutiveErrors > 0
          ? Math.min(5000 * Math.pow(2, consecutiveErrors - 1), 30000)
          : 3000;
        workerTimer = setTimeout(function () { consecutiveErrors = 0; runBatch(); }, gap);
      }
    });
  }

  // --- Main entry point ---
  function fetchCoffeeShops() {
    var filterKey = getFilterKey();
    if (!filterKey) {
      clearMarkers();
      invalidateCache();
      return;
    }
    wakeWorker();
  }

  function invalidateCache(clearData) {
    cellStates = {};
    regionQueue = [];
    clearTimeout(workerTimer);
    clearTimeout(retryWakeTimer);
    activeRequest = false;
    consecutiveErrors = 0;
    try { localStorage.removeItem('cm_cells'); } catch (e) {}
    if (clearData) {
      clearElements();
      clearMarkers();
    }
  }

  // --- Element management ---
  function mergeElements(newElements) {
    newElements.forEach(function (el) {
      var key = el.type + '/' + el.id;
      if (!elementIndex[key]) {
        elementIndex[key] = true;
        lastElements.push(el);
      }
    });
    if (lastElements.length > MAX_ELEMENTS) {
      var removed = lastElements.splice(0, lastElements.length - MAX_ELEMENTS);
      removed.forEach(function (el) { delete elementIndex[el.type + '/' + el.id]; });
    }
  }

  function clearElements() {
    lastElements = [];
    elementIndex = {};
  }

  // --- Overpass API ---
  function buildQuery(bbox) {
    var filters = [];
    if ($filterCafe.checked) {
      filters.push('node["amenity"="cafe"]["cuisine"!~"ice_cream|bar|pub|pizza|burger|sandwich"]('+bbox+');');
      filters.push('way["amenity"="cafe"]["cuisine"!~"ice_cream|bar|pub|pizza|burger|sandwich"]('+bbox+');');
    }
    if ($filterEspresso.checked) {
      filters.push('node["cuisine"~"coffee|coffee_shop"]('+bbox+');');
      filters.push('way["cuisine"~"coffee|coffee_shop"]('+bbox+');');
    }
    if ($filterRoastery.checked) {
      filters.push('node["craft"="roastery"]('+bbox+');');
      filters.push('way["craft"="roastery"]('+bbox+');');
    }
    if (filters.length === 0) return null;
    return '[out:json][timeout:10];(' + filters.join('') + ');out center 300;';
  }

  // Snap bbox to QUERY_GRID so small pans/GPS drift don't change cache keys
  function snapToGrid(v, roundDown) {
    return roundDown
      ? (Math.floor(v / QUERY_GRID) * QUERY_GRID).toFixed(2)
      : (Math.ceil(v / QUERY_GRID) * QUERY_GRID).toFixed(2);
  }

  function bboxString(bounds) {
    return snapToGrid(bounds.getSouth(), true) + ',' +
           snapToGrid(bounds.getWest(), true) + ',' +
           snapToGrid(bounds.getNorth(), false) + ',' +
           snapToGrid(bounds.getEast(), false);
  }

  function fireQuery(query, signal) {
    // Debug: log the bbox coordinates
    var bboxMatch = query.match(/(\d+\.\d+,\d+\.\d+,\d+\.\d+,\d+\.\d+)/);
    if (bboxMatch) console.log('Query bbox:', bboxMatch[1]);

    var proxyUrl = SUPABASE_URL + '/functions/v1/overpass-proxy';
    return fetch(proxyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY },
      body: JSON.stringify({ query: query }),
      signal: signal,
    }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (body) {
          throw new Error('Proxy error ' + res.status + ': ' + body);
        });
      }
      console.log('X-Cache:', res.headers.get('X-Cache'),
        'Key:', res.headers.get('X-Cache-Key'),
        'Write:', res.headers.get('X-Cache-Write'));
      return res.json();
    });
  }

  // Load persisted cell states on startup
  loadCellStates();

  // --- Render shop markers (incremental — never destroys existing markers) ---
  var markerIndex = {}; // osmId -> marker

  function renderShops(elements) {
    var wifiOnly = $filterWifi.checked;
    var hadNew = false;

    elements.forEach(function (el) {
      var tags = el.tags || {};
      var osmId = el.type + '/' + el.id;
      var isHidden = hiddenPlaces.has(osmId);
      if (isHidden && !isAdmin) return;

      if (markerIndex[osmId]) {
        // Already on map — just update WiFi visibility
        if (wifiOnly && !tags.internet_access) {
          var el2 = markerIndex[osmId].getElement();
          if (el2) el2.style.display = 'none';
        }
        return;
      }

      var lat = el.lat || (el.center && el.center.lat);
      var lon = el.lon || (el.center && el.center.lon);
      if (!lat || !lon) return;

      var marker = L.marker([lat, lon], { icon: createCoffeeIcon(false, null, isHidden) }).addTo(map);
      marker._muted = isHidden;
      marker._shopData = tags;
      marker._shopData._lat = lat;
      marker._shopData._lon = lon;
      marker._shopData._osmId = osmId;

      marker.on('click', function (e) {
        L.DomEvent.stopPropagation(e);
        selectShop(marker);
      });

      // Apply WiFi filter on new markers
      if (wifiOnly && !tags.internet_access) {
        setTimeout(function () {
          var el2 = marker.getElement();
          if (el2) el2.style.display = 'none';
        }, 0);
      }

      shopMarkers.push(marker);
      markerIndex[osmId] = marker;
      hadNew = true;
    });

    if (hadNew) fetchMarkerPrices();
  }

  // Batch-fetch prices for all visible markers and add price badges
  async function fetchMarkerPrices() {
    if (!sb || shopMarkers.length === 0) return;

    var osmIds = shopMarkers.map(function (m) { return m._shopData._osmId; });

    // Supabase .in() has URL length limits, chunk if needed
    var allData = [];
    for (var i = 0; i < osmIds.length; i += 30) {
      var chunk = osmIds.slice(i, i + 30);
      var { data, error } = await sb
        .from('prices')
        .select('osm_id, price_regular, price_plant_milk, created_at')
        .in('osm_id', chunk)
        .order('created_at', { ascending: false });
      if (!error && data) allData = allData.concat(data);
    }

    if (allData.length === 0) return;
    data = allData;

    // Group by osm_id
    var byShop = {};
    data.forEach(function (r) {
      if (!byShop[r.osm_id]) byShop[r.osm_id] = [];
      byShop[r.osm_id].push(r);
    });

    var showPlant = $prefPlantMilk.checked;

    shopMarkers.forEach(function (marker) {
      var osmId = marker._shopData._osmId;
      var rows = byShop[osmId];
      if (!rows || rows.length === 0) return;

      var values = rows
        .map(function (r) { return showPlant ? (r.price_plant_milk || r.price_regular) : r.price_regular; })
        .filter(function (v) { return v != null; });

      if (values.length === 0) return;

      var price = latestCleanPrice(values);
      var text = '\u20AC' + price.toFixed(2);
      marker._priceText = text;

      var isActive = marker === activeMarker;
      marker.setIcon(createCoffeeIcon(isActive, text, marker._muted));
    });
  }

  function clearMarkers() {
    shopMarkers.forEach(function (m) { map.removeLayer(m); });
    shopMarkers = [];
    markerIndex = {};
    activeMarker = null;
  }

  // --- Select / detail ---
  function selectShop(marker) {
    if (activeMarker) {
      activeMarker.setIcon(createCoffeeIcon(false, activeMarker._priceText, activeMarker._muted));
    }

    activeMarker = marker;
    marker.setIcon(createCoffeeIcon(true, marker._priceText, marker._muted));

    const d = marker._shopData;
    currentOsmId = d._osmId;
    currentShopName = d.name || 'Coffee Shop';

    var $photoWrap = document.getElementById('detail-photo-wrap');
    var $photo = document.getElementById('detail-photo');
    var photoUrl = getPhotoUrl(d);
    if (photoUrl) {
      $photo.src = photoUrl;
      $photo.onerror = function () { $photoWrap.classList.add('hidden'); };
      $photoWrap.classList.remove('hidden');
    } else {
      $photoWrap.classList.add('hidden');
      $photo.src = '';
    }

    document.getElementById('detail-name').textContent = currentShopName;
    document.getElementById('detail-cuisine').textContent = d.cuisine ? 'Cuisine: ' + d.cuisine : '';
    document.getElementById('detail-address').textContent = formatAddress(d);
    document.getElementById('detail-hours').textContent = d.opening_hours ? 'Hours: ' + d.opening_hours : '';
    document.getElementById('detail-phone').textContent = d.phone ? 'Phone: ' + d.phone : '';
    document.getElementById('detail-wifi').textContent =
      (d.internet_access === 'wlan' || d.internet_access === 'yes') ? 'WiFi: Yes' : '';

    const $website = document.getElementById('detail-website');
    if (d.website) {
      $website.innerHTML = 'Website: <a href="' + escapeHtml(d.website) + '" target="_blank" rel="noopener">' + escapeHtml(truncate(d.website, 40)) + '</a>';
    } else {
      $website.textContent = '';
    }

    $btnDirections._lat = d._lat;
    $btnDirections._lon = d._lon;

    $btnHidePlace.classList.toggle('hidden', !isAdmin);
    $detail.classList.remove('hidden');
    loadPrices(currentOsmId);
  }

  function formatAddress(tags) {
    const parts = [];
    if (tags['addr:street']) {
      let addr = '';
      if (tags['addr:housenumber']) addr += tags['addr:housenumber'] + ' ';
      addr += tags['addr:street'];
      parts.push(addr);
    }
    if (tags['addr:city']) parts.push(tags['addr:city']);
    return parts.length > 0 ? parts.join(', ') : '';
  }

  function closeDetail() {
    $detail.classList.add('hidden');
    if (activeMarker) {
      activeMarker.setIcon(createCoffeeIcon(false, activeMarker._priceText, activeMarker._muted));
      activeMarker = null;
    }
    currentOsmId = null;
  }

  // --- Price helpers ---
  function median(sorted) {
    var n = sorted.length;
    if (n === 0) return 0;
    var mid = Math.floor(n / 2);
    return n % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  // Return the most recent value that isn't an outlier
  function latestCleanPrice(values) {
    if (values.length === 0) return null;
    if (values.length < 4) return values[0]; // too few for IQR, trust the newest

    var sorted = values.slice().sort(function (a, b) { return a - b; });
    var q1 = median(sorted.slice(0, Math.floor(sorted.length / 2)));
    var q3 = median(sorted.slice(Math.ceil(sorted.length / 2)));
    var iqr = q3 - q1;
    var lower = q1 - 1.5 * iqr;
    var upper = q3 + 1.5 * iqr;

    // values are already ordered newest-first from the query
    for (var i = 0; i < values.length; i++) {
      if (values[i] >= lower && values[i] <= upper) return values[i];
    }
    return values[0]; // fallback to newest if all are "outliers"
  }

  function priceRowHtml(label, values) {
    if (values.length === 0) return '';
    var price = latestCleanPrice(values);
    return '<div class="price-row">' +
      '<span class="price-label">' + label + '</span>' +
      '<span><span class="price-value">&euro;' + price.toFixed(2) + '</span>' +
      '<span class="price-count">(' + values.length + ' report' + (values.length !== 1 ? 's' : '') + ')</span></span></div>';
  }

  // --- Prices ---
  async function loadPrices(osmId) {
    if (!sb) {
      $priceDisplay.innerHTML = '<p class="price-empty">Price database unavailable.</p>';
      return;
    }
    $priceDisplay.innerHTML = '<p class="price-empty">Loading prices...</p>';

    var { data, error } = await sb
      .from('prices')
      .select('price_regular, price_plant_milk, created_at')
      .eq('osm_id', osmId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error || !data || data.length === 0) {
      $priceDisplay.innerHTML = '<p class="price-empty">No prices yet. Be the first to submit!</p>';
      return;
    }

    var showPlant = $prefPlantMilk.checked;

    // Use recent submissions, remove outliers via IQR, show median
    var regValues = data.filter(function (r) { return r.price_regular != null; })
                        .map(function (r) { return r.price_regular; });
    var plantValues = data.filter(function (r) { return r.price_plant_milk != null; })
                          .map(function (r) { return r.price_plant_milk; });

    var html = '';
    html += priceRowHtml('Regular milk', regValues);
    if (showPlant) html += priceRowHtml('Plant milk', plantValues);

    if (!html) {
      html = '<p class="price-empty">No prices yet. Be the first to submit!</p>';
    }

    $priceDisplay.innerHTML = html;
  }

  function openPriceModal() {
    $inputPrice.value = '';
    $inputPricePlant.value = '';
    $priceError.classList.add('hidden');
    $btnSubmitPrice.disabled = false;
    $priceModal.classList.remove('hidden');
  }

  function closePriceModal() {
    $priceModal.classList.add('hidden');
  }

  async function submitPrice() {
    var regular = parseFloat($inputPrice.value);
    var plant = parseFloat($inputPricePlant.value);

    if (isNaN(regular) && isNaN(plant)) {
      $priceError.textContent = 'Please enter at least one price.';
      $priceError.classList.remove('hidden');
      return;
    }

    if ((!isNaN(regular) && (regular <= 0 || regular > 99.99)) ||
        (!isNaN(plant) && (plant <= 0 || plant > 99.99))) {
      $priceError.textContent = 'Price must be between 0.01 and 99.99.';
      $priceError.classList.remove('hidden');
      return;
    }

    $btnSubmitPrice.disabled = true;
    $priceError.classList.add('hidden');

    var user = await ensureAuth();
    if (!user) {
      $priceError.textContent = 'Could not sign in. Please try again.';
      $priceError.classList.remove('hidden');
      $btnSubmitPrice.disabled = false;
      return;
    }

    var row = {
      user_id: user.id,
      osm_id: currentOsmId,
      shop_name: currentShopName,
      drink: 'cappuccino',
      price_regular: isNaN(regular) ? null : regular,
      price_plant_milk: isNaN(plant) ? null : plant,
    };

    var { error } = await sb.from('prices').insert(row);

    if (error) {
      $priceError.textContent = error.message || 'Could not submit price.';
      $priceError.classList.remove('hidden');
      $btnSubmitPrice.disabled = false;
      return;
    }

    closePriceModal();
    loadPrices(currentOsmId);
    fetchMarkerPrices();
  }

  // --- Search ---
  function doSearch() {
    const q = $searchInput.value.trim();
    if (!q) return;

    $searchInput.blur();

    showLoading();
    fetch('https://nominatim.openstreetmap.org/search?format=json&q=' + encodeURIComponent(q) + '&limit=1', {
      headers: { 'Accept-Language': 'en' },
    })
      .then(function (res) { return res.json(); })
      .then(function (results) {
        hideLoading();
        if (results.length > 0) {
          const r = results[0];
          invalidateCache(true);
          map.flyTo([parseFloat(r.lat), parseFloat(r.lon)], 15, { duration: 1 });
        }
      })
      .catch(function () {
        hideLoading();
      });
  }

  // --- Sidebar ---
  function openSidebar() {
    $sidebar.classList.remove('hidden');
    $overlay.classList.remove('hidden');
  }

  function closeSidebar() {
    $sidebar.classList.add('hidden');
    $overlay.classList.add('hidden');
  }

  // --- Loading ---
  function showLoading() { $loading.classList.remove('hidden'); }
  function hideLoading() { $loading.classList.add('hidden'); }

  // --- Helpers ---
  function escapeHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  function truncate(str, len) {
    return str.length > len ? str.substring(0, len) + '...' : str;
  }

  function getPhotoUrl(tags) {
    if (tags.image) return tags.image;
    if (tags.wikimedia_commons) {
      var file = tags.wikimedia_commons.replace(/^File:/, '').replace(/ /g, '_');
      return 'https://commons.wikimedia.org/wiki/Special:FilePath/' + encodeURIComponent(file) + '?width=400';
    }
    return null;
  }

  // --- Event listeners ---
  $btnMenu.addEventListener('click', openSidebar);
  $btnCloseSidebar.addEventListener('click', closeSidebar);
  $overlay.addEventListener('click', closeSidebar);
  $btnLocate.addEventListener('click', function () { locateUser(false); });
  $btnCloseDetail.addEventListener('click', closeDetail);
  $btnSearch.addEventListener('click', doSearch);
  $searchInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') doSearch();
  });

  $btnDirections.addEventListener('click', function () {
    var lat = this._lat;
    var lon = this._lon;
    var url = 'https://www.openstreetmap.org/directions?from=&to=' + lat + ',' + lon;
    window.open(url, '_blank');
  });

  // Filters
  [$filterCafe, $filterEspresso, $filterRoastery].forEach(function (cb) {
    cb.addEventListener('change', function () {
      invalidateCache(true);
      fetchCoffeeShops();
    });
  });

  // WiFi filter: show/hide existing markers, no re-fetch
  $filterWifi.addEventListener('change', function () {
    if (shopMarkers.length === 0 && lastElements.length === 0) {
      fetchCoffeeShops();
      return;
    }
    if (shopMarkers.length === 0) {
      renderShops(lastElements);
      return;
    }
    var wifiOn = $filterWifi.checked;
    shopMarkers.forEach(function (m) {
      var hasWifi = m._shopData.internet_access;
      if (wifiOn && !hasWifi) {
        m.getElement() && (m.getElement().style.display = 'none');
      } else {
        m.getElement() && (m.getElement().style.display = '');
      }
    });
  });

  // Plant milk pref: reload detail + map marker prices
  $prefPlantMilk.addEventListener('change', function () {
    if (currentOsmId) loadPrices(currentOsmId);
    fetchMarkerPrices();
  });

  // Quick-access pills — sync with sidebar checkboxes
  function syncPill(pill, checkbox) {
    pill.dataset.active = String(checkbox.checked);
  }

  $pillWifi.addEventListener('click', function () {
    $filterWifi.checked = !$filterWifi.checked;
    syncPill($pillWifi, $filterWifi);
    $filterWifi.dispatchEvent(new Event('change'));
  });

  $pillPlant.addEventListener('click', function () {
    $prefPlantMilk.checked = !$prefPlantMilk.checked;
    syncPill($pillPlant, $prefPlantMilk);
    $prefPlantMilk.dispatchEvent(new Event('change'));
  });

  // Keep pills in sync when sidebar checkboxes change
  $filterWifi.addEventListener('change', function () { syncPill($pillWifi, $filterWifi); });
  $prefPlantMilk.addEventListener('change', function () { syncPill($pillPlant, $prefPlantMilk); });

  // Price modal
  $btnAddPrice.addEventListener('click', openPriceModal);
  $btnClosePrice.addEventListener('click', closePriceModal);
  $priceModal.addEventListener('click', function (e) {
    if (e.target === $priceModal) closePriceModal();
  });
  $btnSubmitPrice.addEventListener('click', submitPrice);

  // Prevent pull-to-refresh on mobile
  document.body.addEventListener('touchmove', function (e) {
    if (e.target.closest('#sidebar-content') || e.target.closest('#shop-detail')) return;
    if (e.target.closest('#map')) return;
  }, { passive: true });

  // --- Admin ---
  $adminLoginLink.addEventListener('click', function (e) {
    e.preventDefault();
    closeSidebar();
    $adminEmail.value = '';
    $adminPassword.value = '';
    $adminError.classList.add('hidden');
    $loginModal.classList.remove('hidden');
  });

  $btnCloseLogin.addEventListener('click', function () {
    $loginModal.classList.add('hidden');
  });

  $btnAdminLogin.addEventListener('click', async function () {
    $adminError.classList.add('hidden');
    var email = $adminEmail.value.trim();
    var password = $adminPassword.value;
    if (!email || !password) {
      $adminError.textContent = 'Enter email and password.';
      $adminError.classList.remove('hidden');
      return;
    }
    var { data, error } = await sb.auth.signInWithPassword({ email: email, password: password });
    if (error) {
      $adminError.textContent = error.message;
      $adminError.classList.remove('hidden');
      return;
    }
    currentUser = data.session.user;
    checkAdmin();
    $loginModal.classList.add('hidden');
    clearMarkers();
    renderShops(lastElements);
  });

  $adminPassword.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') $btnAdminLogin.click();
  });

  $btnAdminLogout.addEventListener('click', function (e) {
    e.preventDefault();
    sb.auth.signOut().then(function () {
      isAdmin = false;
      currentUser = null;
      updateAdminUI();
      ensureAuth();
      clearMarkers();
      renderShops(lastElements);
    });
  });

  $btnHidePlace.addEventListener('click', async function () {
    if (!isAdmin || !currentOsmId) return;
    var { error } = await sb.from('hidden_places').insert({
      osm_id: currentOsmId,
      shop_name: currentShopName,
      hidden_by: currentUser.id,
    });
    if (error) {
      console.error('Hide error:', error);
      return;
    }
    hiddenPlaces.add(currentOsmId);
    // Mute the marker instead of removing it
    if (activeMarker) {
      activeMarker._muted = true;
      activeMarker.setIcon(createCoffeeIcon(false, activeMarker._priceText, true));
    }
    closeDetail();
  });

  // --- Start ---
  initMap();
})();
