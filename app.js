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

  if (sb) ensureAuth();

  // --- State ---
  let map;
  let userMarker;
  let userLatLng = null;
  let shopMarkers = [];
  let activeMarker = null;
  let searchAbort = null;
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

  // --- Coffee icon ---
  function createCoffeeIcon(active, priceText) {
    var priceTag = priceText ? '<span class="marker-price">' + priceText + '</span>' : '';
    return L.divIcon({
      className: '',
      html: '<div class="coffee-marker-wrap">' +
            '<div class="coffee-marker' + (active ? ' coffee-marker-active' : '') + '"><span>&#9749;</span></div>' +
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
          map.setView(userLatLng, 15);
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

  // --- Simple cache ---
  var lastFetchCenter = null;
  var lastFetchZoom = null;
  var lastFilterKey = '';
  var CACHE_TTL = 5 * 60 * 1000;
  var lastFetchTime = 0;

  function getFilterKey() {
    return ($filterCafe.checked ? 'c' : '') +
           ($filterEspresso.checked ? 'e' : '') +
           ($filterRoastery.checked ? 'r' : '') +
           ($filterWifi.checked ? 'w' : '');
  }

  function invalidateCache() {
    lastFetchCenter = null;
    lastFilterKey = '';
  }

  // --- Overpass API ---
  function fetchCoffeeShops() {
    const bounds = map.getBounds();
    var center = map.getCenter();
    var zoom = map.getZoom();
    var filterKey = getFilterKey();

    if (lastFetchCenter && filterKey === lastFilterKey &&
        zoom === lastFetchZoom &&
        center.distanceTo(lastFetchCenter) < 500 &&
        Date.now() - lastFetchTime < CACHE_TTL) {
      return;
    }

    var padded = bounds.pad(0.2);
    const south = padded.getSouth().toFixed(6);
    const west = padded.getWest().toFixed(6);
    const north = padded.getNorth().toFixed(6);
    const east = padded.getEast().toFixed(6);
    const bbox = south + ',' + west + ',' + north + ',' + east;

    var wifi = $filterWifi.checked ? '["internet_access"~"wlan|yes"]' : '';
    const filters = [];
    if ($filterCafe.checked) {
      filters.push('node["amenity"="cafe"]["cuisine"!~"ice_cream|bar|pub|pizza|burger|sandwich"]'+wifi+'('+bbox+');');
      filters.push('way["amenity"="cafe"]["cuisine"!~"ice_cream|bar|pub|pizza|burger|sandwich"]'+wifi+'('+bbox+');');
    }
    if ($filterEspresso.checked) {
      filters.push('node["cuisine"~"coffee|coffee_shop"]'+wifi+'('+bbox+');');
      filters.push('way["cuisine"~"coffee|coffee_shop"]'+wifi+'('+bbox+');');
    }
    if ($filterRoastery.checked) {
      filters.push('node["craft"="roastery"]'+wifi+'('+bbox+');');
      filters.push('way["craft"="roastery"]'+wifi+'('+bbox+');');
    }

    if (filters.length === 0) {
      clearMarkers();
      invalidateCache();
      return;
    }

    const query = '[out:json][timeout:15];(' + filters.join('') + ');out center 80;';

    if (searchAbort) searchAbort.abort();
    searchAbort = new AbortController();

    showLoading();

    fetch('https://overpass-api.de/api/interpreter?data=' + encodeURIComponent(query), {
      signal: searchAbort.signal,
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        hideLoading();
        var elements = data.elements || [];
        lastFetchCenter = map.getCenter();
        lastFetchZoom = map.getZoom();
        lastFilterKey = filterKey;
        lastFetchTime = Date.now();
        renderShops(elements);
      })
      .catch(function (err) {
        hideLoading();
        if (err.name !== 'AbortError') {
          console.error('Overpass fetch error:', err);
        }
      });
  }

  // --- Render shop markers ---
  function renderShops(elements) {
    clearMarkers();
    const seen = new Set();

    elements.forEach(function (el) {
      const lat = el.lat || (el.center && el.center.lat);
      const lon = el.lon || (el.center && el.center.lon);
      if (!lat || !lon) return;

      const key = lat.toFixed(5) + ',' + lon.toFixed(5);
      if (seen.has(key)) return;
      seen.add(key);

      const marker = L.marker([lat, lon], { icon: createCoffeeIcon(false) }).addTo(map);
      marker._shopData = el.tags || {};
      marker._shopData._lat = lat;
      marker._shopData._lon = lon;
      marker._shopData._osmId = el.type + '/' + el.id;

      marker.on('click', function (e) {
        L.DomEvent.stopPropagation(e);
        selectShop(marker);
      });

      shopMarkers.push(marker);
    });

    fetchMarkerPrices();
  }

  // Batch-fetch prices for all visible markers and add price badges
  async function fetchMarkerPrices() {
    if (!sb || shopMarkers.length === 0) return;

    var osmIds = shopMarkers.map(function (m) { return m._shopData._osmId; });

    var { data, error } = await sb
      .from('prices')
      .select('osm_id, price_regular, price_plant_milk, created_at')
      .in('osm_id', osmIds)
      .order('created_at', { ascending: false });

    if (error || !data || data.length === 0) return;

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
      marker.setIcon(createCoffeeIcon(isActive, text));
    });
  }

  function clearMarkers() {
    shopMarkers.forEach(function (m) { map.removeLayer(m); });
    shopMarkers = [];
    activeMarker = null;
  }

  // --- Select / detail ---
  function selectShop(marker) {
    if (activeMarker) {
      activeMarker.setIcon(createCoffeeIcon(false, activeMarker._priceText));
    }

    activeMarker = marker;
    marker.setIcon(createCoffeeIcon(true, marker._priceText));

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
      activeMarker.setIcon(createCoffeeIcon(false, activeMarker._priceText));
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
          invalidateCache();
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
  [$filterCafe, $filterEspresso, $filterRoastery, $filterWifi].forEach(function (cb) {
    cb.addEventListener('change', fetchCoffeeShops);
  });

  // Plant milk pref: reload prices for current shop
  $prefPlantMilk.addEventListener('change', function () {
    if (currentOsmId) loadPrices(currentOsmId);
  });

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

  // --- Start ---
  initMap();
})();
